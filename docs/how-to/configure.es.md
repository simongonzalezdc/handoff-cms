# Configurar Handoff CMS

> [English version](configure.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo pull request (regla de cero desfase). Véase [`../README.es.md#desfase-cero-enes-en-el-mismo-pr`](../README.es.md#desfase-cero-enes-en-el-mismo-pr).

Esta página documenta cada variable de entorno `CMS_*` que consume `@cms/server`. Es la compañía autorizada de [`self-host.md`](self-host.md) · [`.es`](self-host.es.md): la página de autoalojamiento indica cómo levantar la pila; esta página indica qué significa cada valor y cómo lo valida el servidor. Cada fila está fundamentada en `compose.yaml` (valores por defecto de interpolación), `Dockerfile` (valores por defecto a nivel de imagen), `.env.example` (inventario de marcadores) y `loadServerConfig` en [`packages/server/src/config.ts`](../../packages/server/src/config.ts) (reglas de análisis). La unión cerrada de códigos de error es [`SERVER_CONFIG_ERROR_CODES`](../../packages/server/src/config.ts#L22-L30).

La página también documenta la distinción operadora vs auto-hospedadora: qué variables gestiona la persona operadora de agencia mediante Compose y cuáles la persona auto-hospedadora posee además en `.env`. Nada de lo que contiene esta página se ha probado en vivo contra un daemon de Docker; consulta [Qué se verificó](#qué-se-verificó).

## Frontera de audiencia

- La **persona operadora de agencia** ejecuta la pila Compose gestionada. Posee `.env` (el inventario de secretos de marcador), el host/puerto de enlace publicado y la configuración del emisor OIDC. Las operaciones del día 2 están documentadas en [`operate.es.md`](operate.es.md).
- La **persona auto-hospedadora** ejecuta la pila completa de `compose.yaml` en un anfitrión que controla. Posee además la terminación del proxy inverso, TLS, la copia de seguridad de volúmenes y la postura documentada en [`../security/hardening.es.md`](../security/hardening.es.md).
- La **persona autora** nunca toca ningún valor de esta página; su superficie es la edición de contenido autenticada por OIDC cubierta por [`authoring.md`](authoring.md).

La matriz de abajo etiqueta la audiencia de cada variable con la marca **[operadora]** (gestionada mediante `.env`), **[compose]** (se aplica el valor por defecto de Compose) o **[imagen]** (incorporado en la imagen de ejecución; compose puede sobrescribirlo).

## SERVER_CONFIG_ERROR_CODES

El servidor es fail-closed. `loadServerConfig` lanza un `ServerConfigError` con uno de los códigos estables de la unión cerrada:

```ts
export const SERVER_CONFIG_ERROR_CODES = [
  'E_CONFIG_MISSING_REQUIRED',
  'E_CONFIG_INVALID_TYPE',
  'E_CONFIG_OUT_OF_RANGE',
  'E_CONFIG_INVALID_URL',
  'E_CONFIG_INVALID_LOG_LEVEL',
] as const;
```

El conjunto se congela al cargar el módulo. Compose captura antes los valores obligatorios ausentes mediante la sustitución `${VAR:?mensaje}`; el servidor captura los valores con formato inválido, los enteros fuera de rango, las URL no válidas, los niveles de registro no válidos y las listas `CMS_OIDC_ALGORITHMS` no válidas. Cada error lanzado lleva una bolsa `details` con el nombre de la variable ofendida; los valores secretos nunca se incorporan. La ayuda diagnóstica `describeServerConfig` censura las credenciales de la tienda de objetos de la aplicación y la contraseña de la URL de la base de datos antes de cualquier registro para operadora u operador ([`config.ts:429-456`](../../packages/server/src/config.ts#L429-L456)).

## Matriz completa de CMS_*

La matriz de abajo cubre cada valor `CMS_*` que consume el tiempo de ejecución. Los nombres de las variables coinciden literalmente con la fuente; los valores por defecto se citan desde la interpolación de `compose.yaml` y el bloque `ENV` a nivel de imagen en `Dockerfile:100-115`. Cuando difieren, se muestran ambos y se anota el valor por defecto de la imagen.

### Nodo y proceso

| Variable | Tipo | Valor por defecto (compose / imagen) | Obligatoria | Audiencia | Notas |
| --- | --- | --- | --- | --- | --- |
| `CMS_NODE_ENV` | enum: `production` \| `staging` \| `development` \| `test` | `production` / `production` | no | [compose] | Analizado por `parseNodeEnv`. Controla el nivel de detalle de registro y errores. |
| `CMS_HOSTNAME` | cadena host | `0.0.0.0` / `0.0.0.0` | no | [compose] | Host de enlace. `0.0.0.0` es el único valor por defecto documentado; no lo restrinjas sin ajustar el proxy inverso. |
| `CMS_PORT` | entero (1-65535) | `8080` / `8080` | no en Compose; obligatorio para el cargador | [operadora] | Compose inyecta su valor por defecto. Los arranques directos del servidor deben definirlo. El puerto publicado debe seguir al puerto de enlace; los desajustes producen un contenedor permanentemente insaludable (`compose.yaml:296-301`). |
| `CMS_BIND_HOST` | cadena host | `127.0.0.1` (.env.example) | no | [operadora] | Solo aparece en `.env.example`; la consume el mapeo de puerto publicado `${CMS_BIND_HOST:-127.0.0.1}:${CMS_BIND_PORT:-8080}:${CMS_PORT:-8080}`. El servidor no la analiza. |
| `CMS_BIND_PORT` | entero | `8080` (.env.example) | no | [operadora] | Solo aparece en `.env.example`; la consume el mapeo de puerto publicado. El servidor no la analiza. |
| `PORT` | entero | `${CMS_PORT:-8080}` (inyección de compose) | no | [compose] | Se exporta desde `CMS_PORT` para que el destino de la sonda de healthcheck y el puerto de escucha no puedan divergir silenciosamente. |

### URL pública

| Variable | Tipo | Valor por defecto | Obligatoria | Audiencia | Notas |
| --- | --- | --- | --- | --- | --- |
| `CMS_PUBLIC_URL` | URL | ninguno / ninguno | **sí** | [operadora] | Analizada por `parseUrl`. Se usa para construir URL absolutas que el anfitrión expone a autoras/autores y a flujos OIDC. |

### Base de datos

| Variable | Tipo | Valor por defecto | Obligatoria | Audiencia | Notas |
| --- | --- | --- | --- | --- | --- |
| `CMS_DATABASE_URL` | URL con credenciales incorporadas | ninguno | **sí** | [operadora] | Analizada por `requireString`. La contraseña incorporada debe coincidir con `CMS_POSTGRES_PASSWORD`. Se censura en `describeServerConfig`. |
| `CMS_POSTGRES_DB` | cadena | `cms` (.env.example / compose) | no | [operadora] | La consume el servicio `postgres` como `POSTGRES_DB`. |
| `CMS_POSTGRES_USER` | cadena | `cms` (.env.example / compose) | no | [operadora] | La consume el servicio `postgres` como `POSTGRES_USER` y el healthcheck. |
| `CMS_POSTGRES_PASSWORD` | cadena | ninguno | **sí** | [operadora] | La consume el servicio `postgres` como `POSTGRES_PASSWORD`. Compose rehúsa arrancar sin ella (`compose.yaml:75`). Distinta de `CMS_MINIO_ROOT_PASSWORD`. |
| `CMS_POSTGRES_INITDB_ARGS` | cadena | `--encoding=UTF-8 --locale=C` | no | [operadora] | Se reenvía a `postgres` como `POSTGRES_INITDB_ARGS`. |

### OIDC

El bloque OIDC se documenta en [`packages/server/src/config.ts#L82-L102`](../../packages/server/src/config.ts#L82-L102). El anfitrión ejecuta un emisor OIDC (Keycloak, Authentik, Cognito, etc.) y publica un endpoint JWKS. El verificador rechaza los algoritmos simétricos (`HS*`) y `none`.

| Variable | Tipo | Valor por defecto (compose / imagen) | Obligatoria | Audiencia | Notas |
| --- | --- | --- | --- | --- | --- |
| `CMS_OIDC_ISSUER` | URL | ninguno / ninguno | **sí** | [operadora] | Analizada por `requireString`. El claim `iss` esperado. |
| `CMS_OIDC_AUDIENCE` | cadena | ninguno / ninguno | **sí** | [operadora] | Analizada por `requireString`. El claim `aud` esperado. |
| `CMS_OIDC_JWKS_URL` | URL | ninguno / ninguno | **sí** | [operadora] | Analizada por `parseUrl`. De donde el verificador obtiene las claves. |
| `CMS_OIDC_ALGORITHMS` | lista separada por comas | `RS256,ES256` / `RS256,ES256` | no | [operadora] | Analizada por `parseAlgorithms`. La lista permitida es `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512`, `PS256`, `PS384`, `PS512`; cualquier otra cosa produce `E_CONFIG_INVALID_TYPE`. |
| `CMS_OIDC_JWKS_CACHE_SECONDS` | entero positivo | `300` / `300` | no | [operadora] | Analizado por `parsePositiveInt`. Vida limitada de la caché JWKS. |
| `CMS_OIDC_FETCH_TIMEOUT_MS` | entero positivo | `5000` / `5000` | no | [operadora] | Analizado por `parsePositiveInt`. Tiempo límite de obtención de JWKS / descubrimiento. |

### Tienda de objetos (compatible con S3)

El bloque de la tienda de objetos se documenta en [`packages/server/src/config.ts#L68-L80`](../../packages/server/src/config.ts#L68-L80). `minio-init` define `MINIO_BROWSER=off` y la persona usuaria de aplicación con ámbito de bucket; la aplicación nunca ve las credenciales raíz.

| Variable | Tipo | Valor por defecto (compose / imagen) | Obligatoria | Audiencia | Notas |
| --- | --- | --- | --- | --- | --- |
| `CMS_OBJECT_ENDPOINT` | URL | `http://minio:9000` / ninguno | no | [operadora] | Analizada por `parseUrl`. Endpoint compatible con S3 al que habla la aplicación. |
| `CMS_OBJECT_BUCKET` | cadena | `cms-content` (.env.example / compose) | **sí** | [operadora] | Analizada por `requireString`. Bucket privado que la aplicación lee y escribe. |
| `CMS_OBJECT_ACCESS_KEY_ID` | cadena | ninguno | **sí** | [operadora] | Analizada por `requireString`. Persona usuaria de aplicación con ámbito de bucket, creada por `minio-init`. |
| `CMS_OBJECT_SECRET_ACCESS_KEY` | cadena | ninguno | **sí** | [operadora] | Analizada por `requireString`. Distinta de `CMS_MINIO_ROOT_PASSWORD`. Se censura en `describeServerConfig`. |
| `CMS_OBJECT_REGION` | cadena | `us-east-1` / `us-east-1` | no | [operadora] | Etiqueta de región S3. |
| `CMS_OBJECT_FORCE_PATH_STYLE` | booleano | `true` / `true` | no | [operadora] | Analizado por `parseBool`. El autoalojamiento requiere direccionamiento path-style. |
| `CMS_MINIO_ROOT_USER` | cadena | `cms-root` (.env.example / compose) | **sí** (compose) | [operadora] | La consumen `minio` (`MINIO_ROOT_USER`) y `minio-init`. Nunca llega a la aplicación. |
| `CMS_MINIO_ROOT_PASSWORD` | cadena | ninguno | **sí** | [operadora] | La consumen `minio` (`MINIO_ROOT_PASSWORD`) y `minio-init`. Compose rehúsa arrancar sin ella (`compose.yaml:155`). Nunca llega a la aplicación. |

### Cuotas

Las cuotas se documentan en [`packages/server/src/config.ts#L57-L66`](../../packages/server/src/config.ts#L57-L66). Son el contrato de la persona operadora con sus usuarias y usuarios; el servidor nunca las relaja silenciosamente. Una solicitud que exceda `requestBytesCap` devuelve 413; un tenant que exceda `tenantRequestsPerMinute` devuelve 429.

| Variable | Tipo | Valor por defecto (compose / imagen) | Obligatoria | Audiencia | Notas |
| --- | --- | --- | --- | --- | --- |
| `CMS_QUOTA_REQUEST_BYTES_CAP` | entero positivo | `1048576` / `1048576` | no | [operadora] | Analizado por `parsePositiveInt`. 1 MiB por defecto. |
| `CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE` | entero positivo | `120` / `120` | no | [operadora] | Analizado por `parsePositiveInt`. Tope de tasa de solicitudes por tenant. |

### Registro e idioma

| Variable | Tipo | Valor por defecto (compose / imagen) | Obligatoria | Audiencia | Notas |
| --- | --- | --- | --- | --- | --- |
| `CMS_LOG_LEVEL` | enum: `silent` \| `error` \| `warn` \| `info` \| `debug` | `info` / `info` | no | [operadora] | Analizado por `parseLogLevel`. Los valores no válidos producen `E_CONFIG_INVALID_LOG_LEVEL`. |
| `CMS_DEFAULT_LOCALE` | cadena de locale | `en` / `en` | no | [operadora] | Analizado por `parseLocale`. El inglés y el español son los locales pares; este valor por defecto dirige la superficie de autoría cuando no se selecciona un locale explícito. |

## Reglas de análisis, por ruta de código

Cada analizador en `loadServerConfig` se corresponde con un código de `ServerConfigError`. La asignación de abajo se fundamenta en `config.ts` y es la referencia autorizada sobre qué significa cada código:

| Código | Dónde se lanza | Qué indica |
| --- | --- | --- |
| `E_CONFIG_MISSING_REQUIRED` | `requireString` | Un valor `CMS_*` obligatorio está sin definir o solo whitespace. Compose debería haberlo capturado en la sustitución `${VAR:?mensaje}`; este código solo se activa cuando se ejecuta fuera de Compose. |
| `E_CONFIG_INVALID_TYPE` | `parsePort`, `parseNonNegativeInt`, `parseAlgorithms`, `parseLocale`, `parseNodeEnv`, `parseBool` | Un valor tiene sintaxis inválida o está fuera de un conjunto literal aceptado. Algunos ejemplos son un puerto fuera de 1-65535, un entero negativo o una entrada de `CMS_OIDC_ALGORITHMS` fuera de los nueve algoritmos asimétricos permitidos. |
| `E_CONFIG_OUT_OF_RANGE` | `parsePositiveInt` | Un entero analizado es cero cuando el valor debe ser mayor que cero, incluidos los valores de cuota y tiempo de espera. |
| `E_CONFIG_INVALID_URL` | `parseUrl` | Un valor de URL no se analiza, tiene un esquema no admitido o viola otro invariante de URL. |
| `E_CONFIG_INVALID_LOG_LEVEL` | `parseLogLevel` | `CMS_LOG_LEVEL` no es uno de `silent`, `error`, `warn`, `info`, `debug`. |

El `ServerConfigError` lanzado lleva una bolsa `details` con el nombre de la variable y un mensaje censurado legible por personas. Los valores secretos nunca aparecen en el mensaje.

## .env.example como inventario de marcadores

`.env.example` en la raíz del repositorio es el inventario autorizado de marcadores. Las cadenas literales de marcador forman parte del contrato; sustituirlas es el primer acto de la persona operadora:

```text
CMS_POSTGRES_PASSWORD=replace-with-a-strong-database-password
CMS_MINIO_ROOT_PASSWORD=replace-with-a-strong-minio-root-password
CMS_OBJECT_SECRET_ACCESS_KEY=replace-with-a-distinct-strong-application-secret
```

Los tres marcadores son **distintos a propósito**. Reutilizar cualquiera de ellos entre categorías lo rechaza la frontera de seguridad aunque la gramática de sustitución de Compose lo permita:

- `CMS_POSTGRES_PASSWORD` autentica el rol `cms` frente a `postgres:5432`.
- `CMS_MINIO_ROOT_PASSWORD` autentica a la administradora / al administrador `cms-root` de MinIO; nunca llega a la aplicación.
- `CMS_OBJECT_SECRET_ACCESS_KEY` autentica a la persona usuaria de aplicación con ámbito de bucket que `minio-init` crea con la política `cms-app`.

`CMS_DATABASE_URL` incorpora `CMS_POSTGRES_PASSWORD`; cuando rotes una, rota ambas juntas para que la contraseña incorporada y la variable independiente se mantengan sincronizadas.

## Qué se verificó

Esta página se fundamenta en los archivos de código fuente citados arriba. El único comando relacionado con Docker que V1 ejecutó de verdad es de solo interpolación y no requiere un daemon en ejecución:

```sh
docker compose -f compose.yaml config --quiet
```

Ese comando valida el mapa de sustitución. No compila la imagen, no inicia el daemon ni ejercita ningún contenedor. El informe de verificación de V1 en `artifacts/g008/workspace-test-report.json` lo registra de forma explícita en su libro de limitaciones. Una compilación o ejecución en vivo respaldada por un daemon de Docker **no** forma parte de V1 y no es una afirmación de esta página.

## Dónde continuar

- Levantar la pila: [`self-host.md`](self-host.md) · [`.es`](self-host.es.md).
- Verificación del monorepo de siete comandos (superficie de operadora): [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).
- La arquitectura de la pila de alojamiento: [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md).
- La fuente cerrada de `SERVER_CONFIG_ERROR_CODES`: [`packages/server/src/config.ts:22-30`](../../packages/server/src/config.ts#L22-L30).
- El informe de verificación: `artifacts/g008/workspace-test-report.json`.