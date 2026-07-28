/**
 * Property/adversarial tests for `GovernedMediaPipelineImpl`.
 *
 * Each test wires a real `LocalBlobStore` against a temporary
 * directory (the peer-authored blob store ships with no in-memory
 * fake; tests are expected to use the real `LocalBlobStore`). The
 * malware scanner, image processor, and auth gate are test doubles
 * injected through the `MediaPipelineConfig` shape, exactly as the
 * pipeline consumes them in production.
 *
 * Acceptance cases exercised (from `Acceptance` in the task brief):
 *   - spoofed MIME / signature mismatch
 *   - oversized compressed input
 *   - decompression-bomb input
 *   - malicious scan verdict (and unavailable scanner)
 *   - cross-tenant quarantine record isolation: the pipeline records
 *     quarantine against the input's tenantId only
 *   - missing peer alt locale (and decorative conflict)
 *   - invalid focal point / crop
 *   - missing ICC or EXIF attestation as DISTINCT flags
 *   - video mutation is rejected
 *   - success path produces `kind: 'promoted'` with both attestation
 *     flags `true`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BlobStoreError,
  type BlobObject,
  type BlobStore,
  type DeclaredMime,
  type LocalBlobStoreOptions,
  type MediaImageProcessor,
  type MediaPipelineConfig,
  type MediaPipelineDerivative,
  type MediaPipelineFailure,
  type MediaPipelineLimits,
  type MediaPipelineSuccess,
  LocalBlobStore,
  brandTenantId,
  type TenantId,
} from '../src/blob-store.js';

import { GovernedMediaPipelineImpl } from '../src/pipeline.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PNG_MAGIC: readonly number[] = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC: readonly number[] = Object.freeze([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_RIFF: readonly number[] = Object.freeze([0x52, 0x49, 0x46, 0x46]);
const WEBP_NAME = 'WEBP';

function makePng(opts: { width?: number; height?: number } = {}): Buffer {
  const w = opts.width ?? 32;
  const h = opts.height ?? 32;
  // IHDR chunk: length(4) + 'IHDR'(4) + W(4) + H(4) + flags(5) + crc(4)
  const ihdr = Buffer.alloc(4 + 4 + 4 + 4 + 5 + 4);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 4, 'ascii');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  // The pipeline only needs the 8-byte PNG signature for detection;
  // the IHDR bytes after that don't need a valid CRC for the magic
  // check to pass.
  return Buffer.concat([Buffer.from(PNG_MAGIC), ihdr]);
}

function makeWebp(): Buffer {
  const riff = Buffer.alloc(12);
  // 'RIFF'
  for (let i = 0; i < 4; i++) riff[i] = WEBP_RIFF[i] ?? 0;
  // size (irrelevant for signature detection)
  riff.writeUInt32LE(0, 4);
  riff.write(WEBP_NAME, 8, 4, 'ascii');
  return riff;
}

function makeJpeg(): Buffer {
  return Buffer.from(JPEG_MAGIC);
}

const SCHEMA_TENANT: TenantId = brandTenantId('acme');
const OTHER_TENANT: TenantId = brandTenantId('other');

const STANDARD_LIMITS: MediaPipelineLimits = Object.freeze({
  maxBytes: 1024 * 1024, // 1 MiB
  maxPixels: 4096 * 4096,
  maxDimension: 4096,
});

// ---------------------------------------------------------------------------
// Test doubles — the only ones allowed (auth, scanner, processor)
// ---------------------------------------------------------------------------

class AuthSpy {
  readonly calls: unknown[] = [];
  requireHuman(identity: unknown): void {
    this.calls.push(identity);
    if (
      !identity ||
      typeof identity !== 'object' ||
      (identity as { kind?: string }).kind !== 'human'
    ) {
      throw new Error('service identity forbidden');
    }
  }
}

class RecordingScanner {
  readonly calls: Array<{ bytes: Buffer; declaredMime: DeclaredMime }> = [];
  verdict: { clean: boolean; reason?: string } | Error = { clean: true };
  scan(input: { bytes: Uint8Array; declaredMime: DeclaredMime }): Promise<{
    clean: boolean;
    reason?: string;
  }> {
    this.calls.push({
      bytes: Buffer.from(input.bytes),
      declaredMime: input.declaredMime,
    });
    if (this.verdict instanceof Error) {
      return Promise.reject(this.verdict);
    }
    return Promise.resolve(this.verdict);
  }
}

interface StubEncoding {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly iccPreserved: boolean;
  readonly privacyExifStripped: boolean;
}

class StubImageProcessor implements MediaImageProcessor {
  decodeCalls = 0;
  encodeCalls = 0;
  defaultDecoded = { width: 256, height: 256, hasIccProfile: true };
  failDecode = false;
  failEncode = false;
  defaultEncoded = (): StubEncoding => ({
    bytes: makeWebp(),
    width: this.defaultDecoded.width,
    height: this.defaultDecoded.height,
    iccPreserved: true,
    privacyExifStripped: true,
  });

  decode(input: { bytes: Uint8Array }): Promise<{
    width: number;
    height: number;
    hasIccProfile: boolean;
  }> {
    this.decodeCalls += 1;
    if (this.failDecode) {
      return Promise.reject(new Error('decode failed'));
    }
    return Promise.resolve(this.defaultDecoded);
  }

  encode(input: {
    bytes: Uint8Array;
    width: number;
    height: number;
    format: string;
  }): Promise<{
    bytes: Uint8Array;
    width: number;
    height: number;
    iccPreserved: boolean;
    privacyExifStripped: boolean;
  }> {
    this.encodeCalls += 1;
    if (this.failEncode) {
      return Promise.reject(new Error('encode failed'));
    }
    const enc = this.defaultEncoded();
    return Promise.resolve({
      bytes: enc.bytes,
      width: enc.width,
      height: enc.height,
      iccPreserved: enc.iccPreserved,
      privacyExifStripped: enc.privacyExifStripped,
    });
  }
}

// ---------------------------------------------------------------------------
// Pipeline fixture
// ---------------------------------------------------------------------------

interface Harness {
  readonly pipeline: GovernedMediaPipelineImpl;
  readonly blobStore: BlobStore;
  readonly auth: AuthSpy;
  readonly scanner: RecordingScanner;
  readonly processor: StubImageProcessor;
  readonly tenantId: TenantId;
}

function makeHarness(args?: {
  limits?: MediaPipelineLimits;
  plan?: ReadonlyArray<MediaPipelineConfig['derivativePlan'][number]>;
  tenantId?: TenantId;
  decorateBlobStore?: (store: BlobStore) => BlobStore;
}): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cms-media-pipeline-'));
  TMP_DIRS.push(tmpDir);
  const opts: LocalBlobStoreOptions = {
    root: tmpDir,
    now: () => new Date(0),
  };
  const localBlobStore: BlobStore = new LocalBlobStore(
    args?.tenantId ?? SCHEMA_TENANT,
    opts,
  );
  const blobStore = args?.decorateBlobStore?.(localBlobStore) ?? localBlobStore;
  const auth = new AuthSpy();
  const scanner = new RecordingScanner();
  const processor = new StubImageProcessor();
  const plan = (args?.plan ?? [
    Object.freeze({ width: 1024, format: 'webp' as const }),
    Object.freeze({ width: 480, format: 'webp' as const }),
  ]) as MediaPipelineConfig['derivativePlan'];
  const config: MediaPipelineConfig = {
    blobStore,
    auth: { requireHuman: (id) => auth.requireHuman(id) },
    malwareScanner: scanner,
    processor,
    limits: args?.limits ?? STANDARD_LIMITS,
    derivativePlan: plan,
  };
  const pipeline = new GovernedMediaPipelineImpl(config);
  return {
    pipeline,
    blobStore,
    auth,
    scanner,
    processor,
    tenantId: args?.tenantId ?? SCHEMA_TENANT,
  };
}

function alt(en: string, es: string): { en: string; es: string } {
  return Object.freeze({ en, es });
}

function identity(tenantId: TenantId = SCHEMA_TENANT) {
  return Object.freeze({
    actorId: 'alice',
    tenantId,
    kind: 'human' as const,
  });
}

function serviceIdentity(tenantId: TenantId = SCHEMA_TENANT) {
  return Object.freeze({
    actorId: 'bot',
    tenantId,
    kind: 'service' as const,
  });
}

const TMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TMP_DIRS.splice(0, TMP_DIRS.length)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (_e) {
      // ignore: best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('constructor validation', () => {
  it('refuses missing limits', () => {
    expect(() => {
      new GovernedMediaPipelineImpl({
        blobStore: {} as BlobStore,
        auth: { requireHuman: () => undefined },
        malwareScanner: {} as never,
        processor: {} as never,
        limits: undefined as unknown as MediaPipelineLimits,
        derivativePlan: [Object.freeze({ width: 1024, format: 'webp' as const })],
      });
    }).toThrow(/limits/);
  });

  it('refuses empty derivative plan', () => {
    expect(() => {
      new GovernedMediaPipelineImpl({
        blobStore: {} as BlobStore,
        auth: { requireHuman: () => undefined },
        malwareScanner: {} as never,
        processor: {} as never,
        limits: STANDARD_LIMITS,
        derivativePlan: [],
      });
    }).toThrow(/derivativePlan/);
  });

  it('refuses duplicate derivative specs', () => {
    expect(() => {
      new GovernedMediaPipelineImpl({
        blobStore: {} as BlobStore,
        auth: { requireHuman: () => undefined },
        malwareScanner: {} as never,
        processor: {} as never,
        limits: STANDARD_LIMITS,
        derivativePlan: [
          Object.freeze({ width: 1024, format: 'webp' as const }),
          Object.freeze({ width: 1024, format: 'webp' as const }),
        ],
      });
    }).toThrow(/duplicate/);
  });
});

describe('happy path', () => {
  it('promotes a PNG with both attestation flags set and writes published derivatives', async () => {
    const harness = makeHarness();
    harness.processor.defaultDecoded = { width: 800, height: 600, hasIccProfile: true };
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'hello.png',
      bytes: makePng({ width: 800, height: 600 }),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('promoted');
    if (result.kind !== 'promoted') return;
    expect(result.attestation.iccPreserved).toBe(true);
    expect(result.attestation.privacyExifStripped).toBe(true);
    expect(result.derivatives).toHaveLength(2);
    // Canonical = largest-width derivative.
    expect(result.canonical).toEqual(result.derivatives[1]?.storageKey);

    // Verify derivatives actually landed on disk under `published/`.
    const listing = await harness.blobStore.list(
      { tenantId: harness.tenantId, namespace: 'published', key: 'derived' },
      1000,
    );
    expect(listing.keys.length).toBe(2);
    for (const k of listing.keys) {
      expect(k.namespace).toBe('published');
      expect(k.key.startsWith('derived/')).toBe(true);
    }
    // No quarantine residue.
    const quarantine = await harness.blobStore.list(
      { tenantId: harness.tenantId, namespace: 'quarantine', key: 'captured' },
      1000,
    );
    expect(quarantine.keys.length).toBe(0);

    // Scanner saw the bytes exactly once.
    expect(harness.scanner.calls).toHaveLength(1);
    expect(harness.scanner.calls[0]?.declaredMime).toBe('image/png');

    // Auth gate was called once with the human identity.
    expect(harness.auth.calls).toHaveLength(1);
    expect(harness.auth.calls[0]).toMatchObject({ kind: 'human' });
  });

  it('removes earlier published derivatives when a later promotion fails', async () => {
    let publishedPuts = 0;
    const harness = makeHarness({
      decorateBlobStore: (base): BlobStore => ({
        tenantId: base.tenantId,
        put: async (key, bytes, options) => {
          if (key.namespace === 'published' && ++publishedPuts === 2) {
            throw new Error('injected second promotion failure');
          }
          return base.put(key, bytes, options);
        },
        get: (key, options) => base.get(key, options),
        stat: (key) => base.stat(key),
        exists: (key) => base.exists(key),
        delete: (key) => base.delete(key),
        copy: (source, destination) => base.copy(source, destination),
        list: (prefix, limit) => base.list(prefix, limit),
      }),
    });

    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'rollback.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Rollback', 'Reversión'),
    });

    expect(result.kind).toBe('quarantined');
    const published = await harness.blobStore.list(
      { tenantId: harness.tenantId, namespace: 'published', key: 'derived' },
      1000,
    );
    expect(published.keys).toEqual([]);
  });
});

describe('input boundary rejections (no quarantine recorded)', () => {
  it('rejects service identity at auth with E_AUTH_REQUIRED', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: serviceIdentity(),
      declaredMime: 'image/png',
      originalFilename: 'hello.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_AUTH_REQUIRED');
    expect(result.stage).toBe('auth');
    // Scanner must NOT have been invoked.
    expect(harness.scanner.calls).toHaveLength(0);
  });

  it('rejects unsafe filename with E_FILENAME_UNSAFE', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: '../etc/passwd',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_FILENAME_UNSAFE');
  });

  it('rejects filename starting with a dot with E_FILENAME_UNSAFE', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: '.hidden.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_FILENAME_UNSAFE');
  });

  it('rejects filename with NUL byte with E_FILENAME_UNSAFE', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'hel\x00lo.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_FILENAME_UNSAFE');
  });

  it('rejects oversize filename with E_FILENAME_UNSAFE', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a'.repeat(201) + '.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_FILENAME_UNSAFE');
  });

  it('rejects unrecognised declared MIME with E_MIME_SPOOFED', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/gif',
      originalFilename: 'pic.gif',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_MIME_SPOOFED');
  });
});

describe('signature and MIME adversarial cases', () => {
  it('quarantines when signature is unrecognised with E_SIGNATURE_MISMATCH', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'foo.png',
      bytes: Buffer.from('not-an-image'),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_SIGNATURE_MISMATCH');
    expect(typeof result.quarantineId).toBe('string');
    expect(result.quarantineId).toMatch(/^q-/);
  });

  it('quarantines when declared MIME is spoofed (declared jpeg, bytes are png) with E_MIME_SPOOFED', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/jpeg',
      originalFilename: 'foo.jpg',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_MIME_SPOOFED');
  });

  it('quarantines WebP bytes when declared as avif with E_MIME_SPOOFED', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/avif',
      originalFilename: 'foo.avif',
      bytes: makeWebp(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_MIME_SPOOFED');
  });

  it('accepts a JPEG with valid JPEG signature', async () => {
    const harness = makeHarness();
    harness.processor.defaultDecoded = { width: 256, height: 256, hasIccProfile: true };
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/jpeg',
      originalFilename: 'foo.jpg',
      bytes: makeJpeg(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('promoted');
  });
});

describe('size and bomb guards', () => {
  it('quarantines oversize compressed bytes with E_BYTES_EXCEEDED', async () => {
    const harness = makeHarness({
      limits: { maxBytes: 8, maxPixels: 4096 * 4096, maxDimension: 4096 },
    });
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'hello.png',
      bytes: makePng({ width: 256, height: 256 }),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_BYTES_EXCEEDED');
  });

  it('quarantines a decompression bomb with E_DECOMPRESSION_BOMB', async () => {
    const harness = makeHarness({
      limits: { maxBytes: 1024 * 1024, maxPixels: 1024 * 1024, maxDimension: 4096 },
    });
    // Processor reports huge decoded dimensions.
    harness.processor.defaultDecoded = {
      width: 80000,
      height: 80000,
      hasIccProfile: true,
    };
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'bomb.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_DECOMPRESSION_BOMB');
  });

  it('quarantines when decode throws with E_PROCESSOR_DECODE_FAILED', async () => {
    const harness = makeHarness();
    harness.processor.failDecode = true;
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'corrupt.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_PROCESSOR_DECODE_FAILED');
  });
});

describe('malware scanner — fail closed', () => {
  it('quarantines with E_MALWARE_DETECTED on a clean=false verdict', async () => {
    const harness = makeHarness();
    harness.scanner.verdict = { clean: false, reason: 'EICAR-Test-File' };
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'infected.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_MALWARE_DETECTED');
    expect(result.reason).toMatch(/EICAR/);
  });

  it('quarantines with E_MALWARE_SCAN_UNAVAILABLE when scanner throws', async () => {
    const harness = makeHarness();
    harness.scanner.verdict = new Error('backend down');
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_MALWARE_SCAN_UNAVAILABLE');
  });

  it('accepts a clean verdict and encodes every derivative', async () => {
    const harness = makeHarness();
    harness.scanner.verdict = { clean: true };
    harness.processor.defaultDecoded = { width: 32, height: 32, hasIccProfile: true };
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('promoted');
    // Two derivatives in the plan → two encode calls.
    expect(harness.processor.encodeCalls).toBe(2);
    expect(harness.scanner.calls).toHaveLength(1);

  });

  it('quarantines with E_MALWARE_SCAN_UNAVAILABLE on clean=true with reason=unavailable (no encoding, no promotion)', async () => {
    const harness = makeHarness();
    harness.scanner.verdict = { clean: true, reason: 'unavailable' };
    harness.processor.defaultDecoded = { width: 32, height: 32, hasIccProfile: true };
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'softened.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_MALWARE_SCAN_UNAVAILABLE');
    expect(result.stage).toBe('scanner');
    expect(result.reason).toMatch(/unavailable/);
    // Regression: the softened verdict must not be silently promoted.
    // No derivative encoding and no published-namespace writes.
    expect(harness.processor.encodeCalls).toBe(0);
    const listing = await harness.blobStore.list(
      { tenantId: harness.tenantId, namespace: 'published', key: 'derived' },
      1000,
    );
    const softenedPublished = listing.keys.filter((k) => k.key.includes('softened'));
    expect(softenedPublished).toHaveLength(0);

  });

});

describe('peer locale alt validation', () => {
  it('rejects before storage with E_ALT_MISSING_PEER_LOCALE when ES is missing', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: { en: 'Hello' },
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_ALT_MISSING_PEER_LOCALE');
  });

  it('rejects before storage with E_ALT_MISSING_PEER_LOCALE when EN is missing', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: { es: 'Hola' },
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_ALT_MISSING_PEER_LOCALE');
  });

  it('rejects before storage with E_ALT_MISSING_PEER_LOCALE when both are empty', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: { en: '   ', es: '' },
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_ALT_MISSING_PEER_LOCALE');
  });

  it('accepts decorative images with neither locale populated', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'decorative.png',
      bytes: makePng(),
      locale: 'en',
      alt: { decorative: true },
    });
    expect(result.kind).toBe('promoted');
  });

  it('refuses decorative images that carry alt text', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'decorative-with-alt.png',
      bytes: makePng(),
      locale: 'en',
      alt: { en: 'pretty', es: 'linda', decorative: true },
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_ALT_MISSING_PEER_LOCALE');
  });
});

describe('focal + crop bounds', () => {
  it('quarantines with E_FOCAL_OUT_OF_BOUNDS when x < 0', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
      focal: Object.freeze({ x: -0.1, y: 0.5 }),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_FOCAL_OUT_OF_BOUNDS');
  });

  it('quarantines with E_FOCAL_OUT_OF_BOUNDS when y > 1', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
      focal: Object.freeze({ x: 0.5, y: 1.5 }),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_FOCAL_OUT_OF_BOUNDS');
  });

  it('rejects a decorative image with a focal point before storage', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: { decorative: true },
      focal: Object.freeze({ x: 0.5, y: 0.5 }),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_FOCAL_OUT_OF_BOUNDS');
  });

  it('quarantines with E_CROP_OUT_OF_BOUNDS when crop exceeds decoded dimensions', async () => {
    const harness = makeHarness();
    harness.processor.defaultDecoded = { width: 32, height: 32, hasIccProfile: true };
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
      crop: Object.freeze({ x: 0, y: 0, width: 100, height: 100 }),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_CROP_OUT_OF_BOUNDS');
  });

  it('rejects a decorative image with a crop before storage', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: { decorative: true },
      crop: Object.freeze({ x: 0, y: 0, width: 5, height: 5 }),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_CROP_OUT_OF_BOUNDS');
  });

  it('accepts valid focal + crop within decoded bounds and emits both attestation flags', async () => {
    const harness = makeHarness();
    harness.processor.defaultDecoded = { width: 1024, height: 768, hasIccProfile: true };
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
      focal: Object.freeze({ x: 0.5, y: 0.5 }),
      crop: Object.freeze({ x: 0, y: 0, width: 100, height: 100 }),
    });
    expect(result.kind).toBe('promoted');
    if (result.kind !== 'promoted') return;
    expect(result.attestation.iccPreserved).toBe(true);
    expect(result.attestation.privacyExifStripped).toBe(true);
    expect(result.focal).toEqual({ x: 0.5, y: 0.5 });
    expect(result.crop).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(result.alt).toEqual({ en: 'Hello', es: 'Hola', decorative: false });
  });
});

describe('attestation — DISTINCT flags', () => {
  it('quarantines with E_ICC_ATTESTATION_MISSING when only EXIF is attested', async () => {
    const harness = makeHarness({
      plan: [Object.freeze({ width: 480, format: 'webp' as const })],
    });
    harness.processor.defaultEncoded = (): StubEncoding => ({
      bytes: makeWebp(),
      width: 256,
      height: 256,
      iccPreserved: false,
      privacyExifStripped: true,
    });
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_ICC_ATTESTATION_MISSING');
  });

  it('quarantines with E_EXIF_ATTESTATION_MISSING when only ICC is attested', async () => {
    const harness = makeHarness({
      plan: [Object.freeze({ width: 480, format: 'webp' as const })],
    });
    harness.processor.defaultEncoded = (): StubEncoding => ({
      bytes: makeWebp(),
      width: 256,
      height: 256,
      iccPreserved: true,
      privacyExifStripped: false,
    });
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_EXIF_ATTESTATION_MISSING');
  });

  it('quarantines with E_PROCESSOR_ENCODE_FAILED when encode throws', async () => {
    const harness = makeHarness();
    harness.processor.failEncode = true;
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'enc.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.code).toBe('E_PROCESSOR_ENCODE_FAILED');
  });
});

describe('video mutation is forbidden in V1', () => {
  it('rejects video MIME on ingest as E_MIME_SPOOFED (image-only ingest)', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'video/mp4',
      originalFilename: 'clip.mp4',
      bytes: Buffer.from([0x00, 0x00, 0x00, 0x20]),
      locale: 'en',
      alt: alt('clip', 'video'),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_MIME_SPOOFED');
  });

  it('rejects video mutation with E_VIDEO_MUTATION_FORBIDDEN', async () => {
    const harness = makeHarness();
    const result = await harness.pipeline.runVideo({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'video/mp4',
      originalFilename: 'clip.mp4',
      bytes: Buffer.from([0x00, 0x00, 0x00, 0x20]),
      locale: 'en',
      alt: { en: 'clip', es: 'video' },
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.code).toBe('E_VIDEO_MUTATION_FORBIDDEN');
  });
});

describe('tenant scoping', () => {
  it('records quarantine under the input tenant and refuses cross-tenant access at the store', async () => {
    const harness = makeHarness();
    harness.scanner.verdict = { clean: false, reason: 'bad' };
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'a.png',
      bytes: makePng(),
      locale: 'en',
      alt: alt('Hello', 'Hola'),
    });
    expect(result.kind).toBe('quarantined');
    // Quarantine under the input tenant.
    const listed = await harness.blobStore.list(
      { tenantId: harness.tenantId, namespace: 'quarantine', key: 'captured' },
      1000,
    );
    expect(listed.keys.length).toBe(1);
    expect(listed.keys[0]?.key.startsWith('captured/')).toBe(true);

    // Cross-tenant attempt is refused by the store itself.
    await expect(
      harness.blobStore.list(
        { tenantId: OTHER_TENANT, namespace: 'quarantine', key: 'captured' },
        1000,
      ),
    ).rejects.toThrow();
  });
});

describe('plan determinism', () => {
  it('produces N derivatives with N >= 1 (one per plan spec) and both attestation flags', async () => {
    const harness = makeHarness({
      plan: [
        Object.freeze({ width: 1024, format: 'webp' as const }),
        Object.freeze({ width: 768, format: 'webp' as const }),
        Object.freeze({ width: 480, format: 'webp' as const }),
      ],
    });
    harness.processor.defaultDecoded = { width: 1024, height: 768, hasIccProfile: true };
    const result = await harness.pipeline.ingest({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png',
      originalFilename: 'hero.png',
      bytes: makePng({ width: 1024, height: 768 }),
      locale: 'en',
      alt: alt('Hero', 'Heroe'),
    });
    expect(result.kind).toBe('promoted');
    if (result.kind !== 'promoted') return;
    expect(result.derivatives).toHaveLength(3);
    expect(result.attestation.iccPreserved).toBe(true);
    expect(result.attestation.privacyExifStripped).toBe(true);
    expect(result.canonical).toEqual(result.derivatives[2]?.storageKey);
    for (const d of result.derivatives) {
      expect(d.storageKey.namespace).toBe('published');
    }
  });

  it('is deterministic on equal input — same plan, same derivative keys', async () => {
    const harness = makeHarness();
    harness.processor.defaultDecoded = { width: 32, height: 32, hasIccProfile: true };
    // Make the encoder deterministic by stripping noise from the
    // default output (already a fixed buffer).
    const makeRequest = () => ({
      tenantId: harness.tenantId,
      identity: identity(),
      declaredMime: 'image/png' as DeclaredMime,
      originalFilename: 'det.png',
      bytes: makePng(),
      locale: 'en' as const,
      alt: alt('det', 'det-es'),
    });
    const a = await harness.pipeline.ingest(makeRequest());
    const b = await harness.pipeline.ingest(makeRequest());
    if (a.kind !== 'promoted' || b.kind !== 'promoted') {
      throw new Error('expected promoted');
    }
    expect(a.derivatives.map((d) => d.storageKey.key)).toEqual(
      b.derivatives.map((d) => d.storageKey.key),
    );
    expect(a.canonical.key).toBe(b.canonical.key);
  });
});

// Compile-time pins: shift the imported types below this line and the
// test file fails to compile before any test runs.
const _typesPinned: BlobStore | BlobObject = undefined as unknown as BlobObject;
const _errPinned: BlobStoreError | undefined = undefined;
const _mediaFailurePinned: MediaPipelineFailure | undefined = undefined;
const _mediaSuccessPinned: MediaPipelineSuccess | undefined = undefined;
const _derivativesPinned: readonly MediaPipelineDerivative[] | undefined = undefined;
void _typesPinned;
void _errPinned;
void _mediaFailurePinned;
void _mediaSuccessPinned;
void _derivativesPinned;
