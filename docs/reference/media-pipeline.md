# Media pipeline

> **Audience:** integrators, security reviewers, and operator host
> maintainers. This page is the closed reference for the blob-store
> contract and the governed image pipeline in `@cms/media`. It mirrors
> `packages/media/src/blob-store.ts` and
> `packages/media/src/pipeline.ts` line-for-line. The companion
> observability surface is the source's PII-free log stream and the
> Prometheus `/metrics` endpoint documented at
> [`docs/reference/observability.md`](observability.md) ·
> [`.es`](observability.es.md). The audit envelope (signed,
> content-addressable, offline-verifiable) is documented at
> [`docs/reference/audit-envelope.md`](audit-envelope.md) ·
> [`.es`](audit-envelope.es.md).

> [Versión en español](media-pipeline.es.md) · English and Spanish are
> peer locales. Both siblings ship in the same pull request (zero-lag
> rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## The blob store

### Namespace model (exactly three)

The blob store partitions tenant storage into three closed namespaces,
declared by `ObjectNamespace` at
`packages/media/src/blob-store.ts:73`:

| Namespace | V1 role |
| --- | --- |
| `quarantine/` | Holds inbound media while it is being validated. The pipeline writes here first. |
| `published/` | The governed projection of media that has been approved and is safe to serve. V1 reads and writes. |
| `video/` | V1 read-only video surface. The pipeline refuses all writes; reads are accepted. |

Reads may resolve any namespace; callers must request one explicitly.
The canonical key format is
`<tenantId>/<namespace>/<key>` (built by `tenantObjectKey` at
`packages/media/src/blob-store.ts:168-170`).

### BLOB_STORE_ERROR_CODES — exactly nine

The closed union `BlobStoreErrorCode` and its readonly tuple mirror
`BLOB_STORE_ERROR_CODES` are at
`packages/media/src/blob-store.ts:244-266`. There are exactly nine
codes:

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

`E_VIDEO_WRITE_FORBIDDEN` is raised by every `put` and `delete` whose
key carries `namespace === 'video'` (the filesystem and S3 stores
both refuse). `E_TRAVERSAL` and `E_SYMLINK_ESCAPE` are exclusive to
the filesystem-backed `LocalBlobStore`; the S3 backend never escapes
its bucket and the corresponding codes are still part of the closed
union so callers can pattern-match on the same set everywhere.

### Blob read / write invariants

- **Atomic writes are the default.** `BlobPutOptions.atomic` defaults
  to `true` on `LocalBlobStore` (write to a sibling temp file, then
  `rename`); the S3 store is always atomic because object puts either
  succeed or fail without leaving a partial object visible. Setting
  `atomic: false` requests best-effort overwrite.
- **Tenant binding is enforced at construction.** A store is bound to
  a single `TenantId`; `assertTenant` rejects any `TenantScopedKey`
  whose `tenantId` does not match. Cross-tenant reads raise
  `E_CROSS_TENANT` and cross-tenant writes raise `E_CROSS_TENANT` or
  `E_VIDEO_WRITE_FORBIDDEN` depending on namespace.
- **Path traversal is forbidden.** `LocalBlobStore` resolves every key
  against the tenant root and uses `realpath`-based containment to
  refuse any path that escapes via `..` segments or symlink resolution
  (`packages/media/src/blob-store.ts:358-470`).
- **S3 backend signatures.** `S3BlobStore` requires `If-None-Match: *`
  on first put (delegated to the `S3Client.putObject` contract); a
  re-put under the existing key is allowed via the `ifNoneMatch`
  option being unset on the explicit overwrite call.

Source: `packages/media/src/blob-store.ts:172-285`,
`packages/media/src/blob-store.ts:312-772`,
`packages/media/src/blob-store.ts:778-1086`.

### Image media field contracts

The image contracts at `packages/media/src/blob-store.ts:1092-1219`
mirror what the pipeline accepts and emits. The closed `ImageFormat`
union is `'webp' | 'jpeg' | 'png' | 'avif'`. The closed
`DeclaredMime` union is
`'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'
| 'image/gif' | 'video/mp4' | 'video/webm'`. **The pipeline accepts
only the first four MIME types as ingestible**; `'image/gif'`,
`'video/mp4'`, and `'video/webm'` are declared but intentionally not
on the ingestible set (see `ACCEPTED_DECLARED_MIMES` at
`packages/media/src/pipeline.ts:113-122`). The pipeline rejects
non-ingestible declared MIME with `E_MIME_SPOOFED`.

`MediaPipelineInputAlt` is a closed peer-locale contract:
`en` and `es` are first-class. An image may be `decorative: true`
(in which case `en` and `es` are forbidden) or informative (in which
case both peer locales MUST be present and non-empty). Mixed states
fail closed with `E_ALT_MISSING_PEER_LOCALE`.

## The governed image pipeline

### Constructor

`GovernedMediaPipelineImpl(config)` requires four injected services
plus the closed `MediaPipelineLimits` and
`MediaPipelineDerivativePlanSpec[]`. The four injected surfaces are
declared by `MediaPipelineConfig` at
`packages/media/src/blob-store.ts:1329-1336`:

| Dependency | Why it is required |
| --- | --- |
| `blobStore` | The single promoted path for tenant-scoped bytes. |
| `auth` | The injected gate that rejects non-human identities; service and MCP identities fail closed at `auth.requireHuman`. |
| `malwareScanner` | The pipeline refuses to operate without a scanner. A scanner that cannot reach its backend throws with `E_MALWARE_SCAN_UNAVAILABLE`. |
| `processor` | The image processor that decodes and encodes. It MUST emit `MediaPipelineAttestation` (both `iccPreserved: true` and `privacyExifStripped: true`); absence of either flag is a hard error. |

Substitutes are allowed in tests only. There is no in-memory
fallback; the pipeline has no silent dependency swap.

### MEDIA_PIPELINE_ERROR_CODES — exactly eighteen

The closed union `MediaPipelineErrorCode` and its readonly tuple
mirror `MEDIA_PIPELINE_ERROR_CODES` are at
`packages/media/src/blob-store.ts:1226-1266`. There are exactly
eighteen codes:

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

### Stage sequence — scan / quarantine run before encode / promotion

The pipeline ingests in a strict, deterministic order. Each stage
fails closed with a stable code; callers branch on
`result.kind` + `result.code`. The sequence below is taken from the
runtime in `packages/media/src/pipeline.ts:582-873`.

| Stage | What happens | Result on failure |
| --- | --- | --- |
| 0 — structural validation | Identity, declared MIME, sanitized filename, alt peers, `Uint8Array` bytes, derivative plan. Failures here never reach quarantine — they surface as `rejected`. | `kind: 'rejected'`, `code: E_INVALID_INPUT` / `E_AUTH_REQUIRED` / `E_CROSS_TENANT` / `E_MIME_SPOOFED` / `E_FILENAME_UNSAFE` / `E_ALT_MISSING_PEER_LOCALE` |
| authorization — after stage 0, before stage 3 | `config.auth.requireHuman(identity)` rejects service and MCP identities. Auth failures always surface as `E_AUTH_REQUIRED` regardless of the inner gate's reason. | `kind: 'rejected'`, `code: E_AUTH_REQUIRED` |
| 3 — compressed byte cap | `ctx.bytes.length > config.limits.maxBytes`. | `kind: 'quarantined'`, `code: E_BYTES_EXCEEDED`, `stage: 'bytes'` |
| 4 — magic-byte signature | Magic-byte signature detection against the closed signature table. Two distinct failure modes: no recognised signature → `E_SIGNATURE_MISMATCH`; declared MIME does not match detected → `E_MIME_SPOOFED`. | `kind: 'quarantined'`, `code: E_SIGNATURE_MISMATCH` / `E_MIME_SPOOFED`, `stage: 'signature'` |
| 5 — decode + decompression-bomb guard | `processor.decode()` is invoked; dimensions are within `maxDimension` and pixel count within `maxPixels`. A decode throw is `E_PROCESSOR_DECODE_FAILED`; an over-budget decoded image is `E_DECOMPRESSION_BOMB`. | `kind: 'quarantined'`, `code: E_PROCESSOR_DECODE_FAILED` / `E_DECOMPRESSION_BOMB`, `stage: 'decode'` |
| 5b — crop / focal bounds | Focal in `[0, 1]`; crop in pixel coordinates within decoded dimensions. Decorative images may not carry focal or crop. | `kind: 'quarantined'`, `code: E_CROP_OUT_OF_BOUNDS` / `E_FOCAL_OUT_OF_BOUNDS`, `stage: 'validate'` |
| 6 — malware scan (fail closed) | `malwareScanner.scan()` is invoked. **Three failure modes, all fail closed: scanner throws → `E_MALWARE_SCAN_UNAVAILABLE`; scanner returns `{ clean: true, reason: 'unavailable' }` → `E_MALWARE_SCAN_UNAVAILABLE`; scanner returns `{ clean !== true }` → `E_MALWARE_DETECTED`.** There is no silent softening. | `kind: 'quarantined'`, `code: E_MALWARE_SCAN_UNAVAILABLE` / `E_MALWARE_DETECTED`, `stage: 'scanner'` |
| 7 — encode (deterministic plan) | Each spec in `config.derivativePlan` produces one encoded derivative via `processor.encode()`. A per-derivative encode throw is `E_PROCESSOR_ENCODE_FAILED`. | `kind: 'quarantined'`, `code: E_PROCESSOR_ENCODE_FAILED`, `stage: 'encode'` |
| 8 — attestation (privacy/colour) | Each encoded derivative MUST carry `iccPreserved: true` AND `privacyExifStripped: true`. Either flag missing is a hard error. The processor MUST refuse to encode when it cannot preserve ICC or strip privacy-EXIF. | `kind: 'quarantined'`, `code: E_ICC_ATTESTATION_MISSING` / `E_EXIF_ATTESTATION_MISSING`, `stage: 'attestation'` |
| 9 — promote and roll back partials on failure | Each derivative is `put` into `published/` with `atomic: true`. A failed put triggers cleanup of every previously promoted derivative (`blobStore.delete` in reverse order), then surfaces the original code as `kind: 'quarantined'`, `code: E_INVALID_INPUT`, `stage: 'publish'`. If any cleanup call itself fails, the failure carries a reconciliation message; the canonical content layer is never exposed partially promoted. | `kind: 'quarantined'`, `code: E_INVALID_INPUT`, `stage: 'publish'` (or, if no derivatives were produced at all, `code: E_PROCESSOR_ENCODE_FAILED`, `stage: 'publish'`) |
| 10 — quarantine storage | A failure to write the quarantine entry itself does NOT mask the original code; the pipeline surfaces it as a separate `kind: 'rejected'`, `code: E_INVALID_INPUT`, `stage: 'quarantine-storage'`. | `kind: 'rejected'`, `code: E_INVALID_INPUT`, `stage: 'quarantine-storage'` |
| 11 — success: canonical published derivative | Largest-width derivative in the deterministic plan becomes the canonical key. The result carries `attestation: { iccPreserved: true, privacyExifStripped: true }`, decoded `width`/`height`, the validated alt (decorative flag and peer-locale strings), and optional validated focal / crop. | — |

The order matters: **scan and quarantine run before any encode or
promotion**. A scanner that cannot reach its backend throws with
`E_MALWARE_SCAN_UNAVAILABLE` and the bytes are routed to
`quarantine/`; they are never published. A clean verdict without
attestation is not promoted either, because attestation is the next
gate. The two fail-closed outcomes are the only ways a scan state
fails: `E_MALWARE_DETECTED` (a finding) and `E_MALWARE_SCAN_UNAVAILABLE`
(scanner cannot reach its backend or returns `reason: 'unavailable'`).

Source: `packages/media/src/pipeline.ts:582-873`,
`packages/media/src/pipeline.ts:1060-1112`.

### Result shapes

The result is a discriminated union (`packages/media/src/blob-store.ts:1219`):

| `kind` | Meaning | Carries |
| --- | --- | --- |
| `promoted` | All derivatives copied into `published/` with both attestation flags present. | `canonical`, `derivatives[]`, `attestation`, `width`, `height`, `alt`, `focal?`, `crop?` |
| `quarantined` | Bytes recorded in `quarantine/`; the canonical content layer is untouched. | `code`, `stage`, `quarantineId`, `reason` |
| `rejected` | The request itself was malformed; no bytes were written. | `code`, `stage`, `reason` |

A successful quarantine entry records the captured bytes under
`<tenantId>/quarantine/captured/<stem>-<quarantineId>.<ext>`; the
host marks the entry `captured` on the canonical content layer.

### Promotion partial-failure cleanup

If any derivative fails to promote, the pipeline rolls back every
already-promoted derivative. The flow at
`packages/media/src/pipeline.ts:789-832` deletes promoted keys in
reverse insertion order:

```ts
for (const promotedKey of promotedKeys.reverse()) {
  try {
    await this.config.blobStore.delete(promotedKey);
  } catch (cleanupError) {
    cleanupFailures.push(/* ... */);
  }
}
```

When cleanup succeeds, the original code (`E_INVALID_INPUT`) is
returned with a clear reason. When any cleanup itself fails, the
result includes a reconciliation note naming each failed delete, and
operators resolve the orphaned `published/` objects out-of-band
through the standard reconciliation path.

The rollback write beat (`canonical_written`) is the canonical state
endorsed by the rollback lineage; the rollback proposal terminal
state is `rolled_back`. Reconciliation is asynchronous and observable
through the canonical API, never through the pipeline itself.

### Rollback, audit, and human authority

Every governance transition — promotion, quarantine, rollback —
attaches to the audit envelope. The pipeline does NOT emit the
envelope itself; the host records the transition through
`@cms/audit` and persists it as a detached Ed25519 JWS envelope
(`SignedAuditEnvelope`). The audit contract is documented at
[`docs/reference/audit-envelope.md`](audit-envelope.md) ·
[`.es`](audit-envelope.es.md).

Rollback remains a one-action operator click against the
approval-time-captured target. Approve, publish, and rollback are
system-side and never delegated to MCP or service identities.
Commerce-coupled media fields (Stripe-coupled Cerafica fields like
`price`, `stripe_payment_link`, `available`, `one_of_one`) default
to read-only / coordinator-gated; clients may only edit free
fields. This boundary is documented at
[`docs/concepts/content-boundary.md`](../concepts/content-boundary.md) ·
[`.es`](../concepts/content-boundary.es.md) and the Cerafica row of
[`docs/overview.md`](../overview.md) ·
[`.es`](../overview.es.md).

## Operating notes

- **Storage failure to record quarantine is not silent.** The
  pipeline surfaces the storage error as `E_INVALID_INPUT` /
  `quarantine-storage` so the operator sees the loss; the original
  pipeline code is preserved when storage succeeds.
- **The scanner contract is fail closed by construction.** A
  `clean: true, reason: 'unavailable'` verdict is treated identically
  to a scanner throw. Operators who intend to soften the unavailable
  state must do so at the scanner itself, never in the pipeline.
- **Image processor attestation is independent per flag.** `iccPreserved`
  and `privacyExifStripped` are checked independently; the pipeline
  refuses with `E_ICC_ATTESTATION_MISSING` or
  `E_EXIF_ATTESTATION_MISSING` for the missing flag.
- **Video is read-only in V1.** `runVideo` always returns
  `kind: 'rejected', code: 'E_VIDEO_MUTATION_FORBIDDEN'`,
  `stage: 'request'`. Reads remain the caller's responsibility via the
  BlobStore API.
- **Promotion is atomic per derivative.** `blobStore.put(key, bytes,
  { contentType, atomic: true })` writes through a sibling temp file
  on `LocalBlobStore` and always atomically on `S3BlobStore`.

## Evidence

- BlobStore + image contracts —
  `packages/media/src/blob-store.ts:66-1364`
- `BLOB_STORE_ERROR_CODES` (exactly nine) —
  `packages/media/src/blob-store.ts:244-266`
- `MEDIA_PIPELINE_ERROR_CODES` (exactly eighteen) —
  `packages/media/src/blob-store.ts:1226-1266`
- Pipeline implementation —
  `packages/media/src/pipeline.ts:1-1248`
- Magic-byte signature table —
  `packages/media/src/pipeline.ts:155-189`
- Quarantine bookkeeping —
  `packages/media/src/pipeline.ts:195-202`,
  `packages/media/src/pipeline.ts:1060-1112`
- Promotion + rollback partial cleanup —
  `packages/media/src/pipeline.ts:789-832`
- Scanner fail-closed contract —
  `packages/media/src/blob-store.ts:1283-1290`,
  `packages/media/src/pipeline.ts:712-754`
- Audit envelope (signed, content-addressable, offline-verifiable) —
  [`docs/reference/audit-envelope.md`](audit-envelope.md) ·
  [`.es`](audit-envelope.es.md)
- Observability surfaces —
  [`docs/reference/observability.md`](observability.md) ·
  [`.es`](observability.es.md)
- Content boundary and human authority —
  [`docs/concepts/content-boundary.md`](../concepts/content-boundary.md) ·
  [`.es`](../concepts/content-boundary.es.md)
