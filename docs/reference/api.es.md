# Referencia de la API

> [English version](api.md) · El inglés y el español son pares. Ambos hermanos se publican en el mismo pull request (regla de cero desfase). Véase [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

La API HTTP es la **superficie de autoridad** de Handoff CMS. Es el único transporte que puede mover una propuesta por `proposed → approved → canonical_written → live`. La CLI y el servidor MCP son proyecciones sobre esta superficie; el SDK de adaptadores es un contrato congelado para la proyección del host. El host sigue siendo canónico: nada dentro de la API edita el repositorio canónico directamente. El beat de propagación en vivo se registra por separado mediante recibos de despliegue y nunca se confunde con la escritura canónica.

El documento legible por máquina autoritativo es [`openapi.json`](openapi.json) de este directorio. TypeScript es canónico: el documento JSON se genera de forma determinista a partir de `openApiDocument` en `packages/api/src/openapi.ts` y debe ser deep-equal con la fuente en cada cambio. No se debe editar el JSON a mano; se regenera desde la constante exportada.

## Endpoints (exactamente ocho)

Cada respuesta no 2xx es `application/problem+json` (RFC 9457). Los ocho endpoints, en el orden en que aparecen en `openApiDocument`, son:

| # | Método | Ruta | Autenticación | `Idempotency-Key` | `If-Match` | operationId |
| - | --- | --- | --- | --- | --- | --- |
| 1 | `GET` | `/v1/health` | ninguna | — | — | `getHealth` |
| 2 | `POST` | `/v1/proposals` | bearer | obligatorio | — | `createProposal` |
| 3 | `GET` | `/v1/proposals/{id}` | bearer | — | — | `getProposal` |
| 4 | `POST` | `/v1/proposals/{id}/approve` | bearer | obligatorio | obligatorio | `approveProposal` |
| 5 | `POST` | `/v1/proposals/{id}/publish` | bearer | obligatorio | obligatorio | `publishProposal` |
| 6 | `POST` | `/v1/proposals/{id}/rollback` | bearer | obligatorio | obligatorio | `rollbackProposal` |
| 7 | `POST` | `/v1/publications/{id}/deploy-receipts` | bearer | obligatorio | — | `recordDeployReceipt` |
| 8 | `POST` | `/v1/proposals/{id}/reconcile` | bearer | obligatorio | obligatorio | `reconcileProposal` |

Estos ocho endpoints son la totalidad de la superficie `/v1`; la API no registra ninguna otra ruta v1. El lint de barrido por descubrimiento analiza `packages/api/src/index.ts` y rechaza cualquier ruta registrada fuera de las ocho anteriores.

## Cabeceras de solicitud

`openapi.json` declara los siguientes componentes reutilizables:

| Cabecera | Obligatoria en | Perfil |
| --- | --- | --- |
| `Authorization` | todo endpoint excepto `GET /v1/health` | `Bearer <token>`; el token está vinculado a audiencia, a inquilino y se valida su caducidad. El verificador rechaza los algoritmos `none` y `HS*` mediante la lista permitida configurada `CMS_OIDC_ALGORITHMS`. |
| `X-Tenant-Id` | todo endpoint excepto `GET /v1/health` | UUID. La reclamación `tenantId` del token debe coincidir con el valor de la cabecera; cualquier discrepancia devuelve `E_TENANT_FORBIDDEN` (403). |
| `Idempotency-Key` | todo endpoint de escritura (filas 2, 4, 5, 6, 7, 8) | Token opaco, máximo 200 caracteres, patrón `^[A-Za-z0-9._:-]+$`. Las repeticiones con una huella distinta devuelven `E_IDEMPOTENCY_REPLAY_MISMATCH` (409); los intentos concurrentes devuelven `E_IDEMPOTENCY_IN_PROGRESS` (409). |
| `If-Match` | todo endpoint de transición de estado (filas 4, 5, 6, 8) | Versión actual esperada de la propuesta. La cabecera ausente devuelve `E_VERSION_HEADER_REQUIRED` (428); la versión desactualizada devuelve `E_OPTIMISTIC_CONCURRENCY_CONFLICT` (409). |
| `Accept-Language` | opcional en todos los endpoints | Preferencia de locale par. Si se omite, el valor predeterminado es `en`; un valor no vacío sin un rango compatible `en` o `es` devuelve `E_BAD_LOCALE` (400). |

El `Content-Type` para las solicitudes de escritura es `application/json`. Los cuerpos que no sean JSON devuelven `E_UNSUPPORTED_MEDIA_TYPE` (415); los cuerpos mayores que `CMS_QUOTA_REQUEST_BYTES_CAP` devuelven `E_PAYLOAD_TOO_LARGE` (413).

`GET /v1/health` es la única ruta que no exige `Authorization` ni `X-Tenant-Id`. Se registra primero y cortocircuita antes de cualquier otro middleware, por lo que permanece disponible incluso cuando el verificador o la base de datos son inalcanzables. Devuelve `200` con el locale par negociado, o un problema RFC 9457 `400 E_BAD_LOCALE` para una preferencia de idioma no vacía y no admitida.

## Contrato del token bearer (OIDC)

El token bearer lo verifica un `TokenVerifier` enchufable (véase `packages/api/src/auth.ts`). El host cablea una implementación real (verificación JWT, DPoP, mTLS, etc.) y la superficie de la API lo trata como función pura: se presenta la cabecera `Authorization` en crudo y se obtiene un `VerifiedToken` o se lanza. Tras la verificación, la API comprueba las siguientes reclamaciones:

| Reclamación | Condición | Código de fallo |
| --- | --- | --- |
| `aud` | la audiencia debe coincidir con la audiencia configurada de la API | `E_TOKEN_AUDIENCE_MISMATCH` (401) |
| `exp` | el tiempo actual en segundos debe ser estrictamente menor que `exp` | `E_TOKEN_EXPIRED` (401) |
| `iat` | el tiempo actual en segundos debe ser mayor o igual que `iat` | `E_TOKEN_MALFORMED` (401) |
| `actorId` | no vacío | `E_TOKEN_MALFORMED` (401) |
| `tenantId` | no vacío | `E_TOKEN_MALFORMED` (401) |
| `kind` | `human` o `service` | `E_TOKEN_MALFORMED` (401) |
| `tenantId` | debe coincidir con la cabecera `X-Tenant-Id` | `E_TENANT_FORBIDDEN` (403) |

El componente de seguridad de `openapi.json` declara un único esquema `bearerAuth`: `http`, `scheme: bearer`, `bearerFormat: JWT`, con la descripción *“Audience-bound and tenant-bound bearer token. MCP delegated sessions are valid.”* Cada ruta protegida toma `security: [{ bearerAuth: [] }]` por defecto; `GET /v1/health` lo anula con `security: []`.

El verificador **no** es el mismo verificador OIDC del lado del servidor descrito en `docs/reference/configuration.md` (la configuración `CMS_OIDC_*`). El verificador del lado del servidor reside en la fase de arranque y valida la captura del emisor OIDC subyacente y la lista permitida de algoritmos; el verificador del lado de la API es el contrato por el que pasa cada solicitud. Ambos comparten el vocabulario `ServerAuthErrorCode` para los casos de token, además de `E_UNAUTHORIZED` (401) en la superficie de la API para el fallo de búsqueda del actor.

## Respuestas de problema RFC 9457

El cuerpo de cada respuesta no 2xx es un objeto `Problem` con exactamente ocho campos obligatorios:

| Campo | Tipo | Descripción |
| --- | --- | --- |
| `type` | string | URN estable `urn:cms:problem:<scope>:<code>` |
| `title` | string | Corto, localizado |
| `status` | integer | Estado HTTP, espejado en la línea de respuesta |
| `detail` | string | Legible por personas, localizado |
| `instance` | string | La URL de la solicitud |
| `code` | string | Código de máquina estable del union cerrado |
| `locale` | string | El idioma del par resuelto (`en` o `es`) |
| `extensions` | object | Paso opaco; `errors[]` para validación por campo |

El campo `type` codifica el ámbito mediante `problemCodeScope`. `ProblemCode` tiene 58 literales distintos: las declaraciones sin deduplicar contienen 60 entradas entre core (27), storage (13) y API (20), con dos literales de autoridad compartidos por core y API. `extensions` transporta identificadores, pistas de idioma, `selfApproved`, `traceId` y `errors[]`; los datos del solicitante permanecen en `errors[]` y no se interpolan en `detail`.

La respuesta de error usa `application/problem+json`; `openapi.json` reutiliza `components.responses.Problem` en las operaciones. `POST /v1/proposals` devuelve `201` en caso de éxito. Registrar un recibo de despliegue pendiente devuelve `202`; los recibos terminales y las demás operaciones exitosas devuelven `200`.

## `API_ERROR_CODES` y la relación con `ProblemCode`

`API_ERROR_CODES` es el union cerrado de códigos de la capa HTTP que emite la superficie de la API. Se exporta desde `packages/api/src/problem.ts:38-59` y contiene exactamente **20** literales. El union es la mitad API del agregador `ProblemCode`:

```ts
// packages/api/src/problem.ts:68-69
export type ProblemCode = CoreErrorCode | StorageErrorCode | ApiErrorCode;
export type ProblemCodeScope = 'core' | 'storage' | 'api';
```

La tabla completa de los 20 códigos API (con el estado HTTP que devuelve `statusFor`):

| Código | Estado | Significado |
| --- | --- | --- |
| `E_BAD_REQUEST` | 400 | El cuerpo o los parámetros de la solicitud están mal formados. |
| `E_UNSUPPORTED_MEDIA_TYPE` | 415 | El `Content-Type` de la solicitud no se admite en este endpoint. |
| `E_PAYLOAD_TOO_LARGE` | 413 | El cuerpo de la solicitud excede el tamaño máximo configurado. |
| `E_IDEMPOTENCY_KEY_REQUIRED` | 400 | Las escrituras requieren la cabecera `Idempotency-Key`. |
| `E_IDEMPOTENCY_KEY_MALFORMED` | 400 | La cabecera `Idempotency-Key` no es un token opaco bien formado. |
| `E_IDEMPOTENCY_REPLAY_MISMATCH` | 409 | La misma `Idempotency-Key` se reutilizó con una huella de solicitud distinta. |
| `E_IDEMPOTENCY_IN_PROGRESS` | 409 | Un intento previo con esta `Idempotency-Key` sigue en curso. |
| `E_OPTIMISTIC_CONCURRENCY_CONFLICT` | 409 | La versión `If-Match` esperada está desactualizada; vuelva a leer y reintente. |
| `E_VERSION_HEADER_REQUIRED` | 428 | Este endpoint requiere la cabecera `If-Match` para la concurrencia optimista. |
| `E_UNAUTHORIZED` | 401 | La solicitud no presentó una credencial válida. |
| `E_TOKEN_MISSING` | 401 | La cabecera `Authorization` falta o está vacía. |
| `E_TOKEN_MALFORMED` | 401 | No se pudo verificar el token bearer. |
| `E_TOKEN_EXPIRED` | 401 | El token bearer está más allá de su `exp`; renueve y reintente. |
| `E_TOKEN_AUDIENCE_MISMATCH` | 401 | La audiencia del token no coincide con la audiencia de la API. |
| `E_SERVICE_APPROVAL_FORBIDDEN` | 403 | La identidad de servicio no puede aprobar, publicar ni revertir. |
| `E_MCP_APPROVAL_FORBIDDEN` | 403 | Las identidades con capacidad MCP son agentes y no pueden aprobar ni publicar. |
| `E_DELEGATION_EXPIRED` | 403 | La sesión humana que delega ha expirado; obtenga una nueva delegación. |
| `E_TENANT_HEADER_REQUIRED` | 400 | La cabecera `X-Tenant-Id` es obligatoria en cada solicitud multi-inquilino. |
| `E_TENANT_FORBIDDEN` | 403 | La identidad resuelta no está autorizada a operar sobre el inquilino solicitado. |
| `E_INTERNAL` | 500 | Ocurrió un error inesperado; el identificador de traza está en la extensión. |

Dos literales de la API también aparecen en core (`E_SERVICE_APPROVAL_FORBIDDEN`, `E_MCP_APPROVAL_FORBIDDEN`). `problemCodeScope` comprueba primero core, luego storage y después API. Por eso las declaraciones suman 60 entradas, mientras el union deduplicado `ProblemCode` contiene 58 literales distintos. Véase [`error-codes.es.md`](error-codes.es.md).

Los pares `en` y `es` contienen mensajes `title` y `detail` revisados para cada código. La ausencia de `Accept-Language` usa el valor predeterminado de protocolo explícito `en`; una cabecera no vacía sin un par compatible `en` o `es` se rechaza con `E_BAD_LOCALE` en lugar de aplicar un respaldo silencioso.

## Diagnósticos `SERVER_AUTH`

`SERVER_AUTH_ERROR_CODES` es el union diagnóstico OIDC del servidor. Comparte tres literales con la API (`E_TOKEN_MISSING`, `E_TOKEN_MALFORMED`, `E_TOKEN_EXPIRED`) y añade seis diagnósticos del verificador/JWKS. La discrepancia de audiencia usa literales distintos: `E_TOKEN_AUDIENCE_MISMATCH` en la API y `E_TOKEN_BAD_AUDIENCE` en el servidor.

| Código de auth del servidor | Cuándo se dispara | Código de la API al que mapea |
| --- | --- | --- |
| `E_TOKEN_MISSING` | Cabecera de token ausente o vacía en el servidor | `E_TOKEN_MISSING` (401) |
| `E_TOKEN_MALFORMED` | El token no se puede analizar en el servidor | `E_TOKEN_MALFORMED` (401) |
| `E_TOKEN_BAD_SIGNATURE` | La comprobación de firma del servidor falla | `E_TOKEN_MALFORMED` (401) |
| `E_TOKEN_BAD_AUDIENCE` | Discrepancia de audiencia del lado del servidor | `E_TOKEN_AUDIENCE_MISMATCH` (401) |
| `E_TOKEN_BAD_ISSUER` | Discrepancia de emisor del lado del servidor | `E_TOKEN_MALFORMED` (401) |
| `E_TOKEN_EXPIRED` | La comprobación `exp` del servidor falla | `E_TOKEN_EXPIRED` (401) |
| `E_TOKEN_NOT_YET_VALID` | La comprobación `nbf` del servidor falla | `E_TOKEN_MALFORMED` (401) |
| `E_TOKEN_BAD_ALGORITHM` | Algoritmo del servidor fuera de la lista permitida `CMS_OIDC_ALGORITHMS` | `E_TOKEN_MALFORMED` (401) |
| `E_OIDC_JWKS_UNAVAILABLE` | La captura de JWKS falla o es inalcanzable | `E_INTERNAL` (500) |

El union del lado del servidor **nunca** se emite por la superficie de la API; la superficie de la API siempre normaliza los fallos OIDC transitorios en el estado HTTP API correspondiente. Los códigos del lado de la API son los únicos que ve quien llama. Los diagnósticos del operador (pegarlos en el canal de incidentes) usan los códigos del lado del servidor porque llevan contexto de emisor, audiencia y algoritmo que la respuesta de la API omite intencionadamente.

## Puntos de contacto del ciclo de vida de la propuesta

Los ocho endpoints cubren toda la máquina de estados en el lado de la API:

| Beat | Endpoint de la API | Estado resultante de la propuesta |
| --- | --- | --- |
| Proponer | `POST /v1/proposals` | `proposed` |
| Leer | `GET /v1/proposals/{id}` | sin cambios |
| Aprobar | `POST /v1/proposals/{id}/approve` | `approved` |
| Publicar | `POST /v1/proposals/{id}/publish` | `canonical_written` |
| Revertir | `POST /v1/proposals/{id}/rollback` | `rolled_back` |
| Recibo de despliegue | `POST /v1/publications/{id}/deploy-receipts` | pendiente → `propagating`; exitoso → `live`; fallido → `canonical_written` o `deploy_failed` según el estado previo al recibo |
| Reconciliar | `POST /v1/proposals/{id}/reconcile` | `reconciled` (o `reconcile_pending`) |

`canonical_written` y `live` son beats distintos. Publicar realiza la escritura canónica; los recibos informan la propagación asíncrona. Una reversión gobernada realiza una escritura canónica compensatoria y registra el terminal de la propuesta como `rolled_back`; nunca fabrica un resultado `live`.

El esquema `Proposal.state` enumera los 16 estados persistidos que la API emite: `draft`, `proposed`, `validated`, `previewing`, `approved`, `applying`, `canonical_written`, `propagating`, `live`, `reconciled`, `apply_failed`, `deploy_pending`, `deploy_failed`, `reconcile_pending`, `rolled_back` y `refused`.

## Filtros de autorización

La API rechaza las identidades de servicio y MCP antes de que el motor de políticas se ejecute para las tres acciones que requieren una persona (`approve`, `publish`, `rollback`). Los códigos correspondientes son `E_SERVICE_APPROVAL_FORBIDDEN` y `E_MCP_APPROVAL_FORBIDDEN`. El endpoint de `Deploy receipts` exige `identity.id === adapterId` y la capacidad provisional de alcance estricto `deploy.receipt`; **no** es una autoridad de aprobación, publicación, aplicación o reversión. El endpoint de `Reconcile` exige una identidad humana vigente; la propiedad por publicación es un bloqueador de integración explícito (el esquema de almacenamiento debe crecer una columna `publication_owner_actor_id` y un hook correspondiente `IdentityResolver.loadPublicationOwner` antes de poder imponer la propiedad por publicación).

La autoaprobación se registra pero no se rechaza de forma categórica: cuando el id del actor que propone coincide con el id del actor que hace clic, `selfApproved: true` se sella en la respuesta y el motor de políticas decide si esa misma persona puede realizar la segunda transición.

## Barrido por descubrimiento

El lint de paridad de `docs/README.md` analiza `packages/api/src/index.ts` en busca de las rutas registradas y afirma que los ocho endpoints anteriores son las únicas rutas. El lint también analiza `packages/api/src/openapi.ts` en busca del `openApiDocument` exportado y afirma que:

1. Cada ruta en `openApiDocument` coincide con una ruta registrada en `index.ts`.
2. Cada ruta registrada en `index.ts` está documentada en `openApiDocument`.
3. El archivo `openapi.json` de este directorio es deep-equal con la fuente en cada cambio.

Añadir un nuevo endpoint es un cambio de contrato: la ruta, la definición OpenAPI, el contrato de operación y los documentos EN/ES deben publicarse en el mismo pull request.
