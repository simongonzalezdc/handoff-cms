/**
 * `@cms/media` — governed image pipeline.
 *
 * The pipeline is the single promoted path for a tenant-scoped image.
 * It receives raw bytes plus caller attestation, validates the bytes
 * exhaustively, and returns one of three discriminated outcomes:
 *
 *   - `kind: 'promoted'`  — derivatives copied into `published/` with
 *     BOTH privacy/colour attestation flags present.
 *   - `kind: 'quarantined'` — the captured bytes were recorded under
 *     the tenant's `quarantine/` namespace; the canonical content
 *     layer remains untouched; an observable `quarantineId` is
 *     returned.
 *   - `kind: 'rejected'` — the request itself was malformed and no
 *     bytes were ever written.
 *
 * Quarantine is a stable, observable state. Successful quarantine
 * entries are returned in the failure result so the host can mark
 * them as `captured`. The canonical content/asset layer is
 * host-owned and is never modified here.
 *
 * Sequencing is strictly ordered. Each stage fails closed with a
 * stable, machine-readable error code from `MediaPipelineErrorCode`.
 * Callers branch on `result.kind` + `result.code`; they never match
 * on `message`.
 *
 * Stages:
 *   1. Identity check — service identities cannot trigger a publish;
 *      the pipeline delegates authority to `config.auth`.
 *   2. Filename sanitization (path traversal, control chars, length).
 *   3. Compressed byte cap (`config.limits.maxBytes`).
 *   4. Magic-byte signature detection; refuses mismatches with
 *      `E_MIME_SPOOFED` (declared vs detected mismatch) or
 *      `E_SIGNATURE_MISMATCH` (unrecognised signature).
 *   5. Decompression-bomb guard via the injected processor's
 *      `decode()`: width/height within `limits.maxDimension`,
 *      width*height within `limits.maxPixels`.
 *   6. Alt-text peer-locale validation: both `en` and `es` non-empty
 *      for informative images; `decorative: true` forbids any alt;
 *      mixed states are refused.
 *   7. Crop / focal bounds. Focal in `[0, 1]`. Crop in pixel
 *      coordinates that fit within decoded dimensions.
 *      Decorative images may not carry focal or crop.
 *   8. Malware scan — fails closed on throw, on `clean === false`,
 *      or on `reason === 'unavailable'`. The pipeline accepts no
 *      silent verdict softening.
 *   9. Deterministic per-derivative plan: each spec in
 *      `config.derivativePlan` becomes one encoded derivative.
 *  10. Privacy/colour attestation. The processor's `encode()` MUST
 *      return `iccPreserved: true` AND `privacyExifStripped: true`.
 *      Each flag is a separate contract; the pipeline refuses with
 *      `E_ICC_ATTESTATION_MISSING` or `E_EXIF_ATTESTATION_MISSING`
 *      independently.
 *  11. Promotion: copy each derivative into `published/`; record a
 *      quarantine entry on failure. A failed promotion never exposes
 *      the source as published.
 *  12. Video is REJECTED at the input boundary with
 *      `E_VIDEO_MUTATION_FORBIDDEN`. Reads remain the caller's
 *      responsibility via the BlobStore API.
 *
 * Production builds ship with real `LocalBlobStore` / `S3BlobStore`,
 * a real malware scanner, and a real `MediaImageProcessor`.
 * Substitutes are allowed in tests only; the pipeline has no
 * in-memory fallback and never silently swaps dependencies.
 */
import {
  type DeclaredMime,
  type GovernedMediaPipeline,
  type ImageFormat,
  type MediaPipelineAttestation,
  type MediaPipelineConfig,
  type MediaPipelineCrop,
  type MediaPipelineDerivative,
  type MediaPipelineDerivativePlanSpec,
  type MediaPipelineErrorCode,
  type MediaPipelineFocal,
  type MediaPipelineIdentity,
  type MediaPipelineInput,
  type MediaPipelineInputAlt,
  type MediaPipelineLimits,
  type MediaPipelineResult,
  type MediaPipelineSuccess,
  type MediaPipelineFailure,
  type ObjectNamespace,
  type TenantId,
  type TenantScopedKey,
} from './blob-store.js';

// ---------------------------------------------------------------------------
// Constants — pipeline owns its own deterministic plan logic.
// ---------------------------------------------------------------------------

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;
const FILENAME_MAX_LEN = 200;
const MIN_IMAGE_DIMENSION = 1;

const IMAGE_FORMATS: readonly ImageFormat[] = Object.freeze([
  'webp',
  'jpeg',
  'png',
  'avif',
]);

const IMAGE_FORMAT_SET: ReadonlySet<ImageFormat> = new Set(IMAGE_FORMATS);

const MIME_BY_FORMAT: Readonly<Record<ImageFormat, string>> = Object.freeze({
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
  avif: 'image/avif',
});

const ACCEPTED_DECLARED_MIMES: readonly DeclaredMime[] = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);

