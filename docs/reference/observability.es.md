# Observabilidad

> **Audiencia:** operadores, integradores y revisores de seguridad.
> Esta página es la referencia cerrada de la superficie de
> observabilidad expuesta por `@cms/server` y la aplicación Hono de
> `@cms/api`: la sonda de liveness sin autenticación `/v1/health` en
> la superficie de autoridad, las sondas `/health/live` y
> `/health/ready` operadas por el servidor autoalojado, el endpoint
> Prometheus `/metrics`, y el flujo de registros JSON sin PII.
> Refleja el contrato en tiempo de ejecución en
> `packages/server/src/index.ts` y `packages/api/src/index.ts`; el
> sobre de auditoría (firmado, direccionable por contenido,
> verificable sin conexión) se documenta en la página compañera
> [`docs/reference/audit-envelope.es.md`](audit-envelope.es.md) ·
> [EN](audit-envelope.md).

> [English version](observability.md) · English and Spanish are
> peer locales. Both siblings ship in the same pull request (zero-lag
> rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## Mapa de superficies

Hay exactamente cinco superficies de observabilidad. La tabla
siguiente nombra la ruta, el paquete que la posee y el consumidor
previsto.

| Ruta | Propietario | Consumidor |
| --- | --- | --- |
| `GET /v1/health` | `@cms/api` | Sonda de liveness; la única ruta de la superficie de autoridad que evita `requestContextMiddleware` (sin encabezado `Authorization`, sin encabezado `X-Tenant-Id`). |
| `GET /health/live` | `@cms/server` | Sonda de liveness operada por el operador; devuelve `200` mientras el proceso Node esté vivo. |
| `GET /health/ready` | `@cms/server` | Sonda de readiness operada por el operador; devuelve `200` con `status: "ready"` solo cuando toda comprobación de dependencia sea `ok`, `503` con `status: "degraded"` en caso contrario. |
| `GET /metrics` | `@cms/server` | Exposición Prometheus operada por el operador (`text/plain; version=0.0.4`); exactamente ocho nombres de métrica. |
| Flujo de registros JSON por stderr | `@cms/server` | Recolector de registros del operador; JSON estructurado, sin PII por construcción. |

Las dos rutas `/health/*` y `/metrics` se registran en la aplicación
Hono del servidor **antes** del montaje de la API (`app.route('/',
apiApp)`), por lo que cortocircuitan antes de que se ejecute el
middleware de tenant + bearer de la API.

Fuente: `packages/server/src/index.ts:404-426`,
`packages/api/src/index.ts:88-96`, `packages/api/src/index.ts:145-155`.

## Contratos de salud

### `GET /v1/health` — liveness de la API

La respuesta es `200` con un cuerpo congelado con forma:

```json
{ "status": "ok", "service": "@cms/api", "locale": "en" }
```

`locale` es `"en"` o `"es"`. La ausencia de `Accept-Language` usa el valor predeterminado de protocolo documentado `en`. Una cabecera no vacía sin un par compatible se rechaza con `E_BAD_LOCALE`; nunca se convierte silenciosamente al inglés. El endpoint lleva `security: []`, por lo que los clientes no envían un token bearer.

`status` es la cadena cerrada `"ok"`. No existe el valor `"degraded"`
en esta ruta: un host degradado devuelve `200` desde el proceso de la
API independientemente del estado de la base de datos, del object
store o de OIDC.

Fuente: `packages/api/src/index.ts:145-155`,
`packages/api/src/openapi.ts:437-457`.

### `GET /health/live` — liveness del servidor

La respuesta siempre es `200` cuando el proceso Node responde HTTP:

```json
{
  "status": "alive",
  "service": "@cms/server",
  "version": "0.1.0",
  "timestamp": "<ISO-8601 UTC>"
}
```

`version` es el literal `0.1.0` desde
`packages/server/src/index.ts:410`. El endpoint no está autenticado y
está pensado para un balanceador de carga del operador o una sonda
de liveness de kubelet.

Fuente: `packages/server/src/index.ts:405-415`.

### `GET /health/ready` — readiness del servidor

La respuesta es `200` cuando cada comprobación de dependencia es
`ok`, y `503` cuando alguna no lo es:

```ts
export interface ReadinessReport {
  readonly status: 'ready' | 'degraded';
  readonly checks: Readonly<{
    readonly database: ReadinessCheck;
    readonly objectStore: ReadinessCheck;
    readonly oidc: ReadinessCheck;
  }>;
}

export interface ReadinessCheck {
  readonly ok: boolean;
  readonly detail: string;
}
```

Hay exactamente tres dependencias de readiness. Se ejecutan en
paralelo bajo `Promise.all`. El endpoint no está autenticado por
diseño (una sonda del operador no debe requerir un encabezado de
tenant ni un bearer token), pero sigue siendo operado por el
operador y vinculado a la red de confianza.

| Comprobación | Qué hace | `ok: true` cuando | `ok: false` cuando |
| --- | --- | --- | --- |
| `database` | `storage.getTenantById('00000000-0000-0000-0000-000000000000')` ejecuta un SELECT de ida y vuelta | Postgres devuelve la fila | La llamada lanza (`transaction_aborted` StorageError u otro fallo); el detalle es el literal `database unavailable` |
| `objectStore` | `HEAD <endpoint>/<bucket>` contra el endpoint S3-compatible configurado, con un `AbortSignal.timeout` desde `config.oidc.fetchTimeoutMs` | El endpoint devuelve 2xx o 403 (esperado de un sondeo de bucket público) | Cualquier respuesta que no sea 2xx/403 (el detalle incluye el código de estado) o cualquier lanzamiento de red (el detalle es `object store unavailable`) |
| `oidc` | `GET config.oidc.jwksUrl` con el mismo timeout, parseado para `Array.isArray(body.keys)` | El documento JWKS es alcanzable y estructuralmente válido | Cualquier respuesta que no sea 2xx (el detalle incluye el código de estado), fallo de parseo JSON o lanzamiento de red (el detalle es `OIDC JWKS unavailable`) |

Cuando la sonda de readiness devuelve `degraded`, el contador
`cms_server_readiness_failures_total` se incrementa en 1. La ruta de
arranque ejecuta la sonda de readiness al inicio, solo registra
(`event: readiness.boot`), y **no** bloquea el arranque por caídas
transitorias del backend.

Fuente: `packages/server/src/index.ts:82-94`,
`packages/server/src/index.ts:383-401`,
`packages/server/src/index.ts:834-885`,
`packages/server/src/index.ts:928-942`.

## Métricas — exactamente ocho nombres

El endpoint `/metrics` devuelve exposición de texto Prometheus. Hay
exactamente ocho nombres de métrica. La ruta de render es
`metricsToText(state)` en `packages/server/src/index.ts:253-282`;
esa función es la única fuente de verdad del catálogo de métricas y
debe ser la única función que cambie cuando se añade una métrica.

| # | Nombre de la métrica | Tipo | Significado |
| --- | --- | --- | --- |
| 1 | `cms_server_uptime_seconds` | gauge | `(Date.now() - state.startedAtMs) / 1000` |
| 2 | `cms_server_requests_total` | counter | Cada solicitud HTTP atendida, incrementada una vez a la entrada del adaptador Node |
| 3 | `cms_server_request_bytes_in_total` | counter | Bytes leídos de los cuerpos de solicitud (post-cap, sumados tras `readBoundedBody`) |
| 4 | `cms_server_response_bytes_out_total` | counter | Bytes escritos en los cuerpos de respuesta |
| 5 | `cms_server_rate_limited_total` | counter | Solicitudes rechazadas con `429` por el límite de tasa por origen remoto |
| 6 | `cms_server_oversized_total` | counter | Solicitudes rechazadas con `413` por el tope de tamaño de cuerpo |
| 7 | `cms_server_readiness_failures_total` | counter | Sondas de readiness que devolvieron `degraded` (alguna comprobación `ok: false`) |
| 8 | `cms_server_requests_by_status_total{status="<code>"}` | counter | Una serie de contador por código de estado HTTP, etiquetada por estado |

La serie etiquetada `cms_server_requests_by_status_total` usa una
sola etiqueta `status`; no se expone ninguna otra dimensión de
etiqueta. No hay etiqueta `tenant_id`, `actor_id`, `route`,
`method` ni `locale` — añadir una arriesgaría la cardinalidad
tipo-log y está prohibida por el catálogo cerrado de métricas.

El estado de métricas (`MetricsState` en
`packages/server/src/index.ts:229-251`) es el único almacén
autoritativo en memoria. Todas las mutaciones pasan por
`metricsStateInc` / `metricsStateAdd` /
`metricsStateIncStatus`. La mutación directa de campos fuera de esos
helpers está prohibida por convención; el cierre mantiene los ocho
contadores y el mapa de estados consistentes.

## Registros — JSON estructurado sin PII

El servidor emite un registro por llamada a `logger.log(level,
event)` a `process.stderr` como una sola línea JSON terminada en
`\n`. El registro siempre lleva `level`, `event`, `timestamp`
(ISO-8601 UTC), `host`, `service` (`@cms/server`) y `version`
(`0.1.0`). Los registros por llamada añaden campos tomados de la
interfaz `ServerLogEvent`
(`packages/server/src/index.ts:107-120`).

No hay PII en el conjunto de registros. La disciplina de redacción
está incorporada en el adaptador Node, el cargador de configuración
y el propio logger:

- **Los encabezados de solicitud se sanitizan antes de llegar a la
  API.** El helper `sanitizeHeaders` en
  `packages/server/src/index.ts:676-692` descarta los encabezados
  `cookie` y `proxy-authorization`; `cookie` portaría estado de
  sesión y `proxy-authorization` se trata como opaco.
- **Los cuerpos no se registran.** El único campo con forma de
  cuerpo que una llamada puede adjuntar es `bytes`, que es el
  `content-length` declarado para un rechazo por tamaño excesivo;
  el contenido del cuerpo nunca se serializa.
- **`describeServerConfig` redacta valores secretos.** Sustituye el usuario, la contraseña y la ruta de la URL de base de datos por `***`, elimina la consulta y sustituye `objectStore.accessKeyId` / `secretAccessKey` por `***`. La URL con credenciales solo se reconstruye para los clientes activos de Drizzle y S3, nunca para un registro.
- **Los tokens bearer nunca aparecen.** El verificador de tokens
  corre dentro de la API y devuelve la identidad verificada; el
  adaptador Node nunca lee `authorization` para registrar.
- **El historial de la sonda de salud no se conserva.** El cuerpo
  de `/v1/health` (`{ status, service, locale }`) y el cuerpo de
  `/health/ready` (`ReadinessReport`) son las únicas cargas útiles
  en esas rutas y no llevan metadatos por llamada.

Los niveles de registro son `silent`, `debug`, `info`, `warn`,
`error`, en ese orden de prioridad. El umbral de nivel es
`isLoggable(level, threshold)` en
`packages/server/src/index.ts:159-161`; `silent` cortocircuita antes
del umbral.

La forma del valor de `event` está cerrada por `ServerLogEvent`. Los
nombres de eventos esperados, en orden narrativo, son:

| Evento | Nivel | Notas |
| --- | --- | --- |
| `config.loaded` | `info` | Diagnóstico del operador (`describeServerConfig`) emitido al arrancar. |
| `readiness.boot` | `info` o `warn` | Resultado inicial de readiness; `info` cuando listo, `warn` cuando degradado. La ruta de arranque NO bloquea en esto. |
| `readiness.boot_failed` | `warn` | La readiness inicial lanzó (no "degraded"); lleva solo `detail`. |
| `server.listening` | `info` | Una vez que el listener Node se vincula. Lleva `port`, `hostname`, `traceId`. |
| `request.completed` | `info` / `warn` / `error` | Cada solicitud HTTP. Lleva `method`, `path`, `traceId`, `status`, `latencyMs`. |
| `request.oversized` | `warn` | 413 por `content-length` o por `readBoundedBody`. |
| `request.body_read_failed` | `error` | La lectura del cuerpo lanzó por motivo distinto a tamaño excesivo. |
| `request.rate_limited` | `warn` | 429 desde el límite por origen remoto. |
| `request.unhandled_error` | `error` | `app.fetch` lanzó. |
| `config.invalid` | `error` | El cargador lanzó un `ServerConfigError`; el proceso sale con código no cero. |
| `server.start_failed` | `error` | El bootstrap de alto nivel lanzó; el proceso sale con código no cero. |

El sobre de auditoría (firmado, direccionable por contenido,
verificable sin conexión) no forma parte de este flujo de registros.
Cada transición de gobernanza se persiste como un sobre JWS Ed25519
desligado a través de `@cms/audit`, lo cual se documenta en la
página [`docs/reference/audit-envelope.es.md`](audit-envelope.es.md) ·
[EN](audit-envelope.md).

## Secuencia de sondas

La secuencia de sondas recomendada para el operador es:

1. **Liveness** — `GET /health/live`. Si devuelve algo distinto de
   `200`, el proceso Node está muerto y el supervisor debe
   reiniciarlo. La ruta `/v1/health` puede sustituirla en una
   entrada pública cuando el equipo de SRE prefiera la ruta de salud
   de la superficie de autoridad.
2. **Readiness** — `GET /health/ready`. Si devuelve `503` con
   `status: "degraded"`, el proceso está vivo pero al menos una de
   las tres comprobaciones de dependencia está fallando. No
   reiniciar; investigar los detalles de `database` /
   `objectStore` / `oidc` y rutear.
3. **Métricas** — `GET /metrics`. Extraer en el intervalo estándar
   de Prometheus del operador; las ocho series de contador y la
   gauge de uptime son las únicas.
4. **Registros** — Encarar `process.stderr` (cuando se ejecuta bajo
   `node` o bajo `compose up` con `stderr: true`) al colector de
   registros del operador. Filtrar por `event` y por `level`;
   nunca ingerir cuerpos ni encabezados.

## Referencia cruzada de modos de fallo

- **Base de datos no disponible.** La comprobación `database` de
  `/health/ready` informa `ok: false`, detalle `"database
  unavailable"`, y el proceso sigue vivo. Las llamadas a la API que
  tocan filas de gobernanza devuelven problemas `503` hasta que la
  base de datos se recupere. Ninguna ruta *fail-open* cortocircuita
  el proxy ni sirve filas en caché como autoritativas.
- **Object store no disponible.** La comprobación `objectStore` de
  `/health/ready` informa `ok: false`, detalle `"object store
  unavailable"` o el código de estado. Las ingestas de la tubería
  que requieren `put` fallan cerradas; véase
  [`media-pipeline.es.md`](media-pipeline.es.md) ·
  [EN](media-pipeline.md) para la ruta exacta de cuarentena
  `E_INVALID_INPUT`.
- **OIDC JWKS no disponible.** La comprobación `oidc` de
  `/health/ready` informa `ok: false`, detalle `"OIDC JWKS
  unavailable"` o el código de estado. La verificación del token
  bearer falla cerrada; la API devuelve problemas `401` hasta que el
  endpoint JWKS vuelva a ser alcanzable.

Cada sonda de readiness fallida incrementa
`cms_server_readiness_failures_total` exactamente en 1,
independientemente de cuántas de las tres comprobaciones hayan
fallado; la métrica se activa con la bandera `ok` global, no por
comprobación.

Fuente: `packages/server/src/index.ts:383-401`,
`packages/server/src/index.ts:834-885`.

## Evidencia

- Fábrica y rutas del servidor — `packages/server/src/index.ts:331-481`
- Sonda de liveness — `packages/server/src/index.ts:404-415`
- Sonda de readiness — `packages/server/src/index.ts:416-419`
- Render de métricas — `packages/server/src/index.ts:253-282`
- Funciones de sonda — `packages/server/src/index.ts:834-885`
- Bypass de salud de la API — `packages/api/src/index.ts:88-96`,
  `packages/api/src/index.ts:145-155`
- OpenAPI `/v1/health` — `packages/api/src/openapi.ts:437-457`
- Secuencia de arranque — `packages/server/src/index.ts:891-954`
- Redacción de configuración — `packages/server/src/config.ts:429-472`
- Saneamiento de encabezados — `packages/server/src/index.ts:676-692`
- Sobre de auditoría (firmado, direccionable por contenido,
  verificable sin conexión) —
  [`docs/reference/audit-envelope.es.md`](audit-envelope.es.md) ·
  [EN](audit-envelope.md)
- Tubería de medios (cuarentena *fail-closed*, escáner no disponible
  *fail-closed*) —
  [`docs/reference/media-pipeline.es.md`](media-pipeline.es.md) ·
  [EN](media-pipeline.md)
