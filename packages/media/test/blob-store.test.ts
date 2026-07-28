/**
 * Unit tests for `@cms/media/blob-store`.
 *
 * Covers:
 *   - Local filesystem put/get/stat/exists/delete/copy/list semantics.
 *   - Traversal and symlink escape refusal.
 *   - Cross-tenant refusal.
 *   - Namespace semantics (quarantine / published / video).
 *   - Injected S3 client behavior via an in-memory `S3Client` double.
 *   - Contract defaults (deterministic errors, closed error-code union,
 *     tenant-qualified object keys, video read-only).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLOB_STORE_ERROR_CODES,
  BlobStoreError,
  LocalBlobStore,
  S3BlobStore,
  type S3Client,
  type TenantScopedKey,
  brandTenantId,
  tenantObjectKey,
  tenantListPrefix,
  tenantScopedKey,
} from '../src/blob-store.js';

const tenantA = brandTenantId('tenant-a');
const tenantB = brandTenantId('tenant-b');

function fixedNow(at: string): () => Date {
  const iso = at;
  return () => new Date(iso);
}

function inMemoryS3(): S3Client & { buckets: Map<string, Map<string, { body: Uint8Array; contentType: string; etag: string; lastModified: string }>> } {
  const buckets = new Map<string, Map<string, { body: Uint8Array; contentType: string; etag: string; lastModified: string }>>();
  const now = () => '2026-01-01T00:00:00.000Z';
  const etag = (bytes: Uint8Array): string => {
    let hash = 0;
    for (let i = 0; i < bytes.byteLength; i += 1) {
      const byte = bytes[i];
      if (typeof byte !== 'number') {
        continue;
      }
      hash = (hash * 31 + byte) >>> 0;
    }
    return `"${hash.toString(16)}"`;
  };
  const getBucket = (name: string): Map<string, { body: Uint8Array; contentType: string; etag: string; lastModified: string }> => {
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = new Map();
      buckets.set(name, bucket);
    }
    return bucket;
  };
  const client: S3Client & { buckets: typeof buckets } = {
    buckets,
    async putObject(input) {
      const bucket = getBucket(input.bucket);
      if (input.ifNoneMatch === '*' && bucket.has(input.key)) {
        const err = new Error('object already exists');
        (err as { code?: string }).code = 'PreconditionFailed';
        (err as { status?: number }).status = 412;
        throw err;
      }
      bucket.set(input.key, { body: input.body, contentType: input.contentType, etag: etag(input.body), lastModified: now() });
      return { etag: etag(input.body) };
    },
    async getObject(input) {
      const bucket = getBucket(input.bucket);
      const obj = bucket.get(input.key);
      if (!obj) {
        const err = new Error('not found');
        (err as { code?: string }).code = 'NoSuchKey';
        (err as { status?: number }).status = 404;
        throw err;
      }
      return { body: obj.body, contentType: obj.contentType, lastModified: obj.lastModified, etag: obj.etag };
    },
    async headObject(input) {
      const bucket = getBucket(input.bucket);
      const obj = bucket.get(input.key);
      if (!obj) {
        const err = new Error('not found');
        (err as { code?: string }).code = 'NoSuchKey';
        (err as { status?: number }).status = 404;
        throw err;
      }
      return { sizeBytes: obj.body.byteLength, contentType: obj.contentType, lastModified: obj.lastModified, etag: obj.etag };
    },
    async deleteObject(input) {
      const bucket = getBucket(input.bucket);
      bucket.delete(input.key);
    },
    async copyObject(input) {
      const bucket = getBucket(input.bucket);
      const obj = bucket.get(input.sourceKey);
      if (!obj) {
        const err = new Error('not found');
        (err as { code?: string }).code = 'NoSuchKey';
        (err as { status?: number }).status = 404;
        throw err;
      }
      bucket.set(input.destinationKey, { ...obj });
      return { etag: obj.etag };
    },
    async listObjects(input) {
      const bucket = getBucket(input.bucket);
      const matches: { key: string; sizeBytes: number }[] = [];
      for (const [key, value] of bucket) {
        if (key.startsWith(input.prefix)) {
          matches.push({ key, sizeBytes: value.body.byteLength });
        }
      }
      matches.sort((a, b) => a.key.localeCompare(b.key));
      return { keys: matches.slice(0, input.limit), cursor: null };
    },
  };
  return client;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe('@cms/media/blob-store — key and tenant contract', () => {
  it('brands a non-empty tenant id and rejects empty/illegal values', () => {
    const branded = brandTenantId('tenant-a');
    expect(branded).toBe('tenant-a');
    expect(() => brandTenantId('')).toThrow(BlobStoreError);
    expect(() => brandTenantId('a/b')).toThrow(BlobStoreError);
    expect(() => brandTenantId('a\\b')).toThrow(BlobStoreError);
    expect(() => brandTenantId('a\0b')).toThrow(BlobStoreError);
    expect(() => brandTenantId('..')).toThrow(BlobStoreError);
  });

  it('builds a tenant-scoped key and rejects traversal / absolute input', () => {
    const key = tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: 'incoming/photo.jpg' });
    expect(key).toEqual({ tenantId: tenantA, namespace: 'quarantine', key: 'incoming/photo.jpg' });
    expect(tenantObjectKey(key)).toBe('tenant-a/quarantine/incoming/photo.jpg');
    expect(() => tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: '/abs' })).toThrow(BlobStoreError);
    expect(() => tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: '../escape' })).toThrow(BlobStoreError);
    expect(() => tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: 'a/../b' })).toThrow(BlobStoreError);
    expect(() => tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: 'a//b' })).toThrow(BlobStoreError);
    expect(() => tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: '' })).toThrow(BlobStoreError);
  });

  it('exposes a stable, exhaustive BlobStore error-code union', () => {
    expect(BLOB_STORE_ERROR_CODES).toEqual([
      'E_INVALID_KEY',
      'E_CROSS_TENANT',
      'E_NOT_FOUND',
      'E_TRAVERSAL',
      'E_SYMLINK_ESCAPE',
      'E_BYTES_EXCEEDED',
      'E_NOT_IMPLEMENTED',
      'E_BACKEND_FAILURE',
      'E_VIDEO_WRITE_FORBIDDEN',
    ]);
  });
});

describe('@cms/media/blob-store — LocalBlobStore', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cms-media-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('puts, gets, stats, and exists across the published namespace', async () => {
    const store = new LocalBlobStore(tenantA, { root, now: fixedNow('2026-01-01T00:00:00.000Z') });
    const key = tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'hero/landscape.jpg' });
    const body = utf8('binary-image-bytes');

    const put = await store.put(key, body, { contentType: 'image/jpeg' });
    expect(put.sizeBytes).toBe(body.byteLength);
    expect(put.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(put.contentType).toBe('image/jpeg');
    expect(put.lastModifiedAt).toBe('2026-01-01T00:00:00.000Z');

    expect(await store.exists(key)).toBe(true);
    const got = await store.get(key);
    expect(new TextDecoder().decode(got)).toBe('binary-image-bytes');
    const stat = await store.stat(key);
    expect(stat.sizeBytes).toBe(body.byteLength);
    expect(stat.sha256Hex).toBe(put.sha256Hex);
  });

  it('rejects writes to the video namespace and allows reads', async () => {
    const store = new LocalBlobStore(tenantA, { root, now: fixedNow('2026-01-01T00:00:00.000Z') });
    const key = tenantScopedKey({ tenantId: tenantA, namespace: 'video', key: 'clip.mp4' });
    const videoDir = join(root, tenantA, 'video');
    mkdirSync(videoDir, { recursive: true });
    writeFileSync(join(videoDir, 'clip.mp4'), 'existing-video');
    expect(new TextDecoder().decode(await store.get(key))).toBe('existing-video');
    expect((await store.stat(key)).sizeBytes).toBe('existing-video'.length);
    expect(await store.exists(key)).toBe(true);

    await expect(
      store.put(key, utf8('bytes'), { contentType: 'video/mp4' }),
    ).rejects.toMatchObject({ code: 'E_VIDEO_WRITE_FORBIDDEN' });
    await expect(store.delete(key)).rejects.toMatchObject({ code: 'E_VIDEO_WRITE_FORBIDDEN' });
  });

  it('rejects puts larger than the configured maxBytes', async () => {
    const store = new LocalBlobStore(tenantA, { root, maxBytes: 4 });
    const key = tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: 'big.bin' });
    await expect(
      store.put(key, utf8('longer than four bytes'), { contentType: 'application/octet-stream' }),
    ).rejects.toMatchObject({ code: 'E_BYTES_EXCEEDED' });
  });

  it('rejects cross-tenant access at the store boundary', async () => {
    const storeA = new LocalBlobStore(tenantA, { root });
    const keyForB: TenantScopedKey = tenantScopedKey({ tenantId: tenantB, namespace: 'published', key: 'x.jpg' });
    await expect(
      storeA.put(keyForB, utf8('x'), { contentType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'E_CROSS_TENANT' });
    await expect(storeA.get(keyForB)).rejects.toMatchObject({ code: 'E_CROSS_TENANT' });
    await expect(storeA.stat(keyForB)).rejects.toMatchObject({ code: 'E_CROSS_TENANT' });
    await expect(storeA.exists(keyForB)).resolves.toBe(false);
    await expect(storeA.delete(keyForB)).rejects.toMatchObject({ code: 'E_CROSS_TENANT' });
  });

  it('refuses traversal and symlink escape', async () => {
    const store = new LocalBlobStore(tenantA, { root });
    const escapeDir = mkdtempSync(join(tmpdir(), 'cms-media-escape-'));
    try {
      // Build a symlink inside the tenant root that points outside the root.
      const tenantRoot = join(root, tenantA);
      mkdirSync(join(tenantRoot, 'quarantine'), { recursive: true });
      writeFileSync(join(escapeDir, 'secret.bin'), 'secret');
      symlinkSync(join(escapeDir, 'secret.bin'), join(tenantRoot, 'quarantine', 'leak'), 'file');

      const leakingKey = tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: 'leak' });
      let caught: BlobStoreError | null = null;
      try {
        await store.get(leakingKey);
      } catch (err) {
        caught = err as BlobStoreError;
      }
      expect(caught).toBeInstanceOf(BlobStoreError);
      expect(caught?.code === 'E_SYMLINK_ESCAPE' || caught?.code === 'E_TRAVERSAL').toBe(true);

      // Symlink whose target is INSIDE the tenant root must still work.
      const inside = join(tenantRoot, 'quarantine', 'inside.txt');
      writeFileSync(inside, 'inside-data');
      const sym = join(tenantRoot, 'quarantine', 'inside-sym.txt');
      symlinkSync(inside, sym, 'file');
      const insideKey = tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: 'inside-sym.txt' });
      const bytes = await store.get(insideKey);
      expect(new TextDecoder().decode(bytes)).toBe('inside-data');
    } finally {
      rmSync(escapeDir, { recursive: true, force: true });
    }
  });

  it('refuses to follow a directory symlink that escapes the tenant root', async () => {
    const store = new LocalBlobStore(tenantA, { root });
    const escapeDir = mkdtempSync(join(tmpdir(), 'cms-media-escape-'));
    try {
      const tenantRoot = join(root, tenantA);
      mkdirSync(join(tenantRoot, 'quarantine'), { recursive: true });
      writeFileSync(join(escapeDir, 'secret.bin'), 'outside');
      // Symlink the *directory* the store will walk.
      symlinkSync(escapeDir, join(tenantRoot, 'quarantine', 'linked'), 'dir');
      const linkedKey = tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: 'linked/secret.bin' });
      let caught: BlobStoreError | null = null;
      try {
        await store.get(linkedKey);
      } catch (err) {
        caught = err as BlobStoreError;
      }
      expect(caught).toBeInstanceOf(BlobStoreError);
      expect(caught?.code === 'E_SYMLINK_ESCAPE' || caught?.code === 'E_TRAVERSAL').toBe(true);
      // Sanity: ensure the symlink is actually there.
      expect(lstatSync(join(tenantRoot, 'quarantine', 'linked')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(escapeDir, { recursive: true, force: true });
    }
  });

  it('returns deterministic not-found errors', async () => {
    const store = new LocalBlobStore(tenantA, { root });
    const key = tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'missing.jpg' });
    await expect(store.get(key)).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    await expect(store.stat(key)).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    await expect(store.delete(key)).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('copies objects atomically and lists under a prefix', async () => {
    const store = new LocalBlobStore(tenantA, { root });
    const source = tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: 'a.bin' });
    const destination = tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'a.bin' });
    await store.put(source, utf8('copy-me'), { contentType: 'application/octet-stream' });
    const copied = await store.copy(source, destination);
    expect(copied.sizeBytes).toBe('copy-me'.length);
    expect(await store.exists(destination)).toBe(true);
    const list = await store.list(
      tenantListPrefix({ tenantId: tenantA, namespace: 'published' }),
    );
    expect(list.keys.map((k) => k.key)).toEqual(['a.bin']);
    expect(list.cursor).toBeNull();
  });

  it('refuses to copy across tenants', async () => {
    const storeA = new LocalBlobStore(tenantA, { root });
    const source = tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: 'a.bin' });
    const destination: TenantScopedKey = tenantScopedKey({ tenantId: tenantB, namespace: 'published', key: 'a.bin' });
    await storeA.put(source, utf8('x'), { contentType: 'application/octet-stream' });
    await expect(storeA.copy(source, destination)).rejects.toMatchObject({ code: 'E_CROSS_TENANT' });
  });

  it('rejects copy with mismatched source or destination tenant', async () => {
    const storeA = new LocalBlobStore(tenantA, { root });
    const source: TenantScopedKey = tenantScopedKey({ tenantId: tenantB, namespace: 'quarantine', key: 'a.bin' });
    const destination = tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'a.bin' });
    await expect(storeA.copy(source, destination)).rejects.toMatchObject({ code: 'E_CROSS_TENANT' });
  });

  it('refuses to construct with a missing root', () => {
    expect(() => new LocalBlobStore(tenantA, { root: '' })).toThrow(BlobStoreError);
  });

  it('lists objects across namespace subdirectories', async () => {
    const store = new LocalBlobStore(tenantA, { root });
    await store.put(
      tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'a/x.jpg' }),
      utf8('a'),
      { contentType: 'image/jpeg' },
    );
    await store.put(
      tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'a/y.jpg' }),
      utf8('b'),
      { contentType: 'image/jpeg' },
    );
    const list = await store.list(
      tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'a' }),
    );
    expect(list.keys.map((k) => k.key).sort()).toEqual(['a/x.jpg', 'a/y.jpg']);
  });

  it('rejects a non-positive list limit', async () => {
    const store = new LocalBlobStore(tenantA, { root });
    await expect(
      store.list(tenantListPrefix({ tenantId: tenantA, namespace: 'published' }), 0),
    ).rejects.toMatchObject({ code: 'E_INVALID_KEY' });
  });
});

describe('@cms/media/blob-store — S3BlobStore (injected client)', () => {
  it('round-trips objects through the injected client', async () => {
    const client = inMemoryS3();
    const store: S3BlobStore = new S3BlobStore(tenantA, {
      client,
      bucket: 'media-bucket',
      now: fixedNow('2026-01-01T00:00:00.000Z'),
    });
    const key = tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'hero.jpg' });
    const body = utf8('s3-image-bytes');
    const put = await store.put(key, body, { contentType: 'image/jpeg' });
    expect(put.sizeBytes).toBe(body.byteLength);
    expect(put.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.exists(key)).toBe(true);
    const got = await store.get(key);
    expect(new TextDecoder().decode(got)).toBe('s3-image-bytes');
    const head = await store.stat(key);
    expect(head.sizeBytes).toBe(body.byteLength);
    expect(await store.delete(key)).toBeUndefined();
    expect(await store.exists(key)).toBe(false);
  });

  it('refuses to read or write cross-tenant keys', async () => {
    const client = inMemoryS3();
    const storeA: S3BlobStore = new S3BlobStore(tenantA, { client, bucket: 'b' });
    const keyForB: TenantScopedKey = tenantScopedKey({ tenantId: tenantB, namespace: 'published', key: 'x.jpg' });
    await expect(
      storeA.put(keyForB, utf8('x'), { contentType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'E_CROSS_TENANT' });
    await expect(storeA.get(keyForB)).rejects.toMatchObject({ code: 'E_CROSS_TENANT' });
    await expect(storeA.stat(keyForB)).rejects.toMatchObject({ code: 'E_CROSS_TENANT' });
    await expect(storeA.delete(keyForB)).rejects.toMatchObject({ code: 'E_CROSS_TENANT' });
  });

  it('allows existing video reads while refusing video writes and deletes', async () => {
    const client = inMemoryS3();
    const store = new S3BlobStore(tenantA, { client, bucket: 'b' });
    const videoKey = tenantScopedKey({ tenantId: tenantA, namespace: 'video', key: 'clip.mp4' });
    await client.putObject({
      bucket: 'b',
      key: tenantObjectKey(videoKey),
      body: utf8('existing-video'),
      contentType: 'video/mp4',
    });
    expect(new TextDecoder().decode(await store.get(videoKey))).toBe('existing-video');
    expect((await store.stat(videoKey)).sizeBytes).toBe('existing-video'.length);
    await expect(
      store.put(videoKey, utf8('x'), { contentType: 'video/mp4' }),
    ).rejects.toMatchObject({ code: 'E_VIDEO_WRITE_FORBIDDEN' });
    await expect(store.delete(videoKey)).rejects.toMatchObject({ code: 'E_VIDEO_WRITE_FORBIDDEN' });
  });

  it('enforces the bytes-exceeded cap before contacting the client', async () => {
    const client = inMemoryS3();
    let putCalls = 0;
    const wrapped: S3Client = {
      ...client,
      putObject: async (input) => {
        putCalls += 1;
        return client.putObject(input);
      },
    };
    const store = new S3BlobStore(tenantA, { client: wrapped, bucket: 'b', maxBytes: 2 });
    const key = tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'big.bin' });
    await expect(
      store.put(key, utf8('too many bytes'), { contentType: 'application/octet-stream' }),
    ).rejects.toMatchObject({ code: 'E_BYTES_EXCEEDED' });
    expect(putCalls).toBe(0);
  });

  it('copies via the injected client and lists under a prefix', async () => {
    const client = inMemoryS3();
    const store = new S3BlobStore(tenantA, { client, bucket: 'b' });
    const source = tenantScopedKey({ tenantId: tenantA, namespace: 'quarantine', key: 'a.bin' });
    const destination = tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'a.bin' });
    await store.put(source, utf8('copy'), { contentType: 'application/octet-stream' });
    const copied = await store.copy(source, destination);
    expect(copied.sizeBytes).toBe('copy'.length);
    const list = await store.list(
      tenantListPrefix({ tenantId: tenantA, namespace: 'published' }),
    );
    expect(list.keys.map((k) => k.key)).toEqual(['a.bin']);
  });

  it('refuses to construct without a client or bucket', () => {
    expect(() => new S3BlobStore(tenantA, { client: undefined as unknown as S3Client, bucket: 'b' })).toThrow(BlobStoreError);
    expect(() => new S3BlobStore(tenantA, { client: inMemoryS3(), bucket: '' })).toThrow(BlobStoreError);
  });

  it('returns an empty list when the prefix is absent', async () => {
    const client = inMemoryS3();
    const store = new S3BlobStore(tenantA, { client, bucket: 'b' });
    const result = await store.list(
      tenantScopedKey({ tenantId: tenantA, namespace: 'published', key: 'missing' }),
    );
    expect(result.keys).toEqual([]);
    expect(result.cursor).toBeNull();
  });
});

describe('@cms/media/blob-store — symlink probe helpers', () => {
  it('verifies the symlink fixture for the escape test is detectable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cms-media-probe-'));
    try {
      const target = join(dir, 'target.txt');
      writeFileSync(target, 't');
      const link = join(dir, 'link.txt');
      symlinkSync(target, link, 'file');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(target);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
