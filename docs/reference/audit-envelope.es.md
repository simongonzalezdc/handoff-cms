# Sobre de auditoría

> **Audiencia:** integradores y revisores de seguridad que necesitan
> el contrato cerrado del sobre de auditoría a prueba de
> manipulación producido por `@cms/audit` y la garantía de solo
> añadir de la capa de almacenamiento que lo ancla. Esta página es
> de carácter informativo (referencia Diátaxis). Refleja línea por
> línea `packages/audit/src/canonical.ts`, `packages/audit/src/jws.ts`
> y `packages/audit/src/index.ts`, junto con los disparadores de
> `cms_storage.audit_events` en
> `packages/storage/migrations/0001_governance.sql`.

> [English version](audit-envelope.md) · El inglés y el español son
> idiomas pares. Ambos hermanos se publican en el mismo *pull request*
> (regla de desfase cero). Véase
> [`../README.es.md#desfase-cero-enes-en-el-mismo-pr`](../README.es.md#desfase-cero-enes-en-el-mismo-pr).

## Qué es `@cms/audit`

`@cms/audit` es el paquete que produce un sobre de auditoría
inmutable y verificable sin conexión para cada acción de gobernanza.
El sobre tiene tres capas:

1. **Bytes canónicos** de la forma del evento, producidos por un
   serializador determinista con un conjunto cerrado de valores
   admitidos.
2. **JWS Ed25519 detached** sobre esos bytes canónicos, con la clave
   de firmado identificada por un `kid` llevado en la cabecera
   protegida.
3. **Un *hash* de evento persistido** que es la clave primaria de la
   tabla `cms_storage.audit_events` y es forzado a solo añadir por
   disparadores de Postgres.

El paquete **no** es un transporte. Acepta eventos ya construidos, los
serializa, los firma y los verifica. Un fallo al escribir el sobre
aparece a través de la misma maquinaria de `StorageError` /
`ApiErrorCode` que cualquier otro fallo de almacenamiento o de API;
`@cms/audit` no transporta su propio vocabulario de error. Véase
[`error-codes.es.md`](error-codes.es.md#auditoría-no-tiene-unión-estable-de-códigos-de-error)
para el catálogo de uniones cerradas y la omisión explícita de
auditoría.

## Bytes canónicos

El serializador canónico vive en `packages/audit/src/canonical.ts`.

| Regla | Línea fuente |
| --- | --- |
| Claves de objeto ordenadas lexicográficamente por unidad de código UTF-16 | `canonical.ts:5`, `canonical.ts:113` |
| Los *arrays* preservan el orden | `canonical.ts:6`, `canonical.ts:105-110` |
| Conjunto cerrado de valores: números finitos, cadenas no vacías, booleanos, `null`, *arrays*, objetos planos | `canonical.ts:7-13`, `canonical.ts:43-87` |
| `NaN` y `±Infinity` rechazados antes de codificar y vueltos a revisar en la cadena resultante | `canonical.ts:14`, `canonical.ts:53-58`, `canonical.ts:95-103` |
| `BigInt`, `Symbol`, `function`, `undefined`, `Date`, `Map`, `Set` y objetos cuyo prototipo no es `Object.prototype` rechazados | `canonical.ts:15-16`, `canonical.ts:50-69`, `canonical.ts:74-83` |
| La salida es la codificación UTF-8 de un valor JSON, sin salto de línea final | `canonical.ts:18`, `canonical.ts:124-128` |
| El renderizado numérico usa la forma decimal más corta con redondeo de `JSON.stringify` en Node 22; cualquier cambio requiere reauditar el ámbito | `canonical.ts:20-27` |
| `canonicalNDJSON` une eventos con un único byte `0x0a` y sin salto de línea final | `canonical.ts:130-154` |
| `contentHash` es SHA-256 en hexadecimal en minúsculas sobre los bytes canónicos, calculado una sola vez | `canonical.ts:28-31`, `canonical.ts:156-163` |

`assertSupported` y `canonicalJSON` recorren juntas el árbol de
valores para que las formas no admitidas nunca lleguen al codificador.
El conjunto cerrado es el único contrato; un valor que pasa
`canonicalize` resulta bit a bit idéntico entre procesos para la misma
entrada.

## JWS Ed25519 detached

El JWS detached vive en `packages/audit/src/jws.ts`. Tiene forma
RFC 7515 con carga útil sin codificar de RFC 7797 (`b64: false`) y
Ed25519 de RFC 8037.

| Campo de cabecera | Valor | Fuente |
| --- | --- | --- |
| `alg` | `EdDSA` (literal; cualquier otro se rechaza) | `jws.ts:35`, `jws.ts:215-216` |
| `kid` | cadena UTF-8 opaca desde `SignOptions.kid` | `jws.ts:41-43`, `jws.ts:73-84`, `jws.ts:218-220` |
| `crit` | `["b64"]` (exacto, incluido el orden) | `jws.ts:36`, `jws.ts:222-227` |
| `b64` | literal `false` | `jws.ts:43`, `jws.ts:228-230` |
| Parámetros de cabecera desconocidos | rechazados | `jws.ts:211-213` |

La entrada de firmado es `BASE64URL(cabecera_protegida) || "." ||
bytes_de_carga`, donde `bytes_de_carga` son los bytes canónicos de
`canonicalize`. El objeto JWS almacena:

- `protected`: base64url (sin relleno) de la cabecera protegida
  codificada en JSON.
- `signature`: base64url (sin relleno) de la firma Ed25519 de 64
  bytes.

`generateEd25519KeyPair(kid)` produce una clave privada PEM PKCS#8 y
una clave pública PEM SPKI. Cualquier `asymmetricKeyType` distinto de
`'ed25519'` se rechaza tanto en `signDetached` como en `verifyDetached`.

## Forma del sobre

El sobre `AuditEvent` es la forma cerrada que se firma.

| Campo | Tipo | Requerido | Notas |
| --- | --- | --- | --- |
| `v` | `1` | sí | Versión de esquema, siempre literal `1`. |
| `proposalHash` | hexadecimal en minúsculas de 64 caracteres | sí | DEBE coincidir con `contentHash(event.proposal)`. La discrepancia es un `AuditError` duro. |
| `tenant` | *slug* en minúsculas | sí | `^[a-z0-9][a-z0-9._-]{0,63}$`. |
| `actor` | identificador en minúsculas | sí | `^[a-z0-9][a-z0-9._:-]{0,127}$`. |
| `delegatedHuman` | identificador de cadena | opcional | Se omite por completo de los bytes canónicos cuando está ausente. Con `selfApproved: true`, debe estar ausente. |
| `proposal` | objeto | sí | `{ ref, title, fields }` donde `fields` se canonicaliza. |
| `approval` | objeto | sí | `{ approver, at, note? }`. `at` es segundos Unix. |
| `selfApproved` | booleano | sí | Con `true`, `approval.approver === actor` y sin `delegatedHuman`. |
| `hostResult` | objeto | sí | `{ status, artifactHash, artifactRef }`. |
| `deployResult` | objeto | sí | `{ status, at, rolledBackFrom? }`. |
| `rollbackLineage` | *array* de `{ id, reason }` | sí | Un *array* vacío es válido. Cada `id` es hexadecimal de 64 caracteres. |

Fuente: `packages/audit/src/index.ts:53-129`.

### `HostResultStatus` (enum de estado de evento)

El resultado declarado por el host usa un enum cerrado de tres
valores:

```ts
export type HostResultStatus = 'committed' | 'skipped' | 'failed';
```

Fuente: `packages/audit/src/index.ts:69`.

### `DeployResult.status` (enum de estado de evento)

El paso de despliegue usa una propiedad cerrada de tres valores definida directamente en `DeployResult`:

```ts
interface DeployResult {
  status: 'deployed' | 'rolled-back' | 'noop';
}
```

Fuente: `packages/audit/src/index.ts:91-98`. No existe un tipo `DeployResultStatus` exportado por separado.

Los dos conjuntos cerrados de estado anteriores son los únicos valores de estado de
evento emitidos por `@cms/audit`. Son valores de estado, no
códigos de error. No existe un campo `errorMessage` ni `errorCode`
correspondiente en el sobre; un resultado de host `failed` es la
propia afirmación del host de que el intento de escritura canónica no
se cometió, y el resto del registro de auditoría sigue firmado.

## Flujo de firma

| Paso | Función | Fuente |
| --- | --- | --- |
| Calcular bytes canónicos e identificador de evento | `canonicalizeEvent(event)` devuelve `{ id, bytes }` | `index.ts:315-320` |
| Firmar los bytes canónicos | `signDetached(bytes, privateKeyPem, { kid })` devuelve `{ protected, signature }` | `jws.ts:116-147` |
| Envolver un sobre firmado | `signEvent(event, privateKeyPem, kid)` devuelve `{ event, eventId, signature }` | `index.ts:346-354` |
| Copia profunda de un evento validado | `buildEvent(input)` devuelve un `structuredClone` | `index.ts:333-336` |
| Recalcular bytes canónicos de una entrada | `canonicalizeEvent` ejecuta antes `validateAuditEvent` | `index.ts:315-320` |

`signEvent` firma los bytes canónicos derivados de la forma del evento,
no una serialización JSON en tiempo de ejecución. El `eventId` es
`contentHash(event)` en hexadecimal en minúsculas (64 caracteres), y los
bytes canónicos que lo produjeron son los bytes exactos que entran en
la entrada de firmado JWS.

## Flujo de verificación

`verifyEnvelope(envelope, publicKeyPem)` devuelve un `boolean`. Nunca
lanza excepciones por un sobre malformado. El contrato es:

| Condición | Resultado |
| --- | --- |
| `envelope` no es un objeto | `false` |
| `validateAuditEvent(envelope.event)` lanza `AuditError` / `CanonicalError` / `JwsError` | `false` |
| `eventId` (recalculado de los bytes canónicos) no coincide con `envelope.eventId` | `false` |
| `proposalHash` no coincide con `contentHash(event.proposal)` | `false` (lanzado por `validateAuditEvent`) |
| La cabecera protegida no parsea, tiene parámetros desconocidos, `alg !== 'EdDSA'`, `b64 !== false`, o `crit` no es exactamente `["b64"]` | `false` |
| El JWS detached sobre los bytes canónicos no verifica con la clave pública facilitada | `false` |
| Todas las anteriores pasan | `true` |

Fuente: `packages/audit/src/index.ts:375-405` y
`packages/audit/src/jws.ts:149-203`.

El `eventId` devuelto en el sobre **no** se confía desde la entrada: se
recalcula a partir de los bytes canónicos de `envelope.event`. Un sobre
falsificado con un `eventId` obsoleto falla, por tanto, la verificación
en el *hash* recalculado, antes de que se ejecute la comprobación JWS.

### Resolución de `kid`

La verificación se realiza con una única clave pública facilitada por
quien llama. El `kid` llevado en la cabecera protegida es UTF-8
opaco; `@cms/audit` no realiza búsqueda de claves, rotación ni gestión
del almacén de confianza. Quien llame y necesite un mapa
`kid -> publicKey` debe resolverlo fuera de banda y pasar la
`publicKeyPem` correspondiente a `verifyEnvelope`. El único dato que
la cabecera ofrece al verificador sobre qué clave usar es el `kid`
que el firmante eligió.

## Errores (forma libre, sin códigos estables)

`@cms/audit` exporta tres clases de error, ninguna de las cuales
participa en un catálogo de uniones cerradas:

| Clase | Módulo | Propósito |
| --- | --- | --- |
| `AuditError` | `packages/audit/src/index.ts:147-152` | Lanzado por fallos de validación o de tiempo de construcción en `validateAuditEvent`, `buildEvent`, `signEvent` y los helpers `requireX`. |
| `CanonicalError` | `packages/audit/src/canonical.ts:36-41` | Lanzado por `assertSupported`, `canonicalJSON`, `canonicalize`, `canonicalNDJSON` y `contentHash` cuando un valor no admitido llega al codificador. |
| `JwsError` | `packages/audit/src/jws.ts:28-33` | Lanzado por errores de parseo de cabecera, parseo de clave, discrepancia de tipo de clave y señales de algoritmo no admitido dentro de `signDetached` y `verifyDetached`. |

`@cms/audit` no exporta un *array* en tiempo de ejecución cerrado
`*_ERROR_CODES`. El `message` libre de cada clase es solo para
humanos; ninguna persona que llama debe hacer *pattern matching* sobre
él. La ruta de rechazo de `verifyEnvelope` devuelve `false` y no
lanza. La escritura del sobre, cuando falla, sale por la maquinaria de
`StorageError` / `ApiErrorCode` que ya usa el resto del sistema. Véase
la nota de omisión explícita en
[`error-codes.es.md`](error-codes.es.md#auditoría-no-tiene-unión-estable-de-códigos-de-error).

## Almacenamiento de solo añadir

La tabla de auditoría persistida es `cms_storage.audit_events`. Las
constantes del esquema viven en `packages/storage/src/schema.ts:581-622`
y los disparadores en
`packages/storage/migrations/0001_governance.sql:583-605`.

| Propiedad | Fuente |
| --- | --- |
| La clave primaria es `event_hash` (hexadecimal en minúsculas de 64 caracteres) | `schema.ts:585` |
| `event` es un objeto `jsonb` almacenado junto al `event_hash` calculado de forma independiente; SQL no afirma que uno sea el hash del otro | `schema.ts:602-603` |
| `schema_version` es `1` y acotado por `CHECK` a `[1, 65535]` | `schema.ts:598`, `schema.ts:618` |
| `jsonb_typeof(event) = 'object'` forzada en la capa SQL | `schema.ts:619` |
| `selfApproved = false OR delegated_human_actor_id IS NULL` forzada en la capa SQL | `schema.ts:620` |
| Las claves foráneas a `tenants`, `actors`, `proposals`, `approvals` son `ON DELETE RESTRICT` | `schema.ts:612-616` |
| `event_hash ~ '^[0-9a-f]{64}$'` forzada en la capa SQL | `schema.ts:617` |

| Disparador | Evento | Fuente |
| --- | --- | --- |
| `audit_events_no_update` | BEFORE UPDATE | `0001_governance.sql:595-597` |
| `audit_events_no_delete` | BEFORE DELETE | `0001_governance.sql:599-601` |
| `audit_events_no_truncate` | BEFORE TRUNCATE | `0001_governance.sql:603-605` |

Los tres disparadores invocan `cms_storage.reject_mutation`
(`0001_governance.sql:583-593`), que lanza SQLSTATE `P0001` con el
texto marcador `cms_storage.audit_events is append-only; UPDATE/DELETE
is not permitted (op=..., SQLSTATE=P0001)`. La capa de almacenamiento
clasifica ese SQLSTATE como `AppendOnlyViolationError` y lo expone
como `StorageError('append_only_violation', ...)`.

La verificación de la propiedad de solo añadir se realiza en la capa
SQL, no en código Node. El CMS no aplica la inmutabilidad por
convención; la aplica mediante disparadores y mediante claves foráneas
`RESTRICT`. Una persona operadora que necesite eliminar físicamente
una fila debe eliminar el disparador, realizar el borrado y volver a
crearlo; esto se documenta como flujo de operación, no como ruta
habitual de la API.

## Secuencia en el límite de la API

La capa de API (`packages/api/src/index.ts:1144-1181`) es la única
que llama a `storage.appendAuditEvent` hoy. Almacena un objeto `event`
estrecho (`kind` más identificadores de transición/publicación) y calcula el
`eventHash` de la fila mediante SHA-256 sobre ese objeto más los campos de
tenant, actor, propuesta, aprobación y marca temporal usando `JSON.stringify`.

Esta fila de auditoría de la API y el `AuditEvent` portable de `@cms/audit` son
**representaciones V1 independientes**. La API no importa `@cms/audit`, no
canonicaliza ni firma un `AuditEvent` y no persiste una correspondencia entre
los dos hashes. `@cms/audit` calcula el hash de bytes canónicos de un sobre
distinto y más rico. Por tanto, los hashes no son iguales y `eventHash` no es
una clave de unión con un sobre firmado. La fila de la API está protegida por
controles SQL append-only; el firmado de sobres portables sigue siendo una
capacidad del paquete sin cableado de producción en la API V1.

## Compositor para exportación portable

Una persona revisora que desee verificar un registro sin conexión
concatena los bytes canónicos del evento con el JWS detached y la clave
pública identificada por `kid`. El helper `canonicalNDJSON`
(`packages/audit/src/canonical.ts:130-154`) emite un único *blob*
NDJSON para una lista de eventos; la canonicalización por evento es el
mismo código que usan el firmado y la verificación, por lo que una
persona verificadora y una firmante acuerdan la secuencia de bytes
para cualquier evento válido.

## Dónde se consumen las dos representaciones

| Consumidor | Superficie | Fuente |
| --- | --- | --- |
| Persistencia de fila de auditoría de la API | Inserción en `cms_storage.audit_events` | `packages/storage/src/index.ts:1957-1986` |
| Lectura de fila de auditoría por `eventHash` | `getAuditEventByHash` | `packages/storage/src/index.ts:1988-1995` |
| Listado de auditoría por propuesta | `listAuditEventsForProposal` | `packages/storage/src/index.ts:1997-2004` |
| Cálculo de *hash* para filas de la API | `sha256Hex` en `appendAudit` | `packages/api/src/index.ts:1187-1189` |
| Sobre portable de `@cms/audit` | Pruebas de paquete de `verifyEnvelope`, `verifyDetached`, `signEvent`; sin consumidor de producción en la API V1 | `packages/audit/test/audit.test.ts` |

Las superficies MCP, CLI y web nunca leen ni escriben directamente ninguna
representación; pasan por la API. V1 no afirma una identidad de hash unificada
entre la fila de la API y el sobre firmado portable.
