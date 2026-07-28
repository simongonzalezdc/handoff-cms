# Catálogo de códigos de error

> **Audiencia:** integradores y operadores que necesitan una lista
> estable y exhaustiva de las uniones cerradas de códigos de error
> legibles por máquina que se distribuyen en cada paquete `@cms/*`.
> Esta página está orientada a la información (referencia de
> Diátaxis). Los *arrays* en tiempo de ejecución son la fuente de
> verdad; las uniones siguientes son un espejo de
> `packages/**/src/**/*.ts` y las verifica el *lint* de paridad de
> barrido por descubrimiento descrito en
> [`docs/README.md`](../README.es.md).

> [English version](error-codes.md) · El inglés y el español son
> idiomas pares. Ambos hermanos se publican en el mismo *pull
> request* (regla de desfase cero). Véase
> [`../README.es.md#desfase-cero-enes-en-el-mismo-pr`](../README.es.md#desfase-cero-enes-en-el-mismo-pr).

## Cómo leer esta página

El CMS expone exactamente **doce** uniones cerradas de códigos de
error más el agregador derivado `ProblemCode`. Cada unión es un
literal de *array* `readonly` emparejado con un alias de tipo
unión literal de la forma `(typeof UNION)[number]`. Los *arrays* en
tiempo de ejecución se congelan con `Object.freeze`; nada los
extiende en tiempo de ejecución. Añadir un código a cualquier unión
es un cambio de contrato: los idiomas pares `en` y `es` se publican
en el mismo *pull request* y el *lint* de paridad vuelve a
ejecutarse sobre `packages/**/src/**/*.ts` para confirmar la
membresía.

Las uniones se agrupan por **frontera de paquete**, no por estado
HTTP, porque cada paquete posee su propio vocabulario de error.
Dos uniones pueden exponer la misma cadena literal cuando la misma
condición vive en dos paquetes; el catálogo registra ese solapamiento
explícitamente para que las personas que llaman puedan desambiguar
con `problemCodeScope`.

| # | Unión | Paquete | Símbolo fuente | Cuenta |
| --- | --- | --- | --- | --- |
| 1 | Núcleo | `@cms/core` | `ERROR_CODES` | 27 |
| 2 | Almacenamiento | `@cms/storage` | `StorageErrorCode` | 13 |
| 3 | API | `@cms/api` | `API_ERROR_CODES` | 20 |
| 4 | CLI | `@cms/cli` | `CliErrorCode` | 8 |
| 5 | Almacén web | `@cms/web` | `STORE_ERROR_CODES` | 21 |
| 6 | Almacén de blobs de medios | `@cms/media` | `BLOB_STORE_ERROR_CODES` | 9 |
| 7 | *Pipeline* de medios | `@cms/media` | `MEDIA_PIPELINE_ERROR_CODES` | 18 |
| 8 | Ejecución del servidor | `@cms/server` | `SERVER_ERROR_CODES` | 5 |
| 9 | Configuración del servidor | `@cms/server` | `SERVER_CONFIG_ERROR_CODES` | 5 |
| 10 | Autenticación del servidor | `@cms/server` | `SERVER_AUTH_ERROR_CODES` | 9 |
| 11 | SDK del adaptador | `@cms/adapter-sdk` | `ADAPTER_REFUSAL_CODES` | 9 |
| 12 | *Symlink* de Cerafica | `@cms/adapter-cerafica` | `SYMLINK_REFUSAL_CODES` | 7 |
| — | Agregador | `@cms/api` | `ProblemCode` | 60 |

Total de miembros de uniones cerradas: 151. La fila del agregador es
**derivada**, no es una decimotercera unión: `ProblemCode` es la
unión de las uniones Núcleo, Almacenamiento y API únicamente.

## 1. Núcleo — `ERROR_CODES` (27)

Fuente: `packages/core/src/domain.ts:86-114`.

| Código | Grupo |
| --- | --- |
| `E_BAD_TIMESTAMP` | Entradas |
| `E_BAD_HASH` | Entradas |
| `E_BAD_LOCALE` | Entradas |
| `E_BAD_PATH` | Rutas |
| `E_ABSOLUTE_PATH` | Rutas |
| `E_ESCAPING_PATH` | Rutas |
| `E_SELF_ALIAS` | Alias |
| `E_CYCLIC_ALIAS` | Alias |
| `E_AMBIGUOUS_CANONICAL` | Alias |
| `E_BAD_REGENERATION_MODE` | Alias |
| `E_EMPTY_DERIVED_ARTIFACTS` | Alias |
| `E_INVALID_IDENTITY` | Identidades |
| `E_SERVICE_APPROVAL_FORBIDDEN` | Autoridad |
| `E_MCP_APPROVAL_FORBIDDEN` | Autoridad |
| `E_SELF_APPROVAL_FORBIDDEN` | Autoridad |
| `E_INSUFFICIENT_AUTHORITY` | Autoridad |
| `E_FIELD_CAPABILITY_MISSING` | Autoridad |
| `E_ROLE_MISMATCH` | Autoridad |
| `E_CONTENT_TYPE_MISMATCH` | Autoridad |
| `E_ENVIRONMENT_MISMATCH` | Autoridad |
| `E_ACTION_FORBIDDEN` | Autoridad |
| `E_INVALID_TRANSITION` | Máquina de estados |
| `E_ROLLBACK_WINDOW_EXPIRED` | Máquina de estados |
| `E_FROZEN_VIOLATION` | Máquina de estados |
| `E_MISSING_LOCALE` | i18n |
| `E_INVALID_PROPOSAL` | Propuestas |
| `E_INVALID_REVISION` | Propuestas |

## 2. Almacenamiento — `StorageErrorCode` (13)

Fuente: `packages/storage/src/index.ts:333-346`. Localiza a través
de `@cms/i18n`; nunca compares la cadena humana de `message`.

| Código |
| --- |
| `not_found` |
| `tenant_disabled` |
| `idempotency_replay_mismatch` |
| `idempotency_in_progress` |
| `optimistic_concurrency_conflict` |
| `unique_violation` |
| `foreign_key_violation` |
| `check_violation` |
| `append_only_violation` |
| `invalid_input` |
| `transaction_aborted` |
| `connection_failed` |
| `unsupported` |

## 3. API — `API_ERROR_CODES` (20)

Fuente: `packages/api/src/problem.ts:38-59`.

| Código |
| --- |
| `E_BAD_REQUEST` |
| `E_UNSUPPORTED_MEDIA_TYPE` |
| `E_PAYLOAD_TOO_LARGE` |
| `E_IDEMPOTENCY_KEY_REQUIRED` |
| `E_IDEMPOTENCY_KEY_MALFORMED` |
| `E_IDEMPOTENCY_REPLAY_MISMATCH` |
| `E_IDEMPOTENCY_IN_PROGRESS` |
| `E_OPTIMISTIC_CONCURRENCY_CONFLICT` |
| `E_VERSION_HEADER_REQUIRED` |
| `E_UNAUTHORIZED` |
| `E_TOKEN_MISSING` |
| `E_TOKEN_MALFORMED` |
| `E_TOKEN_EXPIRED` |
| `E_TOKEN_AUDIENCE_MISMATCH` |
| `E_SERVICE_APPROVAL_FORBIDDEN` |
| `E_MCP_APPROVAL_FORBIDDEN` |
| `E_DELEGATION_EXPIRED` |
| `E_TENANT_HEADER_REQUIRED` |
| `E_TENANT_FORBIDDEN` |
| `E_INTERNAL` |

## 4. CLI — `CliErrorCode` (8)

Fuente: `packages/cli/src/index.ts:179-188`.

| Código |
| --- |
| `usage` |
| `credential_forbidden` |
| `network` |
| `problem` |
| `unexpected` |
| `conflict` |
| `not_found` |
| `validation` |

## 5. Almacén web — `STORE_ERROR_CODES` (21)

Fuente: `packages/web/src/model.ts:111-133`.

| Código |
| --- |
| `E_BAD_BLOCK_ID` |
| `E_BAD_LOCALE` |
| `E_BAD_INDEX` |
| `E_BAD_CROP` |
| `E_BAD_FOCAL` |
| `E_BAD_BYTES` |
| `E_MISSING_ALT` |
| `E_EMPTY_ALT` |
| `E_MISSING_ALT_LOCALE` |
| `E_SERVICE_APPROVAL_FORBIDDEN` |
| `E_MCP_APPROVAL_FORBIDDEN` |
| `E_NO_PROPOSAL` |
| `E_NOT_PREVIEW_READY` |
| `E_NOT_APPROVED` |
| `E_NOT_LIVE` |
| `E_API_ERROR` |
| `E_INVALID_SNAPSHOT` |
| `E_FROZEN_BLOCK` |
| `E_NOT_REVERSIBLE` |
| `E_NOT_DEPLOY_READY` |
| `E_RECONCILE_FORBIDDEN` |

## 6. Almacén de blobs de medios — `BLOB_STORE_ERROR_CODES` (9)

Fuente: `packages/media/src/blob-store.ts:244-266`.

| Código |
| --- |
| `E_INVALID_KEY` |
| `E_CROSS_TENANT` |
| `E_NOT_FOUND` |
| `E_TRAVERSAL` |
| `E_SYMLINK_ESCAPE` |
| `E_BYTES_EXCEEDED` |
| `E_NOT_IMPLEMENTED` |
| `E_BACKEND_FAILURE` |
| `E_VIDEO_WRITE_FORBIDDEN` |

## 7. *Pipeline* de medios — `MEDIA_PIPELINE_ERROR_CODES` (18)

Fuente: `packages/media/src/blob-store.ts:1226-1266`.

| Código |
| --- |
| `E_AUTH_REQUIRED` |
| `E_CROSS_TENANT` |
| `E_FILENAME_UNSAFE` |
| `E_MIME_SPOOFED` |
| `E_SIGNATURE_MISMATCH` |
| `E_BYTES_EXCEEDED` |
| `E_DECOMPRESSION_BOMB` |
| `E_MALWARE_DETECTED` |
| `E_MALWARE_SCAN_UNAVAILABLE` |
| `E_ALT_MISSING_PEER_LOCALE` |
| `E_CROP_OUT_OF_BOUNDS` |
| `E_FOCAL_OUT_OF_BOUNDS` |
| `E_ICC_ATTESTATION_MISSING` |
| `E_EXIF_ATTESTATION_MISSING` |
| `E_VIDEO_MUTATION_FORBIDDEN` |
| `E_PROCESSOR_DECODE_FAILED` |
| `E_PROCESSOR_ENCODE_FAILED` |
| `E_INVALID_INPUT` |

## 8. Ejecución del servidor — `SERVER_ERROR_CODES` (5)

Fuente: `packages/server/src/index.ts:127-134`.

| Código |
| --- |
| `E_SERVER_NOT_READY` |
| `E_SERVER_ALREADY_LISTENING` |
| `E_SERVER_QUOTA_BYTES` |
| `E_SERVER_QUOTA_RATE` |
| `E_SERVER_INTERNAL` |

## 9. Configuración del servidor — `SERVER_CONFIG_ERROR_CODES` (5)

Fuente: `packages/server/src/config.ts:23-30`.

| Código |
| --- |
| `E_CONFIG_MISSING_REQUIRED` |
| `E_CONFIG_INVALID_TYPE` |
| `E_CONFIG_OUT_OF_RANGE` |
| `E_CONFIG_INVALID_URL` |
| `E_CONFIG_INVALID_LOG_LEVEL` |

## 10. Autenticación del servidor — `SERVER_AUTH_ERROR_CODES` (9)

Fuente: `packages/server/src/auth.ts:42-52`. Nunca embebe el token
en crudo; `extensions` transporta diagnósticos redactados y sin
PII.

| Código |
| --- |
| `E_TOKEN_MISSING` |
| `E_TOKEN_MALFORMED` |
| `E_TOKEN_BAD_SIGNATURE` |
| `E_TOKEN_BAD_AUDIENCE` |
| `E_TOKEN_BAD_ISSUER` |
| `E_TOKEN_EXPIRED` |
| `E_TOKEN_NOT_YET_VALID` |
| `E_TOKEN_BAD_ALGORITHM` |
| `E_OIDC_JWKS_UNAVAILABLE` |

## 11. SDK del adaptador — `ADAPTER_REFUSAL_CODES` (9)

Fuente: `packages/adapter-sdk/src/index.ts:481-491`. Las personas
que llaman hacen *pattern matching* sobre `code`; `message` es solo
para humanos.

| Código |
| --- |
| `E_AMBIGUOUS_BINDING` |
| `E_DERIVED_WRITE_FORBIDDEN` |
| `E_ALIAS_WRITE_FORBIDDEN` |
| `E_UNSUPPORTED_CAPABILITY` |
| `E_CONTRACT_VERSION_MISMATCH` |
| `E_PROVISIONAL_OUT_OF_SCOPE` |
| `E_AUTHORITY_FORBIDDEN` |
| `E_BINDING_NOT_FOUND` |
| `E_ENVIRONMENT_MISMATCH` |

## 12. *Symlink* de Cerafica — `SYMLINK_REFUSAL_CODES` (7)

Fuente: `packages/adapter-cerafica/src/symlink.ts:50-58`.

| Código |
| --- |
| `E_ALIAS_MISSING` |
| `E_ALIAS_BROKEN` |
| `E_ALIAS_NOT_SYMLINK` |
| `E_ALIAS_RETARGETED` |
| `E_ALIAS_ESCAPING` |
| `E_ALIAS_LOOPED` |
| `E_CANONICAL_MISSING` |

## Agregador derivado `ProblemCode`

`ProblemCode` no es una decimotercera unión. Es el agregador a nivel
de tipo que el emisor de problemas de `@cms/api` usa para restringir
el código de máquina en cada cuerpo de respuesta RFC 9457.

Fuente: `packages/api/src/problem.ts:68-69`.

```ts
export type ProblemCode = CoreErrorCode | StorageErrorCode | ApiErrorCode;
export type ProblemCodeScope = 'core' | 'storage' | 'api';
```

Membresía: 27 (núcleo) + 13 (almacenamiento) + 20 (API) = **60
literales**. El agregador no incluye las uniones de CLI, almacén
web, medios, servidor ni adaptadores porque esos paquetes son
clientes descendentes o superficies alternativas de la misma API
autoritativa; traducen sus propios códigos al agregador a través de
`problemFromError`
(`packages/api/src/problem.ts:384-419`).

## Solapamiento y deduplicación

El *lint* de paridad de barrido por descubrimiento examina
`packages/**/src/**/*.ts` en busca de *arrays* en tiempo de
ejecución exportados `*_ERROR_CODES` / `*_REFUSAL_CODES` y alias
de tipo `*ErrorCode` / `*RefusalCode`. Deduce por cadena literal y
afirma que cada unión cerrada descubierta está documentada arriba.

Dos literales aparecen en más de una unión:

| Literal | Uniones | Resolución |
| --- | --- | --- |
| `E_SERVICE_APPROVAL_FORBIDDEN` | Núcleo (1), API (3) | `problemCodeScope` devuelve `'core'` primero; la unión API la vuelve a declarar para mapear estados HTTP. |
| `E_MCP_APPROVAL_FORBIDDEN` | Núcleo (1), API (3) | La misma regla de precedencia que arriba. |

`problemCodeScope` (`packages/api/src/problem.ts:88-92`) resuelve el
ámbito comprobando primero el conjunto del núcleo, luego el de
almacenamiento y finalmente recurriendo a `'api'`. La unión API
duplica los dos códigos de autoridad para que la tabla de estado
HTTP (`STATUS_FOR_API`, `packages/api/src/problem.ts:323-344`) pueda
mapearlos a 403 sin oscurecer el catálogo del núcleo. La cadena
literal es idéntica; las dos declaraciones son deduplicaciones solo
por razones de enrutamiento del catálogo.

Esta tabla limita su alcance a los literales de autoridad duplicados que
afectan a `problemCodeScope`; la comprobación de paridad derivada del código
fuente sigue siendo la autoridad sobre la membresía completa entre uniones y
falla cuando la instantánea documentada se desvía.

## Auditoría no tiene unión estable de códigos de error

`@cms/audit` publica `HostResultStatus` (`'committed' | 'skipped' | 'failed'`,
`packages/audit/src/index.ts:69`) para los veredictos de despliegue
reportados por el adaptador, pero **no** exporta una unión cerrada
de códigos de error. La auditoría no lanza errores recuperables en
tiempo de ejecución; cada sobre de auditoría o se escribe o su
intento de escritura falla en la capa de transporte, y el fallo se
reporta a través de la misma maquinaria de `StorageError` /
`ApiErrorCode` que cualquier otro fallo de almacenamiento o de API.
El verificador JWS (`packages/audit/src/jws.ts`) y el sobre
canónico (`packages/audit/src/canonical.ts`) no transportan un
vocabulario de error propio: aceptan o rechazan el sobre completo, y
la ruta de rechazo devuelve `false` en lugar de un código de
máquina.

Si una característica futura de auditoría necesita un código estable,
debe añadir una decimotercera unión, documentarla aquí y publicar
el par `en`/`es` en el mismo *pull request*.

## Cómo se mantiene sincronizado el catálogo

El *lint* de paridad de barrido por descubrimiento descrito en
[`docs/README.md`](../README.es.md) aplica tres propiedades:

1. Cada unión cerrada exportada listada arriba está presente en
   esta página.
2. Cada literal de membresía aquí es exactamente igual al *array* en
   tiempo de ejecución.
3. Ninguna unión cerrada exportada existe fuera de este catálogo.

Un cambio en cualquier *array* fuente es un cambio de documentación;
esta página se actualiza en el mismo PR. El catálogo nunca carga
códigos inventados, descripciones fabricadas ni códigos extraídos del
vocabulario de un paquete diferente. Si un código falta en esta
página, el *array* fuente está incompleto, no la documentación.