const ACCEPTED_DECLARED_MIME_SET: ReadonlySet<DeclaredMime> = new Set(
  ACCEPTED_DECLARED_MIMES,
);

// ---------------------------------------------------------------------------
// Magic-byte signature table (owned by pipeline)
// ---------------------------------------------------------------------------

interface Signature {
  readonly format: ImageFormat;
  readonly mime: string;
  readonly match: (body: Uint8Array) => boolean;
}

function bufStarts(body: Uint8Array, prefix: readonly number[]): boolean {
  if (body.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (body[i] !== prefix[i]) return false;
  }
  return true;
}

function asciiCaseEq(body: Uint8Array, offset: number, sig: string): boolean {
  if (body.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    const a = body[offset + i];
    const b = sig.charCodeAt(i);
    if (a === undefined) return false;
    const lowerA = a >= 65 && a <= 90 ? a + 32 : a;
    const lowerB = b >= 65 && b <= 90 ? b + 32 : b;
    if (lowerA !== lowerB) return false;
  }
  return true;
}

const SIGNATURES: readonly Signature[] = Object.freeze([
  Object.freeze({
    format: 'jpeg',
    mime: 'image/jpeg',
    match: (b: Uint8Array) => bufStarts(b, [0xff, 0xd8, 0xff]),
  }),
  Object.freeze({
    format: 'png',
    mime: 'image/png',
    match: (b: Uint8Array) =>
      bufStarts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  }),
  Object.freeze({
    format: 'webp',
    mime: 'image/webp',
    match: (b: Uint8Array) =>
      bufStarts(b, [0x52, 0x49, 0x46, 0x46]) && asciiCaseEq(b, 8, 'WEBP'),
  }),
  Object.freeze({
    format: 'avif',
    mime: 'image/avif',
    match: (b: Uint8Array) => {
      if (b.length < 12) return false;
      if (!asciiCaseEq(b, 4, 'ftyp')) return false;
      return asciiCaseEq(b, 8, 'avif') || asciiCaseEq(b, 8, 'avis');
    },
  }),
]);

