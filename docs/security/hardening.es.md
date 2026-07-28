# Endurecimiento de Handoff CMS

> **Audiencia:** personas autoalojadas y revisoras de seguridad. Esta página es la lista cerrada de comprobaciones de endurecimiento para la operadora que convierte el modelo de amenaza en [`threat-model.es.md`](threat-model.es.md) (EN: [`threat-model.md`](threat-model.md)) en configuración desplegable. Refleja `compose.yaml`, `Dockerfile`, `.env.example`, [`packages/server/src/config.ts`](../../packages/server/src/config.ts) y [`packages/server/src/index.ts`](../../packages/server/src/index.ts). Las citas primarias de OWASP aparecen en línea (consultada el 2026-07-28).

> [English version](hardening.md) · Las versiones inglesa y española son pares. Ambas se envían en el mismo *pull request*. Véase [`../README.es.md#desfase-cero-enes-en-el-mismo-pr`](../README.es.md#desfase-cero-enes-en-el-mismo-pr).

## Límite de audiencia

Tres roles operativos comparten el *Compose* pero tienen posturas distintas. Esta página es para la persona **autoalojada** que ejecuta la pila completa en un host propio; además es responsable de la terminación TLS, el proxy inverso, las instantáneas de volumen y el calendario de rotación. La operadora de agencia sólo es responsable de `.env` y está cubierta por [`../how-to/configure.es.md`](../how-to/configure.es.md) (EN: [`../how-to/configure.md`](../how-to/configure.md)). La autora nunca toca ningún valor de esta página.

## Qué es y qué no es esta página

Documenta lo que el *runtime* aplica hoy, lo que la operadora debe añadir fuera del *runtime* y las ubicaciones fuente donde cada control está anclado. No introduce controles que el sistema no pueda imponer ni promete verificación más allá de lo que registra el espacio de trabajo. Cuando un control es una incumbencia del host (proxy inverso, TLS, retención de logs), la página nombra el contrato que el *runtime* espera y deja la implementación a la operadora.

## Propiedad de secretos

| Secreto | Propietaria | Canal de entrega | Cadencia de rotación | Garantía de redacción |
| --- | --- | --- | --- | --- |
| `CMS_POSTGRES_PASSWORD` | autoalojada | `.env` administrado por la operadora (sustitución obligatoria en *Compose*) | Definida por la operadora; véase [Calendario de rotación](#calendario-de-rotación) | Incrustada en `CMS_DATABASE_URL`; ambas deben rotar a la vez. |
| `CMS_MINIO_ROOT_USER` / `CMS_MINIO_ROOT_PASSWORD` | autoalojada | `.env` administrado por la operadora; usado sólo por `minio` y `minio-init` | Definida por la operadora; véase [Calendario de rotación](#calendario-de-rotación) | Nunca llega a la aplicación; la política `cms-app` tiene ámbito de *bucket*. |
| `CMS_OBJECT_ACCESS_KEY_ID` / `CMS_OBJECT_SECRET_ACCESS_KEY` | autoalojada | `.env` administrado por la operadora; usuario de aplicación con ámbito de *bucket* creado por `minio-init` | Definida por la operadora; ligada a la rotación raíz de MinIO | Redactado en `describeServerConfig`. |
| `CMS_OIDC_ISSUER`, `CMS_OIDC_AUDIENCE`, `CMS_OIDC_JWKS_URL` | autoalojada | `.env` administrado por la operadora; consumido por el verificador | Lado del emisor; la rotación de claves respeta `CMS_OIDC_JWKS_CACHE_SECONDS` | No expuesto en registros; el verificador nunca repite el *bearer*. |
| `CMS_PUBLIC_URL` | autoalojada | `.env` administrado por la operadora | n/a (público) | Registrado sin credenciales. |
| Volúmenes de datos Postgres y MinIO | autoalojada | Ruta de instantáneas en el sistema de archivos del host | Definida por la operadora | `cms_postgres_data` y `cms_minio_data` son volúmenes nombrados. |

Reglas del canal de entrega: `.env`, `.env.*` (excepto `.env.example`), `*.pem`, `*.key`, `*.crt`, `*.p12` se excluyen del contexto de compilación Docker ([`.dockerignore`](../../.dockerignore)). Ningún valor `CMS_*` se hornea en la imagen de *runtime* ([`Dockerfile`](../../Dockerfile)). La etapa de *runtime* aplica valores por defecto no secretos mediante `ENV` y deja que *Compose* los sobrescriba en cada despliegue. `loadServerConfig` analiza cada valor y lanza `ServerConfigError` con un código cerrado de `SERVER_CONFIG_ERROR_CODES` (`E_CONFIG_MISSING_REQUIRED`, `E_CONFIG_INVALID_TYPE`, `E_CONFIG_OUT_OF_RANGE`, `E_CONFIG_INVALID_URL`, `E_CONFIG_INVALID_LOG_LEVEL`). `describeServerConfig` redacta `accessKeyId`, `secretAccessKey` y la contraseña de la URL de base de datos antes de cualquier registro operativo.

Cita: OWASP Secrets Management Cheat Sheet — <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html>

## Calendario de rotación

Handoff CMS no impone un calendario de rotación validado por el proveedor; define el contrato que el sistema honra y sobre el que la operadora actúa. El orden siguiente es la cadencia recomendada para un despliegue estable. Cada rotación es un cambio deliberado y registrado en el diario; el *runtime* falla de forma cerrada en cada paso.

1. **Instantánea de datos Postgres.** Detener `server` (*Compose* detiene a los dependientes). Tomar la instantánea de `cms_postgres_data`. Reiniciar.
2. **`CMS_POSTGRES_PASSWORD` y la contraseña incrustada en `CMS_DATABASE_URL`.** Actualizar `.env` para que la variable suelta y la URL incrustada estén sincronizadas. La sustitución obligatoria de *Compose* detecta los valores ausentes; el cargador del servidor detecta los malformados. Reiniciar `postgres`, `migrations` y luego `server`.
3. **Credenciales raíz de MinIO.** Actualizar `.env`. Volver a ejecutar `minio-init` para que la política `cms-app` se vuelva a asociar a credenciales de aplicación nuevas. Las credenciales raíz nunca llegan a la aplicación.
4. **Usuario de aplicación con ámbito de *bucket*.** Actualizar `.env`. `minio-init` reemplaza sólo a ese usuario antes de que se reinicie el servidor.
5. **Claves de firma OIDC.** Publicar la nueva clave en la URL JWKS con la clave anterior solapándose a la ventana de caché. El verificador usa `createRemoteJWKSet` con caché y *fetch* acotados.
6. **Clave de firma JWS de auditoría.** El verificador *offline* acepta la nueva clave. Los sobres existentes siguen verificándose con la clave histórica.
7. ***Tokens* portadores OIDC.** Lado del emisor; respeta la verificación de la reclamación `exp`. Sesgo de reloj acotado a 30 s.
8. **Imagen y *runtime* de Node.** Reconstruir para tomar las versiones parcheadas de `node:22.20.0-bookworm-slim` y de las dependencias.

Las respuestas cerradas del *runtime* que la operadora puede correlacionar: `E_CONFIG_MISSING_REQUIRED` (la sustitución `${VAR:?message}` de *Compose* detecta la mayoría de los valores ausentes; el cargador del servidor detecta valores malformados, enteros fuera de rango, URLs inválidas, niveles de registro inválidos y listas inválidas de `CMS_OIDC_ALGORITHMS`) y `E_OIDC_JWKS_UNAVAILABLE` (fallo de descarga de JWKS; acotado por `CMS_OIDC_FETCH_TIMEOUT_MS` y `CMS_OIDC_JWKS_CACHE_SECONDS` en el camino feliz).

## Usuario sin privilegios y eliminación de capacidades

| Control | Dónde | Qué hace el *runtime* |
| --- | --- | --- |
| **Usuario *runtime* sin raíz** | `Dockerfile` | Crea `cms:cms` (UID / GID 10001) y ejecuta la aplicación como ese usuario. El *home* es `/home/cms`; la *shell* es `/usr/sbin/nologin`. |
| **`no-new-privileges:true`** | `compose.yaml` | Aplicado a `migrations`, `minio-init` y `server`. El contenedor no puede adquirir nuevos privilegios mediante binarios `setuid` / `setgid` ni capacidades de archivo. |
| **`read_only: true`** | `compose.yaml` | Aplicado a `migrations` y `minio-init`. |
| **Montajes *scratch* `tmpfs`** | `compose.yaml` | Montajes `tmpfs` acotados para `/tmp`, `/run/postgresql` y *scratch* de *one-shot*. |
| **Recolección de PID-1** | `Dockerfile` | `tini --` es el *entrypoint*; los procesos huérfanos se recolectan. |
| **Fijación del *script* de *healthcheck*** | `Dockerfile`, [`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs) | `chmod 0555` sobre el *script*; rechaza `0.0.0.0` / `::` como anfitrión de prueba salvo que se establezca explícitamente `ALLOW_INSECURE_HTTP=1`. Falla de forma cerrada cuando `PORT` y `CMS_PORT` difieren. |

La aplicación nunca necesita `chmod`, `chown` ni mutar de otro modo el sistema de archivos de *runtime* en caliente. Cualquier control futuro que requiera mutación en su lugar es un cambio de comportamiento, no de endurecimiento, y no está en esta página.

Cita: CIS Docker Benchmark §4 (construcción de imagen) y §6 (redes); OWASP Docker Top 10.

## *Healthchecks* por *loopback*

La imagen y el *runtime* cooperan para que la `HEALTHCHECK` del contenedor y cualquier prueba del lado del host alcancen `127.0.0.1` en lugar de `0.0.0.0` u otro contenedor. El *script* [`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs) hace este contrato explícito: `HOST` por defecto es `127.0.0.1`; el *script* sale con código `2` si `ALLOW_INSECURE_HTTP` no vale `1` y el anfitrión es `0.0.0.0`, `::` o `[::]`. `PORT` y `CMS_PORT` son honrados ambos; cuando ambos están establecidos y difieren, el *script* sale con `2`. `PROBE_TIMEOUT_MS` (por defecto `3000`) y `PROBE_RETRIES` (por defecto `1`) acotan el presupuesto de la prueba. El *script* usa el `fetch` global (Node ≥ 18) para que no tenga dependencia de *npm* y sea reproducible byte a byte.

La directiva `HEALTHCHECK` de la imagen es `node /usr/local/bin/self-host-healthcheck.mjs live` con `--interval=15s`, `--timeout=5s`, `--start-period=20s`, `--retries=3`. La publicación de puertos en *Compose* `${CMS_BIND_HOST:-127.0.0.1}:${CMS_BIND_PORT:-8080}:${CMS_PORT:-8080}` obliga al puerto vinculado a seguir al puerto de vínculo de la aplicación; el *script* falla de forma cerrada si ambos difieren.

## *Endpoints* privados de *health* y métricas

Cuatro *endpoints* HTTP sin autenticar se exponen desde `@cms/server` para un orquestador del lado del host. Se montan **antes** del *middleware* de *tenant* obligatorio de la API, de modo que una prueba no autenticada nunca alcanza la ruta de autoridad. El anclaje es [`packages/server/src/index.ts`](../../packages/server/src/index.ts) · [`../reference/observability.es.md`](../reference/observability.es.md) (EN: [`../reference/observability.md`](../reference/observability.md)).

| *Endpoint* | Propósito | Requisito de red sólo operadora |
| --- | --- | --- |
| `GET /v1/health` | *Liveness* de superficie de autoridad; respuesta congelada `{ status, service, locale }` con `security: []` en OpenAPI | Vinculada al montaje de la API; el cuerpo de la petición no tiene PII. |
| `GET /health/live` | *Liveness* de Nodo; devuelve `{ status, service, version, timestamp }` con `version: "0.1.0"` | Frente sólo en la red operadora; no expuesto públicamente. |
| `GET /health/ready` | *Readiness* operadora; ejecuta las pruebas de base de datos, almacén de objetos y OIDC en paralelo bajo `Promise.all` | Frente sólo en la red operadora; no expuesto públicamente. |
| `GET /metrics` | Exposición Prometheus en texto con exactamente ocho nombres de métricas y una única etiqueta `status` | Frente sólo en la red operadora; no expuesto públicamente. |

Reglas de re-exposición: vincular en la red operadora; ninguna etiqueta filtra identificadores de *tenant* o de actor (`status` es la única dimensión — sin `tenant_id`, sin `actor_id`, sin `route`, sin `method`, sin `locale`); los encabezados se retiran antes de que la API los vea (el adaptador de Nodo retira `cookie` y `proxy-authorization`; las credenciales portadoras las valida el verificador OIDC y nunca se persisten en el evento de registro de la petición); los cuerpos no se registran (el único campo con forma de cuerpo que quien llama puede adjuntar es `bytes`, que es el `content-length` declarado para un rechazo por exceder tamaño); la prueba de *readiness* de `cms_postgres_*` hace un `SELECT` a través de la capa de almacenamiento para el *tenant* `00000000-0000-0000-0000-000000000000`. Los fallos se exponen como `503` con el literal `database unavailable` en el campo `detail`.

## `MINIO_BROWSER` desactivado

El contenedor de MinIO se configura para desactivar por completo la consola de navegador integrada: `MINIO_BROWSER: "off"` en `compose.yaml`; `--console-address :9001` es el puerto de red al que habría vinculado la consola integrada; con `MINIO_BROWSER=off` el *listener* rehúsa conexiones. `mc anonymous none` deja al *bucket* como privado. La política `cms-app` tiene listado de *bucket* y CRUD de objetos confinados a `CMS_OBJECT_BUCKET`; el usuario de aplicación no tiene permiso *wildcard* `*`, no tiene `s3:ListAllMyBuckets`, ni lectura o escritura entre *buckets*.

La aplicación de *runtime* habla al *endpoint* compatible con S3 en `CMS_OBJECT_ENDPOINT` con `CMS_OBJECT_FORCE_PATH_STYLE=true`. La configuración autoalojada usa direccionamiento *path-style*; las URLs firmadas se confinan a `CMS_OBJECT_BUCKET` solamente. **Navegar el almacén de objetos desde una consola de navegador nunca es una capacidad operadora sobre esta pila.** Las operadoras que necesiten inspeccionar *blobs* usan la AWS CLI o el cliente `mc` contra el *endpoint* con las credenciales del usuario de aplicación con ámbito de *bucket*.

## Separación de redes

El grafo de *Compose* declara exactamente dos redes. La separación es la contribución del *runtime* a la entrada §10 del modelo de amenaza; la operadora lo extiende con el cortafuegos del host.

- `cms_data` — interna, `internal: true`, `attachable: true`. Aloja `postgres`, `migrations`, `minio`, `minio-init`. El servidor se une a esta red para acceder a los datos.
- `cms_egress` — `internal: false`, `attachable: true`. Aloja sólo al servicio `server`. El servidor llega al emisor OIDC y al *endpoint* JWKS por esta red; nunca publica puertos de datos.

La publicación de puertos sobre la red operadora es `${CMS_BIND_HOST:-127.0.0.1}:${CMS_BIND_PORT:-8080}:${CMS_PORT:-8080}`. El `CMS_BIND_HOST=127.0.0.1` por defecto mantiene al puerto publicado en *loopback*; el proxy inverso de la operadora escucha en la interfaz pública y reenvía a `127.0.0.1:8080`.

Reglas operativas: no cambiar `internal: true` en `cms_data`; no publicar puertos de Postgres ni de MinIO (el bloque publicado `ports:` en `server` es la única publicación); no añadir una tercera red que conecte `cms_data` con la red del host (si una herramienta necesita acceso a los datos, se une a `cms_data` explícitamente).

## Recursos acotados de *runtime*

El archivo *Compose* coloca límites explícitos de recursos en cada servicio. Los límites son deliberadamente estrechos; mantienen acotado el radio de impacto de un contenedor desbocado y exponen la saturación como fallo de *readiness* y no como cuelgue del host.

| Servicio | Límite de CPU | Límite de memoria | Reserva de CPU | Reserva de memoria |
| --- | --- | --- | --- | --- |
| `postgres` | 1.0 | 768 MiB | 0.25 | 256 MiB |
| `minio` | 1.0 | 1024 MiB | 0.25 | 256 MiB |
| `server` | 1.0 | 1024 MiB | 0.25 | 256 MiB |

Los *one-shots* `migrations` y `minio-init` no fijan límites de recursos; son de vida corta y pasan por el valor por defecto del sistema.

## Obligaciones del lado de la operadora que el *runtime* no impone

- **Terminación TLS.** El servidor habla HTTP plano sobre el vínculo *loopback*. Terminar TLS es responsabilidad del proxy inverso; no saltarse el proxy inverso.
- **Endurecimiento del proxy inverso.** Versión de TLS, conjuntos de cifrado, HSTS, ALPN y *OCSP stapling* son incumbencias del proxy inverso.
- **Retención de logs.** El servidor escribe JSON libre de PII en `stderr`. El *shipper* de logs de la operadora es dueña de la retención, la integridad y la política de acceso.
- **Retención del sobre de auditoría.** `@cms/audit` produce sobres verificables *offline*; la operadora es dueña de las claves de verificación y de la ventana de archivo. El modelo de amenaza documenta el contrato del verificador *offline* en [`threat-model.es.md`](threat-model.es.md) (EN: [`threat-model.md`](threat-model.md)) §11.
- **Validación de instantáneas.** Restaurar `cms_postgres_data` y `cms_minio_data` es incumbencia del host; la aplicación no expone una API *in-band* de instantánea.
- **Reconocimiento externo de la operadora.** Los *endpoints* sin autenticar `/health/*` y `/metrics` están vinculados a la red operadora. El modelo de amenaza enumera las reglas de re-exposición en [`threat-model.es.md`](threat-model.es.md) (EN: [`threat-model.md`](threat-model.md)) §12.
- **Cadencia de actualización de la imagen.** Las actualizaciones de seguridad de Node 22 / Debian aguas arriba las impulsa la operadora; la operadora reconstruye la imagen cuando aplica un CVE.

## Qué se verificó

Esta página está anclada en los archivos fuente nombrados arriba. El único comando relacionado con Docker que V1 ejecutó es de sólo interpolación: `docker compose -f compose.yaml config --quiet`. Ese comando valida el mapa de sustituciones. No compila la imagen, no inicia el *daemon* ni ejercita contenedor alguno. Una compilación o ejecución de *runtime* respaldada por *daemon* Docker vivo **no** forma parte de V1 y no es una afirmación de esta página.

## Limitaciones

- **Pruebas de accesibilidad con participantes externos.** La validación externa es un objetivo planificado para v1.1 ([`../accessibility/statement.es.md`](../accessibility/statement.es.md) (EN: [`../accessibility/statement.md`](../accessibility/statement.md))).
- **Segundo adaptador independiente.** Un segundo adaptador es la barrera de conformidad de v1.1 ([`../reference/adapter-sdk.es.md`](../reference/adapter-sdk.es.md) (EN: [`../reference/adapter-sdk.md`](../reference/adapter-sdk.md))).
- **Despliegue respaldado por *daemon* Docker.** La configuración de *Compose* sólo se interpoló; no se ejecutó compilación ni tiempo de ejecución sobre un *daemon* vivo ([`../how-to/self-host.es.md`](../how-to/self-host.es.md) (EN: [`../how-to/self-host.md`](../how-to/self-host.md))).
- **Calendario de rotación validado por el proveedor.** El *runtime* aplica cachés JWKS acotadas, *timeouts* de descarga acotados y sesgo de reloj acotado; la operadora es dueña del calendario real según [Calendario de rotación](#calendario-de-rotación).

## Dónde continuar

- El modelo de amenaza — [`threat-model.es.md`](threat-model.es.md) (EN: [`threat-model.md`](threat-model.md)).
- Inicio — [`../how-to/self-host.es.md`](../how-to/self-host.es.md) (EN: [`../how-to/self-host.md`](../how-to/self-host.md)).
- Variables de configuración — [`../how-to/configure.es.md`](../how-to/configure.es.md) (EN: [`../how-to/configure.md`](../how-to/configure.md)).
- Operaciones de día 2 — [`../how-to/operate.es.md`](../how-to/operate.es.md) (EN: [`../how-to/operate.md`](../how-to/operate.md)).
- La arquitectura de la pila de alojamiento (razonamiento de red y almacenamiento) — [`../concepts/architecture.es.md`](../concepts/architecture.es.md) (EN: [`../concepts/architecture.md`](../concepts/architecture.md)).
- El modelo de frontera de contenido y autoridad humana — [`../concepts/content-boundary.es.md`](../concepts/content-boundary.es.md) (EN: [`../concepts/content-boundary.md`](../concepts/content-boundary.md)).
- La rampa del revisor — [`reviewer-on-ramp.es.md`](reviewer-on-ramp.es.md) (EN: [`reviewer-on-ramp.md`](reviewer-on-ramp.md)).
- La unión cerrada `SERVER_CONFIG_ERROR_CODES` — [`packages/server/src/config.ts`](../../packages/server/src/config.ts).
- La unión cerrada `SERVER_AUTH_ERROR_CODES` — [`packages/server/src/auth.ts`](../../packages/server/src/auth.ts).
