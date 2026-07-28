# Tubería de medios

> **Audiencia:** integradores, revisores de seguridad y mantenedores
> del host del operador. Esta página es la referencia cerrada del
> contrato del *blob store* y la tubería de imágenes gobernada en
> `@cms/media`. Refleja línea por línea
> `packages/media/src/blob-store.ts` y
> `packages/media/src/pipeline.ts`. La superficie de observabilidad
> compañera es el flujo de registros sin PII y el endpoint Prometheus
> `/metrics` documentado en
> [`docs/reference/observability.es.md`](observability.es.md) ·
> [EN](observability.md). El sobre de auditoría (firmado,
> direccionable por contenido, verificable sin conexión) se
> documenta en [`docs/reference/audit-envelope.es.md`](audit-envelope.es.md) ·
> [EN](audit-envelope.md).

> [English version](media-pipeline.md) · English and Spanish are
> peer locales. Both siblings ship in the same pull request (zero-lag
> rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## El *blob store*

### Modelo de espacios de nombres (exactamente tres)

El *blob store* particiona el almacenamiento del tenant en tres
espacios de nombres cerrados, declarados por `ObjectNamespace` en
`packages/media/src/blob-store.ts:73`:

| Espacio de nombres | Rol en V1 |
| --- | --- |
| `quarantine/` | Aloja medios entrantes mientras se validan. La tubería escribe aquí primero. |
| `published/` | La proyección gobernada de medios aprobados y seguros para servir. Lecturas y escrituras en V1. |
| `video/` | Superficie de video de solo lectura en V1. La tubería rechaza todas las escrituras; las lecturas se aceptan. |

Las lecturas pueden resolver cualquier espacio de nombres; quien
llama debe solicitar uno explícitamente. El formato canónico de
clave es `<tenantId>/<namespace>/<key>` (construido por
`tenantObjectKey` en `packages/media/src/blob-store.ts:168-170`).

### BLOB_STORE_ERROR_CODES — exactamente nueve

La unión cerrada `BlobStoreErrorCode` y su tupla de solo lectura
espejo `BLOB_STORE_ERROR_CODES` están en
`packages/media/src/blob-store.ts:244-266`. Hay exactamente nueve
códigos:

```ts
export const BLOB_STORE_ERROR_CODES = [
  'E_INVALID_KEY',
  'E_CROSS_TENANT',
  'E_NOT_FOUND',
  'E_TRAVERSAL',
  'E_SYMLINK_ESCAPE',
  'E_BYTES_EXCEEDED',
  'E_NOT_IMPLEMENTED',
  'E_BACKEND_FAILURE',
  'E_VIDEO_WRITE_FORBIDDEN',
] as const;
```

`E_VIDEO_WRITE_FORBIDDEN` lo lanza cada `put` y `delete` cuya clave
lleve `namespace === 'video'` (los almacenes de sistema de archivos
y S3 lo rechazan). `E_TRAVERSAL` y `E_SYMLINK_ESCAPE` son exclusivos
del `LocalBlobStore` basado en sistema de archivos; el backend S3
nunca escapa de su *bucket* y los códigos correspondientes siguen
siendo parte de la unión cerrada para que quien llama pueda hacer
coincidencias de patrón sobre el mismo conjunto en cualquier lugar.

### Invariantes de lectura / escritura del blob

- **Las escrituras atómicas son el valor por defecto.**
  `BlobPutOptions.atomic` vale `true` por defecto en `LocalBlobStore`
  (escribe en un archivo temporal hermano y luego hace `rename`); el
  almacén S3 siempre es atómico porque los *puts* de objeto o
  triunfan o fallan sin dejar un objeto parcial visible. Fijar
  `atomic: false` solicita sobreescritura al mejor esfuerzo.
- **La asociación al tenant se aplica en la construcción.** Un
  almacén se asocia a un único `TenantId`; `assertTenant` rechaza
  cualquier `TenantScopedKey` cuyo `tenantId` no coincida. Las
  lecturas cruzadas entre tenants lanzan `E_CROSS_TENANT` y las
  escrituras cruzadas entre tenants lanzan `E_CROSS_TENANT` o
  `E_VIDEO_WRITE_FORBIDDEN` según el espacio de nombres.
- **Se prohíbe la traversée de rutas.** `LocalBlobStore` resuelve
  cada clave contra la raíz del tenant y usa contención basada en
  `realpath` para rechazar cualquier ruta que escape mediante
  segmentos `..` o resolución de enlaces simbólicos
  (`packages/media/src/blob-store.ts:358-470`).
- **Firmas del backend S3.** `S3BlobStore` requiere `If-None-Match:
  *` en el primer *put* (delegado al contrato `S3Client.putObject`);
  un nuevo *put* bajo la misma clave se permite mediante la opción
  `ifNoneMatch` no establecida en la llamada explícita de
  sobreescritura.

Fuente: `packages/media/src/blob-store.ts:172-285`,
`packages/media/src/blob-store.ts:312-772`,
`packages/media/src/blob-store.ts:778-1086`.

### Contratos de campos de medios de imagen

Los contratos de imagen en
`packages/media/src/blob-store.ts:1092-1219` reflejan lo que la
tubería acepta y emite. La unión cerrada `ImageFormat` es
`'webp' | 'jpeg' | 'png' | 'avif'`. La unión cerrada `DeclaredMime`
es `'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'
| 'image/gif' | 'video/mp4' | 'video/webm'`. **La tubería solo
acepta como ingeribles los cuatro primeros tipos MIME**;
`'image/gif'`, `'video/mp4'` y `'video/webm'` están declarados pero
deliberadamente fuera del conjunto ingerible (véase
`ACCEPTED_DECLARED_MIMES` en
`packages/media/src/pipeline.ts:113-122`). La tubería rechaza el
MIME declarado no ingerible con `E_MIME_SPOOFED`.

`MediaPipelineInputAlt` es un contrato cerrado de locales pares:
`en` y `es` son de primera clase. Una imagen puede ser
`decorative: true` (en cuyo caso `en` y `es` están prohibidos) o
informativa (en cuyo caso ambos locales pares DEBEN estar presentes
y no vacíos). Los estados mixtos fallan cerrados con
`E_ALT_MISSING_PEER_LOCALE`.

## La tubería de imágenes gobernada

### Constructor

`GovernedMediaPipelineImpl(config)` requiere cuatro servicios
inyectados además de los cerrados `MediaPipelineLimits` y
`MediaPipelineDerivativePlanSpec[]`. Las cuatro superficies
inyectadas las declara `MediaPipelineConfig` en
`packages/media/src/blob-store.ts:1329-1336`:

| Dependencia | Por qué se requiere |
| --- | --- |
| `blobStore` | La única ruta promovida para bytes con alcance de tenant. |
| `auth` | La puerta inyectada que rechaza identidades que no son humanas; las identidades de servicio y MCP fallan cerradas en `auth.requireHuman`. |
| `malwareScanner` | La tubería se rehúsa a operar sin un escáner. Un escáner que no pueda alcanzar su *backend* lanza con `E_MALWARE_SCAN_UNAVAILABLE`. |
| `processor` | El procesador de imagen que decodifica y codifica. DEBE emitir `MediaPipelineAttestation` (tanto `iccPreserved: true` como `privacyExifStripped: true`); la ausencia de cualquiera de las dos banderas es un error duro. |

Los sustitutos se permiten solo en pruebas. No hay respaldo en
memoria; la tubería no tiene intercambio silencioso de
dependencias.

### MEDIA_PIPELINE_ERROR_CODES — exactamente dieciocho

La unión cerrada `MediaPipelineErrorCode` y su tupla de solo
lectura espejo `MEDIA_PIPELINE_ERROR_CODES` están en
`packages/media/src/blob-store.ts:1226-1266`. Hay exactamente
dieciocho códigos:

```ts
export const MEDIA_PIPELINE_ERROR_CODES = [
  'E_AUTH_REQUIRED',
  'E_CROSS_TENANT',
  'E_FILENAME_UNSAFE',
  'E_MIME_SPOOFED',
  'E_SIGNATURE_MISMATCH',
  'E_BYTES_EXCEEDED',
  'E_DECOMPRESSION_BOMB',
  'E_MALWARE_DETECTED',
  'E_MALWARE_SCAN_UNAVAILABLE',
  'E_ALT_MISSING_PEER_LOCALE',
  'E_CROP_OUT_OF_BOUNDS',
  'E_FOCAL_OUT_OF_BOUNDS',
  'E_ICC_ATTESTATION_MISSING',
  'E_EXIF_ATTESTATION_MISSING',
  'E_VIDEO_MUTATION_FORBIDDEN',
  'E_PROCESSOR_DECODE_FAILED',
  'E_PROCESSOR_ENCODE_FAILED',
  'E_INVALID_INPUT',
] as const;
```

### Secuencia de etapas — escaneo / cuarentena antes de codificar / promover

La tubería ingiere en un orden estricto y determinista. Cada etapa
falla cerrada con un código estable; quien llama bifurca por
`result.kind` + `result.code`. La secuencia de abajo se toma del
tiempo de ejecución en `packages/media/src/pipeline.ts:582-873`.

| Etapa | Qué ocurre | Resultado en fallo |
| --- | --- | --- |
| 0 — validación estructural | Identidad, MIME declarado, nombre de archivo saneado, pares *alt*, bytes `Uint8Array`, plan de derivados. Los fallos aquí nunca llegan a cuarentena — aparecen como `rejected`. | `kind: 'rejected'`, `code: E_INVALID_INPUT` / `E_AUTH_REQUIRED` / `E_CROSS_TENANT` / `E_MIME_SPOOFED` / `E_FILENAME_UNSAFE` / `E_ALT_MISSING_PEER_LOCALE` |
| autorización — después de la etapa 0 y antes de la 3 | `config.auth.requireHuman(identity)` rechaza identidades de servicio y MCP. Los fallos de autorización siempre aparecen como `E_AUTH_REQUIRED` independientemente del motivo de la puerta interna. | `kind: 'rejected'`, `code: E_AUTH_REQUIRED` |
| 3 — tope de bytes comprimidos | `ctx.bytes.length > config.limits.maxBytes`. | `kind: 'quarantined'`, `code: E_BYTES_EXCEEDED`, `stage: 'bytes'` |
| 4 — firma de bytes mágicos | Detección de firma por bytes mágicos contra la tabla cerrada de firmas. Dos modos de fallo distintos: sin firma reconocida → `E_SIGNATURE_MISMATCH`; el MIME declarado no coincide con el detectado → `E_MIME_SPOOFED`. | `kind: 'quarantined'`, `code: E_SIGNATURE_MISMATCH` / `E_MIME_SPOOFED`, `stage: 'signature'` |
| 5 — decodificación y guardia anti-bomba de descompresión | Se invoca `processor.decode()`; las dimensiones están dentro de `maxDimension` y el conteo de píxeles dentro de `maxPixels`. Una excepción de decodificación es `E_PROCESSOR_DECODE_FAILED`; una imagen decodificada que excede el presupuesto es `E_DECOMPRESSION_BOMB`. | `kind: 'quarantined'`, `code: E_PROCESSOR_DECODE_FAILED` / `E_DECOMPRESSION_BOMB`, `stage: 'decode'` |
| 5b — límites de recorte / foco | Foco en `[0, 1]`; recorte en coordenadas de píxel dentro de las dimensiones decodificadas. Las imágenes decorativas no pueden llevar foco ni recorte. | `kind: 'quarantined'`, `code: E_CROP_OUT_OF_BOUNDS` / `E_FOCAL_OUT_OF_BOUNDS`, `stage: 'validate'` |
| 6 — escaneo de malware (*fail closed*) | Se invoca `malwareScanner.scan()`. **Tres modos de fallo, todos *fail closed*: el escáner lanza → `E_MALWARE_SCAN_UNAVAILABLE`; el escáner devuelve `{ clean: true, reason: 'unavailable' }` → `E_MALWARE_SCAN_UNAVAILABLE`; el escáner devuelve `{ clean !== true }` → `E_MALWARE_DETECTED`.** No hay ablandamiento silencioso. | `kind: 'quarantined'`, `code: E_MALWARE_SCAN_UNAVAILABLE` / `E_MALWARE_DETECTED`, `stage: 'scanner'` |
| 7 — codificación (plan determinista) | Cada spec en `config.derivativePlan` produce un derivado codificado mediante `processor.encode()`. Una excepción de codificación por derivado es `E_PROCESSOR_ENCODE_FAILED`. | `kind: 'quarantined'`, `code: E_PROCESSOR_ENCODE_FAILED`, `stage: 'encode'` |
| 8 — atestación (privacidad/color) | Cada derivado codificado DEBE llevar `iccPreserved: true` AND `privacyExifStripped: true`. Cualquier bandera ausente es un error duro. El procesador DEBE rehusar codificar cuando no puede preservar ICC o eliminar el EXIF de privacidad. | `kind: 'quarantined'`, `code: E_ICC_ATTESTATION_MISSING` / `E_EXIF_ATTESTATION_MISSING`, `stage: 'attestation'` |
| 9 — promover y revertir parciales en fallo | Cada derivado se hace `put` en `published/` con `atomic: true`. Un *put* fallido dispara la limpieza de cada derivado previamente promovido (`blobStore.delete` en orden inverso), y luego presenta el código original como `kind: 'quarantined'`, `code: E_INVALID_INPUT`, `stage: 'publish'`. Si alguna limpieza falla, el fallo lleva un mensaje de reconciliación; la capa de contenido canónico nunca queda parcialmente promovida. | `kind: 'quarantined'`, `code: E_INVALID_INPUT`, `stage: 'publish'` (o, si no se produjo derivado alguno, `code: E_PROCESSOR_ENCODE_FAILED`, `stage: 'publish'`) |
| 10 — almacenamiento de cuarentena | Un fallo al escribir la entrada de cuarentena NO enmascara el código original; la tubería lo presenta como `kind: 'rejected'` separado, `code: E_INVALID_INPUT`, `stage: 'quarantine-storage'`. | `kind: 'rejected'`, `code: E_INVALID_INPUT`, `stage: 'quarantine-storage'` |
| 11 — éxito: derivado publicado canónico | El derivado de mayor ancho del plan determinista se convierte en la clave canónica. El resultado lleva `attestation: { iccPreserved: true, privacyExifStripped: true }`, `width` / `height` decodificados, el *alt* validado (bandera *decorative* y cadenas por local par), y el foco / recorte validados opcionales. | — |

El orden importa: **el escaneo y la cuarentena corren antes de
cualquier codificación o promoción**. Un escáner que no pueda
alcanzar su *backend* lanza con `E_MALWARE_SCAN_UNAVAILABLE` y los
bytes se enrutan a `quarantine/`; nunca se publican. Un veredicto
limpio sin atestación tampoco se promueve, porque la atestación es
la siguiente puerta. Los dos resultados *fail-closed* son las
únicas formas en que un estado de escaneo falla:
`E_MALWARE_DETECTED` (un hallazgo) y `E_MALWARE_SCAN_UNAVAILABLE`
(el escáner no puede alcanzar su *backend* o devuelve
`reason: 'unavailable'`).

Fuente: `packages/media/src/pipeline.ts:582-873`,
`packages/media/src/pipeline.ts:1060-1112`.

### Formas del resultado

El resultado es una unión discriminada
(`packages/media/src/blob-store.ts:1219`):

| `kind` | Significado | Lleva |
| --- | --- | --- |
| `promoted` | Todos los derivados copiados en `published/` con ambas banderas de atestación presentes. | `canonical`, `derivatives[]`, `attestation`, `width`, `height`, `alt`, `focal?`, `crop?` |
| `quarantined` | Bytes registrados en `quarantine/`; la capa de contenido canónico queda intacta. | `code`, `stage`, `quarantineId`, `reason` |
| `rejected` | La solicitud en sí era inválida; no se escribió ningún byte. | `code`, `stage`, `reason` |

Una entrada exitosa de cuarentena registra los bytes capturados en
`<tenantId>/quarantine/captured/<stem>-<quarantineId>.<ext>`; el
host marca la entrada como `captured` en la capa de contenido
canónico.

### Limpieza de promoción parcial fallida

Si algún derivado falla al promover, la tubería revierte cada
derivado ya promovido. El flujo en
`packages/media/src/pipeline.ts:789-832` borra las claves
promovidas en orden inverso al de inserción:

```ts
for (const promotedKey of promotedKeys.reverse()) {
  try {
    await this.config.blobStore.delete(promotedKey);
  } catch (cleanupError) {
    cleanupFailures.push(/* ... */);
  }
}
```

Cuando la limpieza triunfa, se devuelve el código original
(`E_INVALID_INPUT`) con un motivo claro. Cuando alguna limpieza
falla, el resultado incluye una nota de reconciliación que nombra
cada borrado fallido, y los operadores resuelven los objetos
huérfanos en `published/` fuera de banda por la ruta estándar de
conciliación.

El *beat* de escritura de reversión (`canonical_written`) es el
estado canónico refrendado por el linaje de reversión; el estado
terminal de la propuesta de reversión es `rolled_back`. La
conciliación es asíncrona y observable a través de la API
canónica, nunca a través de la propia tubería.

### Reversión, auditoría y autoridad humana

Cada transición de gobernanza — promoción, cuarentena, reversión —
se vincula al sobre de auditoría. La tubería NO emite el sobre
por sí misma; el host registra la transición a través de
`@cms/audit` y la persiste como sobre JWS Ed25519 desligado
(`SignedAuditEnvelope`). El contrato de auditoría se documenta en
[`docs/reference/audit-envelope.es.md`](audit-envelope.es.md) ·
[EN](audit-envelope.md).

La reversión sigue siendo un único clic de operador contra el
objetivo capturado al momento de aprobación. Aprobar, publicar y
revertir son del lado del sistema y nunca se delegan a
identidades MCP o de servicio. Los campos de medios acoplados a
comercio (campos Cerafica acoplados a Stripe como `price`,
`stripe_payment_link`, `available`, `one_of_one`) son de solo
lectura / con compuerta de coordinador por defecto; las personas
solo pueden editar campos libres. Este límite se documenta en
[`docs/concepts/content-boundary.es.md`](../concepts/content-boundary.es.md) ·
[EN](../concepts/content-boundary.md) y en la fila Cerafica de
[`docs/overview.es.md`](../overview.es.md) ·
[EN](../overview.md).

## Notas operativas

- **El fallo del almacenamiento al registrar la cuarentena no es
  silencioso.** La tubería presenta el error de almacenamiento como
  `E_INVALID_INPUT` / `quarantine-storage` para que el operador vea
  la pérdida; el código original de la tubería se preserva cuando
  el almacenamiento tiene éxito.
- **El contrato del escáner es *fail closed* por construcción.** Un
  veredicto `clean: true, reason: 'unavailable'` se trata idéntico
  a una excepción del escáner. Quienes operen pretendan ablandar
  el estado no disponible deben hacerlo en el propio escáner,
  nunca en la tubería.
- **La atestación del procesador de imagen es independiente por
  bandera.** `iccPreserved` y `privacyExifStripped` se verifican
  independientemente; la tubería se rehúsa con
  `E_ICC_ATTESTATION_MISSING` o `E_EXIF_ATTESTATION_MISSING` para
  la bandera faltante.
- **El video es de solo lectura en V1.** `runVideo` siempre
  devuelve `kind: 'rejected', code: 'E_VIDEO_MUTATION_FORBIDDEN'`,
  `stage: 'request'`. Las lecturas siguen siendo responsabilidad de
  quien llama a través de la API del BlobStore.
- **La promoción es atómica por derivado.** `blobStore.put(key,
  bytes, { contentType, atomic: true })` escribe a través de un
  archivo temporal hermano en `LocalBlobStore` y siempre atómicamente
  en `S3BlobStore`.

## Evidencia

- Contratos de BlobStore + imagen —
  `packages/media/src/blob-store.ts:66-1364`
- `BLOB_STORE_ERROR_CODES` (exactamente nueve) —
  `packages/media/src/blob-store.ts:244-266`
- `MEDIA_PIPELINE_ERROR_CODES` (exactamente dieciocho) —
  `packages/media/src/blob-store.ts:1226-1266`
- Implementación de la tubería —
  `packages/media/src/pipeline.ts:1-1248`
- Tabla de firmas por bytes mágicos —
  `packages/media/src/pipeline.ts:155-189`
- Contabilidad de cuarentena —
  `packages/media/src/pipeline.ts:195-202`,
  `packages/media/src/pipeline.ts:1060-1112`
- Promoción + limpieza parcial de reversión —
  `packages/media/src/pipeline.ts:789-832`
- Contrato de escáner *fail closed* —
  `packages/media/src/blob-store.ts:1283-1290`,
  `packages/media/src/pipeline.ts:712-754`
- Sobre de auditoría (firmado, direccionable por contenido,
  verificable sin conexión) —
  [`docs/reference/audit-envelope.es.md`](audit-envelope.es.md) ·
  [EN](audit-envelope.md)
- Superficies de observabilidad —
  [`docs/reference/observability.es.md`](observability.es.md) ·
  [EN](observability.md)
- Límite de contenido y autoridad humana —
  [`docs/concepts/content-boundary.es.md`](../concepts/content-boundary.es.md) ·
  [EN](../concepts/content-boundary.md)