function detectSignature(body: Uint8Array): Signature | null {
  for (const sig of SIGNATURES) {
    if (sig.match(body)) return sig;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Quarantine bookkeeping
// ---------------------------------------------------------------------------

let QUARANTINE_SEQ = 0;

/** Returns a stable, unique ID for a quarantine entry. Monotonic per
 *  process; cross-process uniqueness is the host's responsibility. */
function nextQuarantineId(): string {
  QUARANTINE_SEQ += 1;
  return `q-${QUARANTINE_SEQ.toString(36).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Internal error model
//
// Pipeline validation failures carry their own closed error-code union.
// BlobStore errors remain distinct and are mapped explicitly at the boundary.
// ---------------------------------------------------------------------------

class PipelineAssert extends Error {
  readonly code: MediaPipelineErrorCode;

  constructor(code: MediaPipelineErrorCode, stage: string, message: string) {
    super(`${stage}: ${message}`);
    this.name = 'PipelineAssert';
    this.code = code;
  }
}

function reject(
  code: MediaPipelineErrorCode,
  stage: string,
  message: string,
): never {
  throw new PipelineAssert(code, stage, message);
}

// ---------------------------------------------------------------------------
// Validation helpers (return values are frozen; failures throw)
// ---------------------------------------------------------------------------

function assertLimits(limits: MediaPipelineLimits | undefined): MediaPipelineLimits {
  if (!limits) {
    reject('E_INVALID_INPUT', 'config', 'limits are required');
  }
  const { maxBytes, maxPixels, maxDimension } = limits;
  if (
    !Number.isInteger(maxBytes) ||
    !Number.isInteger(maxPixels) ||
    !Number.isInteger(maxDimension)
  ) {
    reject('E_INVALID_INPUT', 'config', 'limits must be integer');
  }
  if (
    maxBytes <= 0 ||
    maxPixels <= 0 ||
    maxDimension <= 0 ||
    maxDimension < MIN_IMAGE_DIMENSION
  ) {
    reject('E_INVALID_INPUT', 'config', 'limits must be positive');
  }
  return limits;
}

function assertFilename(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    reject('E_FILENAME_UNSAFE', 'filename', 'filename must be a non-empty string');
  }
  if (
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('..')
  ) {
    reject(
      'E_FILENAME_UNSAFE',
      'filename',
      `filename contains illegal characters: ${JSON.stringify(value)}`,
    );
  }
  if (value.startsWith('.')) {
    reject('E_FILENAME_UNSAFE', 'filename', `filename must not start with a dot: ${JSON.stringify(value)}`);
  }
  if (value.length > FILENAME_MAX_LEN) {
    reject('E_FILENAME_UNSAFE', 'filename', `filename exceeds ${FILENAME_MAX_LEN} characters`);
  }
  if (!SAFE_FILENAME.test(value)) {
    reject(
      'E_FILENAME_UNSAFE',
      'filename',
      `filename must match ${SAFE_FILENAME}: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertAlt(alt: MediaPipelineInputAlt): {
  readonly decorative: boolean;
  readonly en: string | null;
  readonly es: string | null;
} {
  const decorative = alt.decorative === true;
  const enRaw = typeof alt.en === 'string' ? alt.en.trim() : '';
  const esRaw = typeof alt.es === 'string' ? alt.es.trim() : '';
  const hasEn = enRaw.length > 0;
  const hasEs = esRaw.length > 0;

  if (decorative) {
    if (hasEn || hasEs) {
      reject(
        'E_ALT_MISSING_PEER_LOCALE',
        'alt',
        'decorative images must not carry alt text',
      );
    }
    return Object.freeze({ decorative: true, en: null, es: null });
  }
  if (!hasEn || !hasEs) {
    reject(
      'E_ALT_MISSING_PEER_LOCALE',
      'alt',
      'both peer locales en and es are required for informative images',
    );
  }
  return Object.freeze({ decorative: false, en: enRaw, es: esRaw });
}

function assertFocal(
  focal: MediaPipelineFocal | undefined,
  decorative: boolean,
): MediaPipelineFocal | null {
  if (focal === undefined) {
    return null;
  }
  if (decorative) {
    reject('E_FOCAL_OUT_OF_BOUNDS', 'focal', 'decorative images must not carry focal point');
  }
  const { x, y } = focal;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    reject('E_FOCAL_OUT_OF_BOUNDS', 'focal', `focal out of [0,1]: ${JSON.stringify(focal)}`);
  }
  return Object.freeze({ x, y });
}

function assertCrop(
  crop: MediaPipelineCrop | undefined,
  decorative: boolean,
  decodedWidth: number,
  decodedHeight: number,
): MediaPipelineCrop | null {
  if (crop === undefined) {
    return null;
  }
  if (decorative) {
    reject('E_CROP_OUT_OF_BOUNDS', 'crop', 'decorative images must not carry crop');
  }
  const { x, y, width, height } = crop;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  ) {
    reject(
      'E_CROP_OUT_OF_BOUNDS',
      'crop',
      `crop must be integer pixel coords: ${JSON.stringify(crop)}`,
    );
  }
  if (width <= 0 || height <= 0) {
    reject(
      'E_CROP_OUT_OF_BOUNDS',
      'crop',
      `crop must have positive dimensions: ${JSON.stringify(crop)}`,
    );
  }
  if (x < 0 || y < 0) {
    reject(
      'E_CROP_OUT_OF_BOUNDS',
      'crop',
      `crop origin must be non-negative: ${JSON.stringify(crop)}`,
    );
  }
  if (x + width > decodedWidth) {
    reject(
      'E_CROP_OUT_OF_BOUNDS',
      'crop',
      `crop x+width > decoded width ${decodedWidth}: ${JSON.stringify(crop)}`,
    );
  }
  if (y + height > decodedHeight) {
    reject(
      'E_CROP_OUT_OF_BOUNDS',
      'crop',
      `crop y+height > decoded height ${decodedHeight}: ${JSON.stringify(crop)}`,
    );
  }
  return Object.freeze({ x, y, width, height });
}

function assertDerivativePlan(
  plan: readonly MediaPipelineDerivativePlanSpec[] | undefined,
): readonly MediaPipelineDerivativePlanSpec[] {
  if (!plan || plan.length === 0) {
    reject('E_INVALID_INPUT', 'plan', 'derivativePlan must be non-empty');
  }
  const seen = new Set<string>();
  const sorted = [...plan].sort((a, b) => {
    if (a.width !== b.width) return a.width - b.width;
    return a.format.localeCompare(b.format);
  });
  for (const spec of sorted) {
    if (!spec || typeof spec !== 'object') {
      reject('E_INVALID_INPUT', 'plan', `derivative spec must be object: ${JSON.stringify(spec)}`);
    }
    if (!IMAGE_FORMAT_SET.has(spec.format)) {
      reject('E_INVALID_INPUT', 'plan', `unsupported format: ${String(spec.format)}`);
    }
    if (!Number.isInteger(spec.width) || spec.width <= 0) {
      reject('E_INVALID_INPUT', 'plan', `width must be positive integer: ${String(spec.width)}`);
    }
    const k = `${spec.width}:${spec.format}`;
    if (seen.has(k)) {
      reject('E_INVALID_INPUT', 'plan', `duplicate derivative spec ${k}`);
    }
    seen.add(k);
  }
  return Object.freeze(sorted.map((s) => Object.freeze({ width: s.width, format: s.format })));
}

function bytesToUint8(input: Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array)) {
    reject('E_INVALID_INPUT', 'bytes', 'bytes must be a Uint8Array');
  }
  return new Uint8Array(input);
}

