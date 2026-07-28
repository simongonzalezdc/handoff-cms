/**
 * `@cms/media` — pluggable media BlobStore and governed pipeline contracts.
 *
 * This module is the only legitimate surface through which the rest of
 * the CMS reads or writes media bytes. It exposes:
 *
 *   - The `BlobStore` abstraction, with concrete `LocalBlobStore` and
 *     `S3BlobStore` implementations. The S3 client is injected, so this
 *     package never imports a cloud SDK.
 *   - Tenant-scoped key helpers (`tenantScopedKey`, `tenantObjectKey`,
 *     `brandTenantId`) used by every call site.
 *   - The closed `BlobStoreError` / `BlobStoreErrorCode` model.
 *   - Image media-field contracts: peer en/es alt requirements,
 *     decorative handling, focal/crop, responsive derivative plans,
 *     ICC-preserved and privacy-EXIF-stripped attestation.
 *   - Video as read-only in V1: the store and pipeline refuse writes
 *     against the `video/` namespace.
 *   - The `GovernedMediaPipeline` class and the full set of pipeline
 *     config / input / result / error types re-exported from
 *     `./blob-store.js` (declared in `src/pipeline.ts`).
 *
 * Non-goals:
 *   - Canonical CMS content/assets remain host-owned. This package only
 *     persists the governed projection of media.
 *   - No in-memory or fake BlobStore. A `BlobStore` instance must be
 *     backed by a real filesystem root or a real S3-compatible client.
 *
 * Error model:
 *   - `BlobStoreError` and `MediaPipelineError` are the roots. Subclasses
 *     carry stable, machine-readable `code` fields from the closed
 *     `BlobStoreErrorCode` and `MediaPipelineErrorCode` unions so the
 *     API / CLI / MCP layers can map to localized messages without
 *     string matching.
 */

export {
  BLOB_STORE_ERROR_CODES,
  BlobStoreError,
  type BlobObject,
  type BlobPutOptions,
  type BlobReadOptions,
  type BlobStore,
  type BlobStoreErrorCode,
  type DeclaredMime,
  type GovernedMediaPipeline as GovernedMediaPipelineContract,
  type ImageFormat,
  type LocalBlobStoreOptions,
  LocalBlobStore,
  MEDIA_PIPELINE_ERROR_CODES,
  type MalwareScanner,
  type MediaImageProcessor,
  type MediaPipelineAttestation,
  type MediaPipelineConfig,
  type MediaPipelineCrop,
  type MediaPipelineDerivative,
  type MediaPipelineDerivativePlanSpec,
  MediaPipelineError,
  type MediaPipelineErrorCode,
  type MediaPipelineFailure,
  type MediaPipelineFocal,
  type MediaPipelineIdentity,
  type MediaPipelineInput,
  type MediaPipelineInputAlt,
  type MediaPipelineLimits,
  type MediaPipelineQuarantineEntry,
  type MediaPipelineResult,
  type MediaPipelineSuccess,
  type ObjectNamespace,
  type S3BlobStoreOptions,
  S3BlobStore,
  type S3Client,
  type TenantId,
  type TenantScopedKey,
  brandTenantId,
  tenantObjectKey,
  tenantListPrefix,
  tenantScopedKey,
} from './blob-store.js';
// ---------------------------------------------------------------------------
// Pipeline re-exports
//
// The `GovernedMediaPipeline` class lives in `./pipeline.js`; we re-export it
// here so consumers can `import { GovernedMediaPipeline } from '@cms/media'`
// and get the implementation. TypeScript declaration-merges the class with
// the `GovernedMediaPipeline` interface exported above, so consumers may
// also use the name as a type. The class MUST satisfy the interface.
// ---------------------------------------------------------------------------
export { GovernedMediaPipelineImpl as GovernedMediaPipeline } from './pipeline.js';
export { createGovernedMediaPipeline } from './pipeline.js';
export type { SuccessExtras, SuccessWithExtras } from './pipeline.js';
export { withDimensions } from './pipeline.js';
// ---------------------------------------------------------------------------
// Production image processor
//
// `ImageMagickProcessor` is the production implementation. Its Apache-2.0
// WebAssembly runtime keeps the open-core dependency graph license-clean.
export {
  ImageMagickProcessor,
  initializeImageMagickRuntime,
} from './imagemagick-processor.js';
export type { ImageMagickProcessorOptions } from './imagemagick-processor.js';
