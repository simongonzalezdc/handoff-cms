# Operar Handoff CMS

> [English version](operate.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo pull request (regla de cero desfase). Véase [`../README.es.md#desfase-cero-enes-en-el-mismo-pr`](../README.es.md#desfase-cero-enes-en-el-mismo-pr).

Esta página es el manual de operaciones de día 2 para un stack de Handoff CMS ya puesto en marcha. Cubre las señales de tiempo de ejecución (registros JSON sin PII, `/health/live`, `/health/ready`, `/metrics`), la disciplina de instantáneas de los dos almacenes (Postgres + MinIO), el reparto de roles entre el operador de agencia y el autoalojador, y el punto de reentrada al ciclo de vida de autoridad humana. No cubre la puesta en marcha inicial — para eso, siga [`self-host.md`](self-host.md) · [`.es`](self-host.es.md) y [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md). No cubre las variables de configuración — para eso, siga [`configure.md`](configure.md) · [`.es`](configure.es.md). Las migraciones y actualizaciones de esquema viven en la página emparejada [`migrate.md`](migrate.md) · [`.es`](migrate.es.md).

Esta página está anclada en [`packages/server/src/index.ts`](../../packages/server/src/index.ts), [`packages/server/src/config.ts`](../../packages/server/src/config.ts), [`compose.yaml`](../../compose.yaml), y el script [`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs). Ninguna de las señales de tiempo de ejecución de abajo se ha observado contra un daemon de Docker en vivo; véase [Qué se verificó](#qué-se-verificó) para el alcance exacto de la evidencia V1.

## Frontera de audiencias

Handoff CMS distingue tres roles operativos. El alcance de día 2 de esta página pertenece a los roles de operador; las páginas de las otras audiencias se enlazan en lugar de duplicarse.

- El **operador de agencia** ejecuta un stack de compose gestionado en nombre de un cliente. Es dueño de `.env`, del host/puerto publicado, de la configuración del emisor OIDC, y de las operaciones de día 2. El par configurar + operar es su manual de día 1 / día 2.
- El **autoalojador** ejecuta el stack completo de `compose.yaml` en un host que le pertenece. Es dueño además de la terminación de proxy inverso y TLS, de las instantáneas y restauración de volúmenes nombrados, y del endurecimiento. El triángulo self-host + operate + migrate es su manual de día 1 / día 2.
- El **autor** nunca toca el tiempo de ejecución. Se autentica a través del emisor OIDC, edita un borrador, previsualiza y propone para revisión humana. Su superficie es la edición de contenido autenticada por OIDC cubierta por [`authoring.md`](authoring.md) · [`.es`](authoring.es.md).

El operador de agencia y el autoalojador comparten el mismo stack de compose y el mismo tiempo de ejecución de [`@cms/server`](../../packages/server/src/index.ts); solo difieren en quién es dueño del host bajo el archivo compose. Los roles nunca se mezclan en tiempo de ejecución: un operador nunca es un autor, y a un autor nunca se le da una URL de Postgres, una credencial raíz de MinIO, ni la ruta al volumen nombrado `cms_postgres_data`.

## Registros JSON estructurados sin PII

El servidor escribe un registro JSON estructurado por línea en **stderr** — nunca en stdout, nunca en un archivo del sistema de archivos del contenedor, nunca en el registro de un proxy remoto ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L163-L180)). Cada registro lleva el mismo sobre para que los colectores aguas abajo puedan ingerirlo, filtrarlo y alertar sobre él sin analizar el cuerpo. El sobre predeterminado es:

- `level` — `silent`, `debug`, `info`, `warn` o `error`.
- `timestamp` — ISO-8601 UTC.
- `host` — `os.hostname()` del contenedor.
- `service` — `@cms/server`.
- `version` — la versión del paquete en la imagen en ejecución (`0.1.0`).
- `event` — verbo corto y estable, como `request.completed`, `request.rate_limited`, `request.oversized`, `readiness.boot`, `config.loaded`, `server.listening`, `config.invalid`, `server.start_failed`.
- `traceId`, `requestId`, `method`, `path` (determinado por el servidor a partir del pathname de la URL, nunca la consulta cruda), `status`, `latencyMs`, `bytes`, `code`, `detail`, y campos de contexto adicionales.

Los registros están libres de PII por construcción:

- El adaptador de Node **elimina** los encabezados entrantes `cookie` y `proxy-authorization` antes de reenviar la solicitud a la API ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L676-L692)). El jar de cookies es por tanto invisible para todo manejador aguas abajo.
- El adaptador de Node registra `path` analizado a partir del pathname de la URL. La cadena de consulta de la URL cruda no se serializa.
- Las credenciales de portador son validadas por el verificador OIDC y nunca se persisten en el evento de registro de solicitud.
- El adaptador de Node escribe los problemas 400 / 413 / 429 / 500 como RFC 9457 `application/problem+json` con una extensión `traceId` emitida por el servidor; el cuerpo del problema lleva el locale negociado para que el cliente pueda verificar el par resuelto ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L699-L807)). Los cuerpos de problema no contienen el payload de la solicitud.
- `describeServerConfig` redacta `accessKeyId` y `secretAccessKey` como `***` y reescribe `databaseUrl` a su esquema + host + `/***` antes del registro de la persona operadora ([`packages/server/src/config.ts`](../../packages/server/src/config.ts#L429-L456)). La forma redactada facilita el diagnóstico, pero la salida copiada de un host real sigue sujeta a la política [`secrets-in-docs`](../security/secrets-in-docs.md).

Los operadores deben dimensionar su colector de registros para el vocabulario de eventos `cms_server_*` arriba. No analice el campo libre `detail` para decisiones de cumplimiento o auditoría — lea solo los campos estructurados. El campo `code` es el identificador legible por máquina estable; el campo `detail` es contexto amigable para humanos.

El nivel de registro se controla con `CMS_LOG_LEVEL` (predeterminado `info`) y se analiza con `parseLogLevel` contra la lista cerrada `silent | error | warn | info | debug` ([`packages/server/src/config.ts`](../../packages/server/src/config.ts#L249-L303)). Un valor fuera de esa lista lanza `E_CONFIG_INVALID_LOG_LEVEL` y el servidor sale antes de vincularse.

## Liveness, readiness y métricas

Tres endpoints HTTP son expuestos por `@cms/server` para un orquestador del lado del host. Se montan antes del middleware de autenticación requerido por el tenant de la API, de modo que una sonda no autenticada nunca toca la ruta de autoridad ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L404-L425)).

### `/health/live` (liveness)

`GET /health/live` devuelve `200` con un cuerpo JSON pequeño en el momento en que el servidor Node puede responder HTTP. **No** valida la base de datos, el almacén de objetos ni el emisor OIDC. Un 503 desde este endpoint significa que el propio proceso Node está atascado — reinicie el contenedor ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L404-L415)). El healthcheck de Compose del contenedor invoca el script de sonda solo de proceso:

```sh
node /usr/local/bin/self-host-healthcheck.mjs live
```

El script admite dos modos (`live` y `ready`) y rechaza `0.0.0.0` / `::` como host de sonda a menos que `ALLOW_INSECURE_HTTP=1` se establezca explícitamente en el fixture de prueba. Cuando tanto `PORT` como `CMS_PORT` están establecidos y discrepan, el script sale con `2` — el destino de la sonda y el puerto de vinculación de la aplicación deben moverse juntos ([`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs#L55-L82)). Este comportamiento cerrado evita el contenedor permanentemente no saludable que el host advirtió.

### `/health/ready` (readiness)

`GET /health/ready` ejecuta tres sondas de readiness en paralelo y devuelve `200` solo cuando las tres reportan `ok`. Cualquier sonda que falle fuerza un `503` y el operador obtiene una razón por sonda en el cuerpo de la respuesta. Las sondas son:

1. **database** — `storage.getTenantById('00000000-0000-0000-0000-000000000000')`. Un `SELECT` de ida y vuelta contra Postgres. Un fallo de conexión expone `transaction_aborted` desde la capa de almacenamiento y la sonda reporta `database unavailable` ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L834-L846)).
2. **objectStore** — `HEAD` contra `${endpoint}/${bucket}` con el `CMS_OIDC_FETCH_TIMEOUT_MS` configurado. Un `200` o `403` se trata como alcanzable. Otros estados, fallos de red y timeouts reportan cada uno su propio detalle ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L848-L863)).
3. **oidc** — `GET` contra `CMS_OIDC_JWKS_URL` con el mismo timeout de fetch. El JSON debe analizar y contener un arreglo `keys` de nivel superior; un campo `keys` vacío o ausente reporta `OIDC JWKS response invalid` ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L865-L885)).

Cada sonda de readiness no exitosa incrementa el contador Prometheus `cms_server_readiness_failures_total`. El endpoint es para el orquestador del host, **no** un monitor público: un `503` informa si el servidor debe recibir tráfico, no si está roto. Ejecuta el procedimiento de instantánea y restauración en [Disciplina de instantáneas Postgres + MinIO](#disciplina-de-instantáneas-postgres--minio) solo después de un `503` sostenido; una interrupción transitoria durante el reinicio es normal.

### `/metrics` (exposición Prometheus)

`GET /metrics` devuelve una exposición de texto Prometheus (`text/plain; version=0.0.4`). El conjunto de métricas está fijado en el ámbito del módulo ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L253-L282)):

| Métrica | Tipo | Campo |
| --- | --- | --- |
| `cms_server_uptime_seconds` | gauge | uptime desde el arranque del proceso |
| `cms_server_requests_total` | counter | cada solicitud HTTP |
| `cms_server_request_bytes_in_total` | counter | bytes del cuerpo de la solicitud |
| `cms_server_response_bytes_out_total` | counter | bytes del cuerpo de la respuesta |
| `cms_server_rate_limited_total` | counter | respuestas 429 |
| `cms_server_oversized_total` | counter | respuestas 413 |
| `cms_server_readiness_failures_total` | counter | sondas de readiness fallidas |
| `cms_server_requests_by_status_total{status="..."}` | counter | totales por estado |

`204` y otros códigos 2xx, 3xx, 4xx y 5xx comparten la misma partición de contador por estado. Un scrape Prometheus entre `15s` y `60s` es apropiado; el objeto de métricas está en memoria y se reinicia en el arranque del proceso.

El endpoint de métricas sirve los mismos datos, formato y `Content-Type` independientemente de la autenticación. El aislamiento de red es responsabilidad de la persona operadora: la red `cms_data` está marcada como `internal: true` en [`compose.yaml:30-50`](../../compose.yaml#L30-L50), mientras el servidor también se une a `cms_egress` y expone su puerto HTTP mediante el mapeo publicado. Protege `/metrics` en la frontera del host o proxy inverso; no lo expongas a internet.

## Disciplina de instantáneas Postgres + MinIO

El estado de gobernanza vive en dos almacenes. Ambos almacenes deben ser capturados juntos; un par inconsistente no puede reproducirse de forma segura.

### Qué vive dónde

- **Volumen nombrado `cms_postgres_data`** — esquema de gobernanza (`cms_storage.*`), libro de migraciones `cms_schema_migrations`, sobres de auditoría, registros de idempotencia, propuestas, aprobaciones, revisiones, publicaciones, recibos de despliegue, vinculaciones de región. El esquema completo es la migración forward-only `0001_governance.sql`; la reversión no se proporciona ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql)).
- **Volumen nombrado `cms_minio_data`** — blobs gobernados bajo `CMS_OBJECT_BUCKET`. El bucket guarda medios canónicos y derivados. Las escrituras pasan por la aplicación con la persona usuaria de ámbito de bucket; las credenciales raíz de MinIO nunca llegan a la aplicación ([`compose.yaml:184-239`](../../compose.yaml#L184-L239)). Cerafica informa un alias roto o no verificado como `E_AMBIGUOUS_BINDING`, rechaza escrituras directas al alias con `E_ALIAS_WRITE_FORBIDDEN` y rechaza escrituras derivadas o no canónicas con `E_DERIVED_WRITE_FORBIDDEN`; la validación de un segundo adaptador independiente sigue siendo una puerta de conformidad v1.1.

Los dos almacenes llevan por tanto estado complementario. Postgres tiene la **procedencia** de cada aprobación y el **sobre** de cada evento de auditoría. MinIO tiene los **bytes canónicos** de cada activo cargado y cada artefacto publicado. Perder cualquier lado rompe la reproducción.

### La cadencia de las instantáneas

La disciplina es: **instantánea de ambos, en un paso lógico, antes de cualquier paso destructivo**.

| Acción del operador | Instantánea requerida | Motivo |
| --- | --- | --- |
| Promover la imagen `cms-server:local` | sí | la puerta de migración puede ejecutarse en el primer arranque |
| Primera ejecución tras un `git pull` de `packages/storage/migrations/` | sí | los nuevos archivos SQL producen cambios de esquema |
| Promover una etiqueta de release | sí | un release puede rebobinar el cableado de compose |
| Rotar `CMS_OIDC_*`, `CMS_OBJECT_ACCESS_KEY_ID`, `CMS_OBJECT_SECRET_ACCESS_KEY` o `CMS_POSTGRES_PASSWORD` | sí | la rotación es destructiva; capture antes de rotar |
| Después de cualquier 503 en `/health/ready` que no se recupere por sí mismo en `30s` | sí | tome la instantánea antes de un diagnóstico más profundo |
| Cadencia semanal de rutina | sí | el seguro más barato |

La cadencia es intencionalmente agresiva al tomar instantáneas y conservadora al omitirlas. Los volúmenes nombrados de Postgres y MinIO juntos son menores que cualquier otra huella duradera del sistema, por lo que el costo está dominado por el ancho de banda de E/S, no por el almacenamiento.

### La frontera de la instantánea

Una instantánea debe capturar:

1. El volumen nombrado `cms_postgres_data` **en quiescencia**. Use `pg_dump --schema=cms_storage --schema=public` contra la base de datos en ejecución, O detenga el contenedor `postgres`, capture el volumen nombrado y reinicie. No mezcle métodos en el mismo par lógico de instantáneas.
2. El volumen nombrado `cms_minio_data` **en quiescencia**. Use `mc mirror cms-content /backup/cms-content` contra el bucket, O detenga el contenedor `minio`, capture el volumen nombrado y reinicie.
3. El `cms_server.env` o `.env` exacto que estaba activo cuando se tomó la instantánea. El archivo de variables de entorno no es estado durable, pero la instantánea es inutilizable sin los valores `CMS_*` coincidentes.

Las dos instantáneas deben tomarse dentro de la misma ventana lógica. Una instantánea de Postgres del lunes emparejada con una instantánea de MinIO del miércoles no es un par coherente — el sobre de auditoría referencia IDs de objetos MinIO que pueden no haber existido cuando se tomó la instantánea de Postgres, y la reproducción no es segura.

### Lo que las instantáneas NO son

- Una instantánea **no** es un sustituto de la puerta de migración. La tabla append-only `audit_events` rechaza `UPDATE` / `DELETE` / `TRUNCATE` ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql#L578-L612)), por lo que la única forma de recuperarse de un esquema corrupto es eliminar y reaprovisionar desde la instantánea. La puerta de migración es el camino adelante.
- Una instantánea **no** es lo mismo que un conjunto rotado de backups. El CMS no asume una política de retención particular; el operador elige cuántas instantáneas conservar.
- Una instantánea **no** es una licencia para saltarse la puerta de migración. Una vez que una migración se registra en `cms_schema_migrations`, la migración misma es inmutable; añadir una nueva migración es el único paso adelante legal. La frontera se describe en [`migrate.md`](migrate.md) · [`.es`](migrate.es.md).

## Operador de agencia vs. autoalojador

El tiempo de ejecución es idéntico. El reparto de roles vive completamente en quién es dueño de qué hay bajo el archivo compose.

### Operador de agencia (compose gestionado)

El operador de agencia ejecuta el stack en nombre de uno o más clientes. Es dueño de:

- `.env` (o su equivalente de gestor de secretos) en la raíz del repositorio: cada sustitución `CMS_*`.
- El host/puerto publicado: `CMS_BIND_HOST`, `CMS_BIND_PORT`, `CMS_PORT`. El puerto publicado DEBE seguir a `CMS_PORT`; una discrepancia produce un contenedor permanentemente no saludable sin señal en los registros ([`compose.yaml`](../../compose.yaml#L296-L301)).
- El emisor OIDC (o la instancia alojada a la que apunta): `CMS_OIDC_ISSUER`, `CMS_OIDC_AUDIENCE`, `CMS_OIDC_JWKS_URL`, `CMS_OIDC_ALGORITHMS`, `CMS_OIDC_JWKS_CACHE_SECONDS`, `CMS_OIDC_FETCH_TIMEOUT_MS`.
- La rotación en su propio horario: `CMS_OIDC_*`, `CMS_OBJECT_ACCESS_KEY_ID`, `CMS_OBJECT_SECRET_ACCESS_KEY`, `CMS_POSTGRES_PASSWORD`.

Nunca es dueño del host bajo el archivo compose. Lee diagnósticos de arranque redactados y aprueba despliegues. Ejecuta y monitorea el servicio `migrations` de un solo disparo y lee su salida con `docker compose run --rm migrations` ([`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt#L28-L33)).

### Autoalojador (stack completo en un host propio)

El autoalojador es dueño además de:

- El proxy inverso, la terminación TLS y el host/puerto publicado.
- Los volúmenes nombrados: `cms_postgres_data` y `cms_minio_data`. La cadencia de instantáneas, la retención y la replicación fuera del host son responsabilidad del autoalojador.
- La postura de endurecimiento: aislamiento de procesos, montajes de solo lectura donde sea posible, `no-new-privileges`, el aislamiento de red `cms_data`, la persona usuaria no root de la imagen y `security_opt` a nivel de Compose. Sigue [`../security/hardening.es.md`](../security/hardening.es.md) · [English](../security/hardening.md).
- Actualizaciones del motor y del host: Docker, el kernel del host y la rotación del endpoint JWKS público del emisor OIDC.

Los roles nunca se mezclan. El operador de agencia delega el respaldo del volumen al host; el autoalojador delega la emisión OIDC a un IdP externo. Ningún rol delega la emisión OIDC al otro.

### Lo que el autor nunca ve

El autor es un tercer rol y está operativamente fuera del alcance de esta página:

- Se autentica solo a través del emisor OIDC configurado.
- Crea propuestas / revisiones / medios a través de la API del CMS.
- Consume contenido canónico a través de adaptadores.
- **Nunca** toca Postgres, MinIO, el contenedor `server`, el archivo `.env` ni el stack de compose.

Si un autor necesita un cambio de esquema, una nueva vinculación de región, un nuevo adaptador o una nueva política de bucket, eso es un ticket de operador, no una capacidad de autor ([`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt#L65-L72)).

## Dónde encaja el día 2 en el ciclo de vida de autoridad humana

Las operaciones del día 2 siguen gobernadas. El modelo de autoridad en [`../concepts/governance-and-human-authority.es.md`](../concepts/governance-and-human-authority.es.md) · [English](../concepts/governance-and-human-authority.md) establece que aprobar, publicar y revertir son transiciones del sistema con autoridad humana, nunca autoridad del adaptador. La superficie de día 2 no permite que una persona operadora aplique un cambio en nombre de una autora ni apruebe una propuesta sin un evento de autoridad humana.

Concretamente:

- **Aprobación** es registrada por la API solo después de un evento de autorización humana actual. Las identidades estáticas de entorno, servicio, agente y MCP fallan de forma cerrada (`E_SERVICE_APPROVAL_FORBIDDEN`, `E_MCP_APPROVAL_FORBIDDEN`).
- **Publicación** escribe la revisión aprobada en la fuente canónica del host y devuelve `canonical_written`. Un recibo de despliegue fallido deja la propuesta en `canonical_written`; no inventa silenciosamente un estado `live` intermedio.
- **Reversión** es una acción de autorización humana actual y termina en `canonical_written`. La reconciliación asíncrona de despliegue converge después de la reversión, no al revés.

La puesta en marcha de Compose y las operaciones de día 2 de arriba no cruzan la frontera de autoridad. Mueven contenedores, rotan secretos, capturan instantáneas y exponen fallos — ninguno de los cuales requiere la puerta de autoridad humana.

## Qué se verificó

Las señales de tiempo de ejecución de esta página se leen directamente de los archivos fuente citados arriba. `docker compose -f compose.yaml config --quiet` fue el único comando relacionado con Docker que V1 ejecutó; validó solo la sustitución, no un daemon en vivo ([`self-host.es.md`](self-host.es.md#qué-se-verificó) · [English](self-host.md#what-was-verified)). Las pruebas de paquetes y `node --check scripts/self-host-healthcheck.mjs` cubren la capa de aplicación y la sintaxis del script, no una sonda contra un contenedor en ejecución. El informe V1 registra esta limitación en `artifacts/g008/workspace-test-report.json`.

Una compilación respaldada por un daemon Docker en vivo, un tiempo de ejecución, un scrape de registros, un scrape de `/metrics`, una instantánea de `cms_postgres_data` o un espejo de `cms_minio_data` **no** forman parte de V1 y no se afirman en esta página. Para obtener orientación de despliegue, sigue [`self-host.es.md`](self-host.es.md) · [English](self-host.md) y [`../security/hardening.es.md`](../security/hardening.es.md) · [English](../security/hardening.md). La evidencia en disco se limita a los archivos fuente citados y al informe de siete comandos referenciado desde [`quickstart.es.md`](quickstart.es.md) · [English](quickstart.md).

## Dónde continuar

- Actualizaciones de esquema y la puerta de migración: [`migrate.md`](migrate.md) · [`.es`](migrate.es.md).
- Puesta en marcha: [`self-host.md`](self-host.md) · [`.es`](self-host.es.md).
- La secuencia de verificación del monorepo de siete comandos (superficie del operador): [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).
- Cada valor `CMS_*` y su regla de análisis: [`configure.md`](configure.md) · [`.es`](configure.es.md).
- La arquitectura del stack de alojamiento (justificación de red y almacenamiento): [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md).
- La frontera de contenido y el modelo de autoridad humana: [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md).
- El informe de verificación: `artifacts/g008/workspace-test-report.json`.
- Registrador JSON libre de PII: [`packages/server/src/index.ts:163-180`](../../packages/server/src/index.ts#L163-L180).
- Sondas de readiness: [`packages/server/src/index.ts:834-885`](../../packages/server/src/index.ts#L834-L885).
- Exposición Prometheus: [`packages/server/src/index.ts:253-282`](../../packages/server/src/index.ts#L253-L282).
- DAG de dos ramas de Compose y cableado de sondas: [`compose.yaml:30-50`](../../compose.yaml#L30-L50) y [`compose.yaml:243-329`](../../compose.yaml#L243-L329).
- Contrato del script de healthcheck: [`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs).