function assertedSha256(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    reject('E_INVALID_INPUT', 'sha', 'sha must be 64 lowercase hex chars');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Key derivation (publish + quarantine)
// ---------------------------------------------------------------------------

function capturedNamespace(): ObjectNamespace {
  return 'quarantine';
}

function publishedNamespace(): ObjectNamespace {
  return 'published';
}

function publishedDerivativeKey(
  tenantId: TenantId,
  filename: string,
  variantWidth: number,
  format: ImageFormat,
  sha256: string,
): TenantScopedKey {
  const stem = stripExtension(filename);
  const shortHash = assertedSha256(sha256).slice(0, 12);
  return Object.freeze({
    tenantId,
    namespace: publishedNamespace(),
    key: `derived/${stem}-w${variantWidth}.${format}-${shortHash}`,
  });
}

function quarantineKey(
  tenantId: TenantId,
  filename: string,
  detectedMime: string,
  quarantineId: string,
): TenantScopedKey {
  const stem = stripExtension(filename);
  const ext = extensionForMime(detectedMime) ?? 'bin';
  return Object.freeze({
    tenantId,
    namespace: capturedNamespace(),
    key: `captured/${stem}-${quarantineId}.${ext}`,
  });
}

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return filename;
  return filename.slice(0, dot);
}

