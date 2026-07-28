# Referencia de configuración

> [English version](configuration.md) · El inglés y el español son pares. Ambos hermanos se publican en el mismo pull request (regla de cero desfase). Véase [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

El servidor es **gestionado por el operador**. Cada valor proviene de variables de entorno con el prefijo `CMS_`. `loadServerConfig(env)` (exportada desde `packages/server/src/config.ts`) devuelve un `ServerConfig` inmutable o lanza un `ServerConfigError`. El servidor es **fail-closed**: los valores ausentes o mal formados producen un error de arranque, nunca un valor predeterminado silencioso. Los diagnósticos del operador (`describeServerConfig`) redactan los valores secretos para que el mismo error pueda pegarse en un canal de incidentes.

Hay exactamente **21** variables de entorno `CMS_*`. La matriz de abajo es exhaustiva; cualquier variable futura debe añadirse aquí en el mismo pull request que la añade al `loadServerConfig`. El lint de barrido por descubrimiento busca la cadena literal `CMS_` en `packages/server/src/config.ts` y afirma que cada variable referenciada por el cargador está documentada.

## Matriz de obligatoriedad, valores predeterminados y validación

| Variable | Obligatoria | Predeterminado | Analizador | Restricción | Código de fallo |
| --- | --- | --- | --- | --- | --- |
| `CMS_NODE_ENV` | sí | — | `parseNodeEnv` | uno de `production`, `staging`, `development`, `test` | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_TYPE` si no está en el enum |
| `CMS_PORT` | sí | — | `parsePort` | entero en `[1, 65535]`; rechaza ceros a la izquierda y cadenas no estrictamente enteras | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_TYPE` si fuera de rango o no entero |
| `CMS_HOSTNAME` | no | `0.0.0.0` | `getString` | no vacío tras `trim` | n/a (se aplica el predeterminado) |
| `CMS_PUBLIC_URL` | sí | — | `parseUrl` | `http://` o `https://`; URL analizable | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_URL` ante fallo de análisis o esquema incorrecto |
| `CMS_DATABASE_URL` | sí | — | `requireString` | no vacío tras `trim` | `E_CONFIG_MISSING_REQUIRED` si ausente |
| `CMS_OIDC_ISSUER` | sí | — | `requireString` | no vacío tras `trim` | `E_CONFIG_MISSING_REQUIRED` si ausente |
| `CMS_OIDC_AUDIENCE` | sí | — | `requireString` | no vacío tras `trim` | `E_CONFIG_MISSING_REQUIRED` si ausente |
| `CMS_OIDC_JWKS_URL` | sí | — | `parseUrl` | `http://` o `https://`; URL analizable | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_URL` ante fallo de análisis o esquema incorrecto |
| `CMS_OIDC_JWKS_CACHE_SECONDS` | sí | — | `parsePositiveInt` | entero estrictamente positivo | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_TYPE` si no entero, `E_CONFIG_OUT_OF_RANGE` si es cero |
| `CMS_OIDC_FETCH_TIMEOUT_MS` | sí | — | `parsePositiveInt` | entero estrictamente positivo | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_TYPE` si no entero, `E_CONFIG_OUT_OF_RANGE` si es cero |
| `CMS_OIDC_ALGORITHMS` | sí | — | `parseAlgorithms` | lista separada por comas con al menos un elemento, cada uno en `RS256, RS384, RS512, ES256, ES384, ES512, PS256, PS384, PS512`; duplicados eliminados; `HS*` y `none` siempre rechazados | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_TYPE` si está vacía o contiene un algoritmo no permitido |
| `CMS_OBJECT_ENDPOINT` | sí | — | `parseUrl` | `http://` o `https://`; URL analizable | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_URL` ante fallo de análisis o esquema incorrecto |
| `CMS_OBJECT_BUCKET` | sí | — | `requireString` | no vacío tras `trim` | `E_CONFIG_MISSING_REQUIRED` si ausente |
| `CMS_OBJECT_ACCESS_KEY_ID` | sí | — | `requireString` | no vacío tras `trim` | `E_CONFIG_MISSING_REQUIRED` si ausente |
| `CMS_OBJECT_SECRET_ACCESS_KEY` | sí | — | `requireString` | no vacío tras `trim` | `E_CONFIG_MISSING_REQUIRED` si ausente |
| `CMS_OBJECT_REGION` | no | `us-east-1` | `getString` | no vacío tras `trim` | n/a (se aplica el predeterminado) |
| `CMS_OBJECT_FORCE_PATH_STYLE` | no | `true` | `parseBool` | uno de `true`, `false`, `1`, `0` | `E_CONFIG_INVALID_TYPE` si no se puede analizar como esos cuatro tokens |
| `CMS_QUOTA_REQUEST_BYTES_CAP` | sí | — | `parsePositiveInt` | entero estrictamente positivo | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_TYPE` si no entero, `E_CONFIG_OUT_OF_RANGE` si es cero |
| `CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE` | sí | — | `parsePositiveInt` | entero estrictamente positivo | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_TYPE` si no entero, `E_CONFIG_OUT_OF_RANGE` si es cero |
| `CMS_LOG_LEVEL` | sí | — | `parseLogLevel` | uno de `silent`, `error`, `warn`, `info`, `debug` | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_LOG_LEVEL` si no está en el enum |
| `CMS_DEFAULT_LOCALE` | sí | — | `parseLocale` | `en` o `es` | `E_CONFIG_MISSING_REQUIRED` si ausente, `E_CONFIG_INVALID_TYPE` si no está en el enum |

Totales contados: **21** variables: **18 obligatorias** para el cargador y **3 con valor predeterminado** (`CMS_HOSTNAME=0.0.0.0`, `CMS_OBJECT_REGION=us-east-1`, `CMS_OBJECT_FORCE_PATH_STYLE=true`). Esos valores provienen de `Dockerfile` y `compose.yaml`; `.env.example` es una plantilla de infraestructura/arranque y no los define. La distribución es 1 `parsePort`, 4 `parsePositiveInt`, 3 `parseUrl`, 6 `requireString`, 1 `parseBool`, 3 analizadores de enum (`parseNodeEnv`, `parseLogLevel`, `parseLocale`), 1 `parseAlgorithms` y 2 llamadas `getString` con predeterminado. Los cinco `SERVER_CONFIG_ERROR_CODES` cubren valores obligatorios ausentes, tipos inválidos, enteros positivos fuera de rango, URL malformadas y niveles de log inválidos.

La matriz es exactamente el contrato: el cargador es puro, nunca accede a la red, nunca analiza JSON y nunca confía en que el entorno dé forma al comportamiento del servidor más allá de estos campos tipados. Añadir una variable nueva es un cambio de contrato y se publica en el mismo pull request que los documentos EN/ES.

## Superficie de cuotas

El campo `quotas` del `ServerConfig` cargado es el **único** contrato de tasa y tamaño ajustable por el operador. Son dos enteros estrictamente positivos; el servidor nunca los relaja silenciosamente y nunca los amplía.

| Campo | Variable de origen | Límite | Respuesta HTTP al excederlo |
| --- | --- | --- | --- |
| `requestBytesCap` | `CMS_QUOTA_REQUEST_BYTES_CAP` | tamaño del cuerpo por solicitud en bytes | `E_PAYLOAD_TOO_LARGE` (413) |
| `tenantRequestsPerMinute` | `CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE` | tasa de solicitudes por inquilino | `E_SERVER_QUOTA_RATE` (429) — emitido por el runtime del servidor, no por el catálogo de problemas de la API |

Los códigos de cuota del runtime (`E_SERVER_QUOTA_BYTES`, `E_SERVER_QUOTA_RATE`) viven en el union `SERVER_ERROR_CODES` y se emiten además de los códigos de problema de la API. La superficie de cuotas la gestiona el operador: cualquier cambio en cualquiera de los dos números es un cambio de contrato para los inquilinos del operador. El `CMS_QUOTA_REQUEST_BYTES_CAP` configurado es el techo que aplica la API; el cuerpo se rechaza antes de que se ejecute el manejador.

## `SERVER_CONFIG_ERROR_CODES`

La clase `ServerConfigError` lleva un código estable del union cerrado exportado desde `packages/server/src/config.ts:23-30`. El union contiene exactamente **5** literales:

| Código | Disparador | `details` redactado |
| --- | --- | --- |
| `E_CONFIG_MISSING_REQUIRED` | `requireString` o un analizador descendente detecta la variable ausente | `missing: <key>` |
| `E_CONFIG_INVALID_TYPE` | `parsePort`, `parseNonNegativeInt`, `parseBool`, `parseAlgorithms`, `parseLocale`, `parseNodeEnv` rechazan el valor | `invalid: <key>` (más `rejected: <token>` para `parseAlgorithms`, `parseLocale`, `parseNodeEnv` cuando aplica) |
| `E_CONFIG_OUT_OF_RANGE` | `parsePositiveInt` ve un cero tras un análisis entero exitoso | `invalid: <key>` |
| `E_CONFIG_INVALID_URL` | `parseUrl` no puede construir una URL o el esquema no es `http://` ni `https://` | `invalid: <key>` |
| `E_CONFIG_INVALID_LOG_LEVEL` | `parseLogLevel` no coincide con el enum cerrado | `invalid: <key>`, `rejected: <raw>` |

La bolsa `details` es segura para el operador: nunca embebe el valor secreto en sí, solo la clave que falló al analizarse. El mensaje de error nombra de la misma forma la clave y la restricción, nunca el valor. Esto es lo que `startSelfHostedServer` emite en el arranque para que el operador pueda pegarlo en un canal de incidentes sin filtrar credenciales. Los campos que llevan secreto (`CMS_OIDC_*` secretos, `CMS_OBJECT_ACCESS_KEY_ID`, `CMS_OBJECT_SECRET_ACCESS_KEY`, `CMS_DATABASE_URL`) se redactan en `describeServerConfig`: `accessKeyId` y `secretAccessKey` se sustituyen por `***`, y la URL de la base de datos se reduce a `<esquema>://***:***@<host>/***` (esquema y host se conservan, credenciales y cola de la ruta se eliminan).

## Análisis de URL

`parseUrl` es el único analizador de URL que usa el cargador. Acepta solo los esquemas `http://` y `https://`. Cualquier otro esquema (`file:`, `ftp:`, `data:`, etc.) devuelve `E_CONFIG_INVALID_URL`. El `pathname`, `search` y `hash` de la URL se conservan verbatim; el cargador no los normaliza ni los recorta. La URL analizada se vuelve a serializar como `string` mediante `parsed.toString()`, por lo que el `string` devuelto es la forma canónica de la entrada.

La usan tres variables: `CMS_PUBLIC_URL`, `CMS_OIDC_JWKS_URL`, `CMS_OBJECT_ENDPOINT`. El emisor OIDC (`CMS_OIDC_ISSUER`) y la audiencia (`CMS_OIDC_AUDIENCE`) se aceptan como cadenas opacas; la comprobación de discrepancia del emisor sucede más adelante en la ruta de autenticación, no en la carga de configuración.

## Análisis de booleanos

`parseBool` acepta exactamente cuatro tokens: `true`, `false`, `1`, `0`. Cualquier otro valor — incluyendo `yes`, `on`, `True`, `TRUE` o cadenas vacías — devuelve `E_CONFIG_INVALID_TYPE`. El valor predeterminado se aplica cuando la variable está ausente (solo `CMS_OBJECT_FORCE_PATH_STYLE` sigue este camino; el valor predeterminado es `true`). Otros booleanos en el cargador se derivan de enums de cadenas (la lista permitida `CMS_OIDC_ALGORITHMS`, el enum `CMS_LOG_LEVEL`) y nunca pasan por `parseBool`.

## Análisis de enteros

Tres analizadores de enteros cubren la superficie entera:

| Analizador | Acotado por | Lo usa |
| --- | --- | --- |
| `parsePort` | `[1, 65535]`, rechaza ceros a la izquierda y cadenas no estrictamente enteras | `CMS_PORT` |
| `parseNonNegativeInt` | `>= 0`, rechaza ceros a la izquierda y cadenas no estrictamente enteras | (helper interno) |
| `parsePositiveInt` | `> 0`, delega en `parseNonNegativeInt` y luego rechaza `0` | `CMS_OIDC_JWKS_CACHE_SECONDS`, `CMS_OIDC_FETCH_TIMEOUT_MS`, `CMS_QUOTA_REQUEST_BYTES_CAP`, `CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE` |

El espacio en blanco alrededor del entero se conserva; el analizador no recorta. `" 100 "` y `"00100"` se rechazan porque su representación decimal analizada no coincide con la cadena en crudo; `"100"` se acepta. El contrato entero estricto es para la persona operadora: cualquier espacio o relleno inesperado es una mala configuración, no una tolerancia.

## Lista permitida de algoritmos

`CMS_OIDC_ALGORITHMS` es la única variable que admite una lista separada por comas. Los tokens se trimean; los tokens vacíos se descartan. La lista debe contener al menos un elemento; la lista vacía devuelve `E_CONFIG_INVALID_TYPE`. Cada token debe ser miembro de `ALLOWED_ALGORITHMS`:

| Familia | Miembros |
| --- | --- |
| RS (RSA) | `RS256`, `RS384`, `RS512` |
| ES (ECDSA) | `ES256`, `ES384`, `ES512` |
| PS (RSA-PSS) | `PS256`, `PS384`, `PS512` |

`HS*` (simétrico) y `none` **nunca** se aceptan. El arreglo devuelto se deduplica y se congela como `readonly AllowedAlgorithm[]`. El mismo arreglo lo aplica después el verificador de tokens por solicitud: cualquier token cuya cabecera `alg` quede fuera de esta lista devuelve `E_TOKEN_BAD_ALGORITHM` (servidor) → `E_TOKEN_MALFORMED` (API).

## Enums de nivel de log e idioma

`CMS_LOG_LEVEL` acepta exactamente `silent`, `error`, `warn`, `info`, `debug`. La cadena vacía se rechaza mediante `requireString` en el nivel superior. `CMS_DEFAULT_LOCALE` acepta exactamente `en` o `es`. No hay un tercer idioma; el catálogo de problemas de la API declara `PROBLEM_LOCALES = ['en', 'es']` y `CMS_DEFAULT_LOCALE` debe estar alineado con ese conjunto. El modo de fallo de `parseLocale` es `E_CONFIG_INVALID_TYPE`, no `E_CONFIG_INVALID_LOG_LEVEL`, aun cuando ambos son enums cerrados.

## Resumen de diagnóstico del operador

`describeServerConfig(config)` devuelve un objeto congelado que se puede pegar en un canal de incidentes. La política de redacción es:

| Campo | Forma redactada |
| --- | --- |
| `accessKeyId` | `***` |
| `secretAccessKey` | `***` |
| `databaseUrl` | esquema + `://***:***@<host>/***` (search y cola de la ruta eliminados) |
| Campos de clave privada de auditoría | no expuestos (la configuración del servidor no los lleva) |
| Resto de campos | pasados verbatim |

El resumen de diagnóstico es exactamente lo que `startSelfHostedServer` emite en el arranque. No es sustituto del `ServerConfig` cargado; el `ServerConfig` inmutable del cargador es el único objeto que ve la superficie de la API.

## Pureza del cargador

`loadServerConfig(env)` es una función pura: recibe un `EnvSource` (un `Readonly<Record<string, string | undefined>>`) y devuelve un `ServerConfig` congelado o lanza un `ServerConfigError`. No realiza I/O, no resuelve referencias de entorno en tiempo de ejecución y nunca lanza por valores “opcionales ausentes” — solo por valores obligatorios ausentes o mal formados. Los diagnósticos del operador ante error nunca incluyen los valores secretos en sí; solo mencionan qué clave falló al analizarse. El cargador es el único punto de entrada sancionado para `ServerConfig` en la base de código; ningún otro módulo puede analizar valores `CMS_*` directamente.

## Barrido por descubrimiento

El lint de paridad de `docs/README.md` busca la cadena literal `CMS_` en `packages/server/src/config.ts` y afirma que:

1. Cada token `CMS_*` referenciado por el cargador está documentado en la matriz de arriba.
2. Cada variable de la matriz está referenciada por el cargador.
3. Cada entrada del union `SERVER_CONFIG_ERROR_CODES` está documentada en la tabla de arriba.
4. Las claves de la bolsa `details` (`missing`, `invalid`, `rejected`) coinciden con las claves que el cargador realmente emite.

Añadir una nueva variable `CMS_*`, una nueva cuota o un nuevo literal de `SERVER_CONFIG_ERROR_CODES` es un cambio de contrato y debe publicarse en el mismo pull request que los documentos EN/ES.