function extensionForMime(mime: string): string | null {
  for (const fmt of IMAGE_FORMATS) {
    if (MIME_BY_FORMAT[fmt] === mime) return fmt;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Module-level error-code set — closed union membership check.
// ---------------------------------------------------------------------------

const PIPELINE_ERROR_CODES: ReadonlySet<MediaPipelineErrorCode> = new Set([
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
]);

function matchesPipelineCode(value: unknown): value is MediaPipelineErrorCode {
  return typeof value === 'string' && PIPELINE_ERROR_CODES.has(value as MediaPipelineErrorCode);
}

// ---------------------------------------------------------------------------
// Pipeline implementation
// ---------------------------------------------------------------------------

/**
 * `GovernedMediaPipelineImpl` — the canonical implementation of the
 * `GovernedMediaPipeline` interface declared in
 * `./blob-store.js`. The class is exported under its real name so the
 * package `index.ts` can re-export it under any preferred alias.
 *
 * Video is rejected at the input boundary with
 * `E_VIDEO_MUTATION_FORBIDDEN`. Video reads remain the caller's
 * responsibility via the BlobStore API.
 */
export class GovernedMediaPipelineImpl implements GovernedMediaPipeline {
  public readonly config: MediaPipelineConfig;

  constructor(config: MediaPipelineConfig) {
    if (!config) {
      reject('E_INVALID_INPUT', 'config', 'config is required');
    }
    assertLimits(config.limits);
    assertDerivativePlan(config.derivativePlan);
    if (!config.blobStore) {
      reject('E_INVALID_INPUT', 'config', 'blobStore is required');
    }
    if (!config.auth) {
      reject('E_INVALID_INPUT', 'config', 'auth is required');
    }
    if (!config.malwareScanner) {
      reject('E_INVALID_INPUT', 'config', 'malwareScanner is required');
    }
    if (!config.processor) {
      reject('E_INVALID_INPUT', 'config', 'processor is required');
    }
    this.config = Object.freeze({
      blobStore: config.blobStore,
      auth: config.auth,
      malwareScanner: config.malwareScanner,
      processor: config.processor,
      limits: config.limits,
      derivativePlan: assertDerivativePlan(config.derivativePlan),
    });
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Run the pipeline on the supplied input. The returned
   * `MediaPipelineResult` discriminates between `promoted`,
   * `quarantined`, and `rejected` outcomes.
   */
  async ingest(input: MediaPipelineInput): Promise<MediaPipelineResult> {
    // Stage 0: structural validation. Failures are request errors
    // and never reach the quarantine stage.
    let validated:
      | {
          readonly identity: MediaPipelineIdentity;
          readonly declaredMime: DeclaredMime;
          readonly sanitizedFilename: string;
          readonly alt: {
            readonly decorative: boolean;
            readonly en: string | null;
            readonly es: string | null;
          };
          readonly bytes: Uint8Array;
          readonly plan: readonly MediaPipelineDerivativePlanSpec[];
        }
      | null = null;
    try {
      validated = this.#validateInput(input);
    } catch (err) {
      return this.#rejectionFromError(err, 'request');
    }
    if (!validated) {
      // Unreachable; the validator always returns or throws.
      return this.#rejectionFromError(
        new PipelineAssert('E_INVALID_INPUT', 'request', 'validator returned nothing'),
        'request',
      );
    }
    const ctx = validated;

    // Authorization must come AFTER structural validation so we never
    // leak identity hints (e.g. timing) on malformed input.
    try {
      this.#authorize(ctx.identity);
    } catch (_err) {
      // Auth failures always surface as E_AUTH_REQUIRED. The injected
      // gate is the authority; the pipeline re-types the rejection.
      return this.#rejectionFromError(
        new PipelineAssert('E_AUTH_REQUIRED', 'auth', 'authorize refused this identity'),
        'auth',
      );
    }

    // Stage 3: compressed byte cap.
    if (ctx.bytes.length > this.config.limits.maxBytes) {
      return await this.#recordQuarantine({
        ctx,
        code: 'E_BYTES_EXCEEDED',
        stage: 'bytes',
        reason: `compressed bytes ${ctx.bytes.length} > maxBytes ${this.config.limits.maxBytes}`,
      });
    }

    // Stage 4: magic-byte signature.
    const sig = detectSignature(ctx.bytes);
    if (!sig) {
      return await this.#recordQuarantine({
        ctx,
        code: 'E_SIGNATURE_MISMATCH',
        stage: 'signature',
        reason: 'no recognised image signature',
      });
    }
    if (!declaredMatchesDetected(ctx.declaredMime, sig.mime)) {
      return await this.#recordQuarantine({
        ctx,
        detectedMime: sig.mime,
        code: 'E_MIME_SPOOFED',
        stage: 'signature',
        reason: `declared ${ctx.declaredMime} does not match detected ${sig.mime}`,
      });
    }

    // Stage 5: decode + decompression-bomb guard.
    let decoded: { width: number; height: number; hasIccProfile: boolean };
    try {
      decoded = await this.config.processor.decode({ bytes: ctx.bytes });
    } catch (_err) {
      return await this.#recordQuarantine({
        ctx,
        detectedMime: sig.mime,
        code: 'E_PROCESSOR_DECODE_FAILED',
        stage: 'decode',
        reason: 'image decode threw',
      });
    }
    if (
      !Number.isInteger(decoded.width) ||
      !Number.isInteger(decoded.height) ||
      decoded.width < MIN_IMAGE_DIMENSION ||
      decoded.height < MIN_IMAGE_DIMENSION ||
      decoded.width > this.config.limits.maxDimension ||
      decoded.height > this.config.limits.maxDimension
    ) {
      return await this.#recordQuarantine({
        ctx,
        detectedMime: sig.mime,
        code: 'E_DECOMPRESSION_BOMB',
        stage: 'decode',
        reason: `${decoded.width}x${decoded.height} exceeds dimension or pixel budget`,
      });
    }
    const pixelCount = decoded.width * decoded.height;
    if (pixelCount > this.config.limits.maxPixels) {
      return await this.#recordQuarantine({
        ctx,
        detectedMime: sig.mime,
        code: 'E_DECOMPRESSION_BOMB',
        stage: 'decode',
        reason: `pixel count ${pixelCount} > maxPixels ${this.config.limits.maxPixels}`,
      });
    }

    // Stage 5b: crop/focal validation (before scan for cheap, cheap
    // rejects that don't pollute the scanner).
    let validatedFocal: MediaPipelineFocal | null;
    let validatedCrop: MediaPipelineCrop | null;
    try {
      validatedFocal = assertFocal(input.focal, ctx.alt.decorative);
      validatedCrop = assertCrop(
        input.crop,
        ctx.alt.decorative,
        decoded.width,
        decoded.height,
      );
    } catch (err) {
      return await this.#quarantineFromError(err, ctx, sig.mime);
    }

    // Stage 6: malware scan — fail closed.
    let scanResult: { clean: boolean; reason?: string };
    try {
      scanResult = await this.config.malwareScanner.scan({
        tenantId: ctx.identity.tenantId,
        bytes: ctx.bytes,
        declaredMime: ctx.declaredMime,
      });
    } catch (_err) {
      return await this.#recordQuarantine({
        ctx,
        detectedMime: sig.mime,
        code: 'E_MALWARE_SCAN_UNAVAILABLE',
        stage: 'scanner',
        reason: 'scanner threw',
      });
    }

    // A "clean but unavailable" verdict is not a clean verdict. The
    // scanner signals it surfaced no finding yet, and the pipeline
    // must refuse silent softening. Fail closed with the same
    // unavailable code as a thrown scanner; preserve the specific
    // reason so operators can distinguish transport failure from
    // backend degraded mode.
    if (scanResult.clean === true && scanResult.reason === 'unavailable') {
      return await this.#recordQuarantine({
        ctx,
        detectedMime: sig.mime,
        code: 'E_MALWARE_SCAN_UNAVAILABLE',
        stage: 'scanner',
        reason: `scanner unavailable: ${scanResult.reason}`,
      });
    }
    if (scanResult.clean !== true) {
      return await this.#recordQuarantine({
        ctx,
        detectedMime: sig.mime,
        code: 'E_MALWARE_DETECTED',
        stage: 'scanner',
        reason: scanResult.reason ?? 'scanner verdict != clean',
      });
    }

    // Stage 7-8: encode and attest the complete derivative set before
    // exposing any object in the published namespace.
    const prepared: Array<{
      readonly spec: MediaPipelineDerivativePlanSpec;
      readonly bytes: Uint8Array;
      readonly sha: string;
      readonly storageKey: TenantScopedKey;
    }> = [];
    for (const spec of ctx.plan) {
      const encodeOut = await this.#encodeAndAttest({
        ctx,
        decoded,
        spec,
        validatedCrop,
        sigMime: sig.mime,
      });
      if (!encodeOut.ok) {
        return encodeOut.failure;
      }
      const sha = await sha256HexAsync(encodeOut.encoded.bytes);
      prepared.push({
        spec,
        bytes: encodeOut.encoded.bytes,
        sha,
        storageKey: publishedDerivativeKey(
          ctx.identity.tenantId,
          ctx.sanitizedFilename,
          spec.width,
          spec.format,
          sha,
        ),
      });
    }

    // Stage 9: promote only after every derivative passed validation.
    // Roll back any partial promotion before returning a failure.
    const derivatives: MediaPipelineDerivative[] = [];
    const promotedKeys: TenantScopedKey[] = [];
    for (const item of prepared) {
      try {
        const stored = await this.config.blobStore.put(item.storageKey, item.bytes, {
          contentType: MIME_BY_FORMAT[item.spec.format],
          atomic: true,
        });
        promotedKeys.push(stored.key);
        derivatives.push(
          Object.freeze({
            kind: 'responsive',
            width: item.spec.width,
            format: item.spec.format,
            hash: item.sha,
            sizeBytes: stored.sizeBytes,
            storageKey: stored.key,
          }),
        );
      } catch (_err) {
        const cleanupFailures: string[] = [];
        for (const promotedKey of promotedKeys.reverse()) {
          try {
            await this.config.blobStore.delete(promotedKey);
          } catch (cleanupError) {
            cleanupFailures.push(
              `${promotedKey.key}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
          }
        }
        return await this.#recordQuarantine({
          ctx,
          detectedMime: sig.mime,
          code: 'E_INVALID_INPUT',
          stage: 'publish',
          reason:
            cleanupFailures.length === 0
              ? `derivative ${item.spec.width}px ${item.spec.format} put failed; partial promotion rolled back`
              : `derivative promotion failed and cleanup requires reconciliation: ${cleanupFailures.join('; ')}`,
        });
      }
    }

    if (derivatives.length === 0) {
      return await this.#recordQuarantine({
        ctx,
        detectedMime: sig.mime,
        code: 'E_PROCESSOR_ENCODE_FAILED',
        stage: 'publish',
        reason: 'no derivatives were produced',
      });
    }

    // Stage 11: success. The canonical key is the largest-width
    // derivative (sorted ascending in plan; last one wins).
    const canonical = derivatives[derivatives.length - 1]?.storageKey;
    if (!canonical) {
      return await this.#recordQuarantine({
        ctx,
        detectedMime: sig.mime,
        code: 'E_PROCESSOR_ENCODE_FAILED',
        stage: 'publish',
        reason: 'canonical derivative missing',
      });
    }

    const attestation: MediaPipelineAttestation = Object.freeze({
      iccPreserved: true,
      privacyExifStripped: true,
    });

    const success: MediaPipelineSuccess = Object.freeze({
      kind: 'promoted',
      canonical,
      derivatives: Object.freeze(derivatives),
      attestation,
      width: decoded.width,
      height: decoded.height,
      alt: ctx.alt,
      focal: validatedFocal,
      crop: validatedCrop,
    });
    return success;
  }

  /** Video mutation is explicitly outside V1; callers may only read video blobs. */
  async runVideo(_input: MediaPipelineInput): Promise<MediaPipelineResult> {
    return Object.freeze({
      kind: 'rejected',
      code: 'E_VIDEO_MUTATION_FORBIDDEN',
      stage: 'request',
      reason: 'video mutation is read-only in V1',
    });
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  #validateInput(input: MediaPipelineInput): {
    readonly identity: MediaPipelineIdentity;
    readonly declaredMime: DeclaredMime;
    readonly sanitizedFilename: string;
    readonly alt: {
      readonly decorative: boolean;
      readonly en: string | null;
      readonly es: string | null;
    };
    readonly bytes: Uint8Array;
    readonly plan: readonly MediaPipelineDerivativePlanSpec[];
  } {
    if (!input || typeof input !== 'object') {
      reject('E_INVALID_INPUT', 'request', 'input is required');
    }
    const identity = this.#assertIdentity(input.identity);
    if (input.tenantId !== identity.tenantId) {
      reject(
        'E_CROSS_TENANT',
        'request',
        `input tenant ${input.tenantId} does not match identity tenant ${identity.tenantId}`,
      );
    }
    const declaredMime = assertDeclaredMime(input.declaredMime);
    const sanitizedFilename = assertFilename(input.originalFilename);
    const alt = assertAlt(input.alt);
    const bytes = bytesToUint8(input.bytes);
    const plan = assertDerivativePlan(this.config.derivativePlan);
    if (input.crop !== undefined && alt.decorative) {
      reject('E_CROP_OUT_OF_BOUNDS', 'crop', 'decorative images must not carry crop');
    }
    if (input.focal !== undefined && alt.decorative) {
      reject('E_FOCAL_OUT_OF_BOUNDS', 'focal', 'decorative images must not carry focal point');
    }
    return Object.freeze({
      identity,
      declaredMime,
      sanitizedFilename,
      alt,
      bytes,
      plan,
    });
  }

  #assertIdentity(identity: MediaPipelineIdentity): MediaPipelineIdentity {
    if (!identity || typeof identity !== 'object') {
      reject('E_AUTH_REQUIRED', 'auth', 'identity is required');
    }
    if (typeof identity.actorId !== 'string' || identity.actorId.length === 0) {
      reject('E_AUTH_REQUIRED', 'auth', 'identity.actorId is required');
    }
    if (typeof identity.tenantId !== 'string' || identity.tenantId.length === 0) {
      reject('E_AUTH_REQUIRED', 'auth', 'identity.tenantId is required');
    }
    if (identity.kind !== 'human' && identity.kind !== 'service') {
      reject('E_AUTH_REQUIRED', 'auth', `identity.kind invalid: ${String(identity.kind)}`);
    }
    return identity;
  }

  #authorize(identity: MediaPipelineIdentity): void {
    // Delegate to the injected auth surface.
    this.config.auth.requireHuman(identity);
  }

  async #encodeAndAttest(args: {
    readonly ctx: {
      readonly identity: MediaPipelineIdentity;
      readonly declaredMime: DeclaredMime;
      readonly sanitizedFilename: string;
      readonly alt: {
        readonly decorative: boolean;
        readonly en: string | null;
        readonly es: string | null;
      };
      readonly bytes: Uint8Array;
      readonly plan: readonly MediaPipelineDerivativePlanSpec[];
    };
    readonly decoded: { width: number; height: number; hasIccProfile: boolean };
    readonly spec: MediaPipelineDerivativePlanSpec;
    readonly validatedCrop: MediaPipelineCrop | null;
    readonly sigMime: string;
  }): Promise<
    | { readonly ok: false; readonly failure: MediaPipelineFailure }
    | {
        readonly ok: true;
        readonly encoded: {
          readonly bytes: Uint8Array;
          readonly width: number;
          readonly height: number;
          readonly iccPreserved: boolean;
          readonly privacyExifStripped: boolean;
        };
      }
  > {
    const { ctx, decoded, spec, validatedCrop, sigMime } = args;
    let encoded: {
      bytes: Uint8Array;
      width: number;
      height: number;
      iccPreserved: boolean;
      privacyExifStripped: boolean;
    };
    try {
      encoded = await this.config.processor.encode({
        bytes: ctx.bytes,
        width: decoded.width,
        height: decoded.height,
        format: spec.format,
        ...(validatedCrop !== null ? { crop: validatedCrop } : {}),
      });
    } catch (_err) {
      return {
        ok: false,
        failure: await this.#recordQuarantine({
          ctx,
          detectedMime: sigMime,
          code: 'E_PROCESSOR_ENCODE_FAILED',
          stage: 'encode',
          reason: 'image encode threw',
        }),
      };
    }
    if (encoded.iccPreserved !== true) {
      return {
        ok: false,
        failure: await this.#recordQuarantine({
          ctx,
          detectedMime: sigMime,
          code: 'E_ICC_ATTESTATION_MISSING',
          stage: 'attestation',
          reason: 'processor did not attest ICC preservation',
        }),
      };
    }
    if (encoded.privacyExifStripped !== true) {
      return {
        ok: false,
        failure: await this.#recordQuarantine({
          ctx,
          detectedMime: sigMime,
          code: 'E_EXIF_ATTESTATION_MISSING',
          stage: 'attestation',
          reason: 'processor did not attest privacy-EXIF stripping',
        }),
      };
    }
    if (
      !Number.isInteger(encoded.width) ||
      !Number.isInteger(encoded.height) ||
      encoded.width <= 0 ||
      encoded.height <= 0 ||
      encoded.width > this.config.limits.maxDimension ||
      encoded.height > this.config.limits.maxDimension ||
      encoded.bytes.length > this.config.limits.maxBytes
    ) {
      return {
        ok: false,
        failure: await this.#recordQuarantine({
          ctx,
          detectedMime: sigMime,
          code: 'E_PROCESSOR_ENCODE_FAILED',
          stage: 'attestation',
          reason: 'processor returned invalid dimensions or oversized bytes',
        }),
      };
    }
    return Object.freeze({ ok: true, encoded });
  }

  async #recordQuarantine(args: {
    readonly ctx: {
      readonly identity: MediaPipelineIdentity;
      readonly declaredMime: DeclaredMime;
      readonly sanitizedFilename: string;
      readonly alt: {
        readonly decorative: boolean;
        readonly en: string | null;
        readonly es: string | null;
      };
      readonly bytes: Uint8Array;
      readonly plan: readonly MediaPipelineDerivativePlanSpec[];
    };
    readonly detectedMime?: string;
    readonly code: MediaPipelineErrorCode;
    readonly stage: string;
    readonly reason: string;
  }): Promise<MediaPipelineFailure> {
    const id = nextQuarantineId();
    const qKey = quarantineKey(
      args.ctx.identity.tenantId,
      args.ctx.sanitizedFilename,
      args.detectedMime ?? args.ctx.declaredMime,
      id,
    );
    // Quarantine storage is mandatory. A storage failure to record
    // does NOT mask the original pipeline code; we surface it as a
    // separate `E_INVALID_INPUT` with the storage error as cause. The
    // caller still sees `kind: 'quarantined'` and the original code is
    // preserved when storage succeeds.
    try {
      await this.config.blobStore.put(qKey, args.ctx.bytes, {
        contentType: args.detectedMime ?? args.ctx.declaredMime,
        atomic: true,
      });
    } catch (storageErr) {
      const failure: MediaPipelineFailure = Object.freeze({
        kind: 'rejected',
        code: 'E_INVALID_INPUT',
        stage: 'quarantine-storage',
        reason: `quarantine storage refused: ${storageErr instanceof Error ? storageErr.message : String(storageErr)}`,
      });
      return failure;
    }
    const failure: MediaPipelineFailure = Object.freeze({
      kind: 'quarantined',
      code: args.code,
      stage: args.stage,
      quarantineId: id,
      reason: args.reason,
    });
    return failure;
  }

  #rejectionFromError(err: unknown, stage: string): MediaPipelineFailure {
    if (err instanceof PipelineAssert) {
      const failure: MediaPipelineFailure = Object.freeze({
        kind: 'rejected',
        code: err.code,
        stage,
        reason: err.message,
      });
      return failure;
    }
    if (err instanceof Error) {
      const candidateCode = (err as unknown as { code?: unknown }).code;
      const code: MediaPipelineErrorCode = matchesPipelineCode(candidateCode)
        ? candidateCode
        : 'E_INVALID_INPUT';
      const failure: MediaPipelineFailure = Object.freeze({
        kind: 'rejected',
        code,
        stage,
        reason: err.message,
      });
      return failure;
    }
    const failure: MediaPipelineFailure = Object.freeze({
      kind: 'rejected',
      code: 'E_INVALID_INPUT',
      stage,
      reason: String(err),
    });
    return failure;
  }

  async #quarantineFromError(
    err: unknown,
    ctx: {
      readonly identity: MediaPipelineIdentity;
      readonly declaredMime: DeclaredMime;
      readonly sanitizedFilename: string;
      readonly alt: {
        readonly decorative: boolean;
        readonly en: string | null;
        readonly es: string | null;
      };
      readonly bytes: Uint8Array;
      readonly plan: readonly MediaPipelineDerivativePlanSpec[];
    },
    detectedMime: string,
  ): Promise<MediaPipelineFailure> {
    if (err instanceof PipelineAssert) {
      // The pipeline validator tags message with "stage: reason". The
      // failure's `stage` field carries the original input-bound
      // stage so the caller can branch on it.
      return await this.#recordQuarantine({
        ctx,
        detectedMime,
        code: err.code,
        stage: 'validate',
        reason: err.message,
      });
    }
    return await this.#recordQuarantine({
      ctx,
      detectedMime,
      code: 'E_INVALID_INPUT',
      stage: 'validate',
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function assertDeclaredMime(value: DeclaredMime): DeclaredMime {
  if (typeof value !== 'string' || value.length === 0) {
    reject('E_INVALID_INPUT', 'declaredMime', 'declaredMime is required');
  }
  if (!ACCEPTED_DECLARED_MIME_SET.has(value)) {
    reject('E_MIME_SPOOFED', 'declaredMime', `unsupported declared MIME: ${value}`);
  }
  return value;
}

/**
 * Compare declared vs. detected MIME. Conservative: exact match is
 * required. We refuse `image/jpg` aliasing because the supported
 * declared set does not include it; the caller MUST declare
 * `image/jpeg`.
 */
function declaredMatchesDetected(declared: DeclaredMime, detected: string): boolean {
  if (declared === detected) return true;
  return false;
}

async function sha256HexAsync(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

/** Construction factory. Equivalent to `new GovernedMediaPipelineImpl(config)`. */
export function createGovernedMediaPipeline(
  config: MediaPipelineConfig,
): GovernedMediaPipeline {
  return new GovernedMediaPipelineImpl(config);
}

// ---------------------------------------------------------------------------
// Optional success-payload extensions (carried alongside MediaPipelineSuccess
// when callers opt in).
// ---------------------------------------------------------------------------

/** Extra fields attached by the pipeline to a successful `MediaPipelineSuccess`
 *  when callers opt in via `withDimensions`. The host records these as the
 *  canonical description of the asset. */
export interface SuccessExtras {
  readonly width: number;
  readonly height: number;
  readonly alt: { readonly en: string | null; readonly es: string | null; readonly decorative: boolean };
  readonly focal: MediaPipelineFocal | null;
  readonly crop: MediaPipelineCrop | null;
}

export type SuccessWithExtras = MediaPipelineSuccess & SuccessExtras;

export function withDimensions(
  success: MediaPipelineSuccess,
  extras: SuccessExtras,
): SuccessWithExtras {
  return Object.freeze({
    ...success,
    ...extras,
  });
}
