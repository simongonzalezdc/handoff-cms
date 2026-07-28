/**
 * `@cms/media/blob-store` — pluggable BlobStore contracts and implementations.
 *
 * This module is the only legitimate surface for reading or writing media
 * bytes inside the handoff CMS. It defines:
 *
 *   - `BlobStore`: the abstract storage interface. Every operation takes a
 *     fully-qualified `TenantScopedKey`; the BlobStore refuses any key whose
 *     tenant component does not match the tenant binding the store was
 *     constructed for, so cross-tenant reads and writes are impossible
 *     regardless of caller behaviour.
 *   - `LocalBlobStore`: a filesystem-backed implementation. Resolves every
 *     key against a per-tenant root, refuses path traversal and symlink
 *     escape via `realpath` containment, and reports errors with the closed
 *     `BlobStoreErrorCode` union.
 *   - `S3Client`: a minimal S3-compatible client contract. The package
 *     deliberately does NOT import any cloud SDK; consumers inject a client
 *     that satisfies this surface so we never lock in `@aws-sdk/*` or any
 *     particular mock.
 *   - `S3BlobStore`: an `S3Client`-backed BlobStore. Object keys are formed
 *     from the tenant-qualified `TenantScopedKey` and prefixed with the
 *     bucket name the store was constructed for.
 *
 * Namespace model:
 *   - `quarantine/`: holds inbound media while it is being validated. The
 *     pipeline (a different file) writes here first; on success it copies
 *     the bytes into `published/`. Reads may resolve either namespace, but
 *     callers must request one explicitly via the `ObjectNamespace` field.
 *   - `published/`: the projection of media that has been approved by the
 *     governance flow and is safe to serve. V1 supports reads and writes.
 *   - `video/` is reserved for V1 read-only video. The pipeline refuses
 *     writes; reads are supported for the read-only video surface.
 *
 * Non-goals:
 *   - Canonical CMS content/assets are NOT modeled here. The host repository,
 *     database, or backing CMS remains canonical. This module only stores
 *     the governed projection of media.
 *   - No in-memory or fake BlobStore. A `BlobStore` instance must be backed
 *     by a real filesystem root or a real S3-compatible client. Tests use
 *     the real `LocalBlobStore` against a temporary directory.
 *
 * Error model:
 *   - `BlobStoreError` is the root. Subclasses carry a stable, machine-
 *     readable `code` from `BlobStoreErrorCode` so callers (api/cli/mcp)
 *     can map to localized messages without string matching.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/**
 * Closed union of media namespaces. Quarantine holds pending validation;
 * published is the governed projection; video is V1 read-only.
 */
export type ObjectNamespace = 'quarantine' | 'published' | 'video';

/**
 * Tenant identifier. Stored as a branded string to prevent silent mixing
 * with arbitrary user input at the type level. Callers obtain these from
 * `@cms/storage` governance rows, never from request payloads.
 */
export type TenantId = string & { readonly __brand: 'TenantId' };

/**
 * Brand a string as a `TenantId`. Rejects empty strings and values that
 * contain characters illegal in a single path segment (`/`, `\\`, NUL).
 */
export function brandTenantId(value: string): TenantId {
  if (value.length === 0) {
    throw new BlobStoreError('E_INVALID_KEY', 'tenant id must not be empty');
  }
  if (
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..'
  ) {
    throw new BlobStoreError('E_INVALID_KEY', `tenant id ${JSON.stringify(value)} contains illegal characters`);
  }
  return value as TenantId;
}

/**
 * Tenant-qualified object key. The `tenantId` is the authoritative tenant
 * binding for the object; `namespace` selects the storage class; `key` is
 * the relative object key (a forward-slash path, never absolute, never
 * containing `..` segments).
 */
export interface TenantScopedKey {
  readonly tenantId: TenantId;
  readonly namespace: ObjectNamespace;
  readonly key: string;
}

/**
 * Build a tenant-scoped object key. Keys must be non-empty, relative,
 * traversal-free, and contain no NUL.
 */
export function tenantScopedKey(input: {
  tenantId: TenantId;
  namespace: ObjectNamespace;
  key: string;
}): TenantScopedKey {
  const tenantId = input.tenantId;
  const namespace = input.namespace;
  const key = input.key;
  if (key.length === 0) {
    throw new BlobStoreError('E_INVALID_KEY', 'object key must not be empty');
  }
  if (isAbsolute(key) || key.startsWith('/') || /^[A-Za-z]:[\\/]/.test(key)) {
    throw new BlobStoreError('E_INVALID_KEY', `object key ${JSON.stringify(key)} must be relative`);
  }
  if (key.includes('\0')) {
    throw new BlobStoreError('E_INVALID_KEY', `object key ${JSON.stringify(key)} must not contain NUL`);
  }
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new BlobStoreError('E_INVALID_KEY', `object key ${JSON.stringify(key)} must not contain empty segments`);
    }
    if (segment === '.' || segment === '..') {
      throw new BlobStoreError('E_INVALID_KEY', `object key ${JSON.stringify(key)} must not contain '.' or '..' segments`);
    }
  }
  return { tenantId, namespace, key };
}

/** Build a namespace-scoped list prefix; an empty key lists the namespace root. */
export function tenantListPrefix(input: {
  tenantId: TenantId;
  namespace: ObjectNamespace;
  key?: string;
}): TenantScopedKey {
  const key = input.key ?? '';
  if (key.length === 0) {
    return { tenantId: input.tenantId, namespace: input.namespace, key };
  }
  return tenantScopedKey({ ...input, key });
}

/**
 * Build the canonical object key string for a tenant-scoped key. Format:
 *   `<tenantId>/<namespace>/<key>`
 *
 * The tenant id is the first path segment so cross-tenant access is a
 * structural impossibility at the filesystem level: any operation that
 * resolves a different tenant's key will resolve under a different root.
 */
export function tenantObjectKey(input: TenantScopedKey): string {
  return `${input.tenantId}/${input.namespace}/${input.key}`;
}

/**
 * A single stored object descriptor. Returned by `stat` and embedded in
 * `put` results so callers can attest content without a second round trip.
 */
export interface BlobObject {
  readonly key: TenantScopedKey;
  readonly sizeBytes: number;
  readonly sha256Hex: string;
  readonly contentType: string | null;
  readonly lastModifiedAt: string;
}

/**
 * Read options. `contentType` is asserted by the store when present; the
 * default of `null` skips the check.
 */
export interface BlobReadOptions {
  readonly contentType?: string;
}

/**
 * Result of a `put`. The store returns the canonical descriptor of the
 * stored object so callers can attest content without an extra round trip.
 */
export interface BlobPutOptions {
  readonly contentType: string;
  /**
   * If `true`, the put is atomic: the bytes are written to a sibling
   * temporary file and renamed into place. The default is `true` for the
   * local store; S3 clients are always atomic because object puts either
   * succeed or fail without leaving a partial object visible.
   */
  readonly atomic?: boolean;
}

/**
 * A `BlobStore` is the abstract storage surface. Every operation takes a
 * fully-qualified `TenantScopedKey`; stores are constructed with a single
 * tenant binding and refuse any key whose tenant component does not match.
 */
export interface BlobStore {
  readonly tenantId: TenantId;
  put(key: TenantScopedKey, bytes: Uint8Array, options: BlobPutOptions): Promise<BlobObject>;
  get(key: TenantScopedKey, options?: BlobReadOptions): Promise<Uint8Array>;
  stat(key: TenantScopedKey): Promise<BlobObject>;
  exists(key: TenantScopedKey): Promise<boolean>;
  delete(key: TenantScopedKey): Promise<void>;
  /**
   * Copy an object from one tenant-scoped key to another within the same
   * tenant binding. The default implementation reads and re-writes; S3
   * stores can override with a server-side copy. Throws `E_CROSS_TENANT`
   * if the destination tenant does not match the store's binding.
   */
  copy(source: TenantScopedKey, destination: TenantScopedKey): Promise<BlobObject>;
  /**
   * Enumerate object keys under a prefix. Returns at most `limit` keys
   * (default 1000) and a continuation cursor for the next page. The
   * returned keys are fully qualified and always carry the store's
   * tenant binding, so cross-tenant enumeration is structurally impossible.
   */
  list(prefix: TenantScopedKey, limit?: number): Promise<{ keys: readonly TenantScopedKey[]; cursor: string | null }>;
}

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/**
 * Closed union of stable, machine-readable BlobStore error codes. API,
 * CLI, and MCP layers pattern-match on these codes to render localized
 * messages without string matching.
 */
export type BlobStoreErrorCode =
  | 'E_INVALID_KEY'
  | 'E_CROSS_TENANT'
  | 'E_NOT_FOUND'
  | 'E_TRAVERSAL'
  | 'E_SYMLINK_ESCAPE'
  | 'E_BYTES_EXCEEDED'
  | 'E_NOT_IMPLEMENTED'
  | 'E_BACKEND_FAILURE'
  | 'E_VIDEO_WRITE_FORBIDDEN';

/** Readonly tuple mirror of `BlobStoreErrorCode`, useful for iteration. */
export const BLOB_STORE_ERROR_CODES: readonly BlobStoreErrorCode[] = [
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

/**
 * Root BlobStore error. Subclasses set a stable `code` from the closed
 * union above. The `cause` field carries the original error when wrapping
 * a backend failure.
 */
export class BlobStoreError extends Error {
  public readonly code: BlobStoreErrorCode;
  public override readonly cause?: unknown;

  constructor(code: BlobStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'BlobStoreError';
    this.code = code;
    if (options && 'cause' in options && options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Local filesystem implementation
// ---------------------------------------------------------------------------

export interface LocalBlobStoreOptions {
  /**
   * Filesystem root under which all tenant data is stored. Every key is
   * resolved against `<root>/<tenantId>/<namespace>/<key>`. The store
   * refuses to operate if any resolved path escapes the root via traversal
   * or symlink resolution.
   */
  readonly root: string;
  /**
   * Hard cap on a single object size in bytes. Puts larger than this
   * fail with `E_BYTES_EXCEEDED`. Defaults to 50 MiB, large enough for a
   * 4096-pixel image but small enough to refuse obvious abuse.
   */
  readonly maxBytes?: number;
  /**
   * Caller-supplied clock. Defaults to `() => new Date()`. Tests inject a
   * deterministic clock so `lastModifiedAt` is reproducible.
   */
  readonly now?: () => Date;
}

/**
 * Filesystem-backed BlobStore. Resolves every key against a per-tenant
 * root, refuses path traversal, refuses symlink escape via `realpath`
 * containment, and uses the closed `BlobStoreErrorCode` union.
 */
export class LocalBlobStore implements BlobStore {
  public readonly tenantId: TenantId;
  private readonly rootReal: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(tenantId: TenantId, options: LocalBlobStoreOptions) {
    this.tenantId = tenantId;
    if (!options.root || typeof options.root !== 'string') {
      throw new BlobStoreError('E_INVALID_KEY', 'LocalBlobStore root must be a non-empty string');
    }
    const rootAbs = resolve(options.root);
    let rootReal: string;
    try {
      rootReal = realpathSync(rootAbs);
    } catch (cause) {
      throw new BlobStoreError('E_BACKEND_FAILURE', `LocalBlobStore root ${JSON.stringify(rootAbs)} is not resolvable`, { cause });
    }
    this.rootReal = rootReal;
    try {
      mkdirSync(join(this.rootReal, this.tenantId), { recursive: true });
    } catch (cause) {
      throw new BlobStoreError('E_BACKEND_FAILURE', `unable to create tenant root for ${this.tenantId}`, { cause });
    }
    const tenantRootReal = realpathSync(join(this.rootReal, this.tenantId));
    if (
      tenantRootReal !== this.rootReal &&
      !tenantRootReal.startsWith(`${this.rootReal}${sep}`)
    ) {
      throw new BlobStoreError(
        'E_SYMLINK_ESCAPE',
        `tenant root for ${this.tenantId} resolves outside the configured root`,
      );
    }
    this.maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Resolve a `TenantScopedKey` to an absolute filesystem path and
   * verify the path is contained inside the configured root. Refuses
   * traversal (any `..` segment already caught at key build time, but
   * defended again here) and any symlink that resolves outside the root.
   */
  private resolvePath(key: TenantScopedKey): string {
    if (key.tenantId !== this.tenantId) {
      throw new BlobStoreError(
        'E_CROSS_TENANT',
        `LocalBlobStore bound to tenant ${this.tenantId} cannot access key for tenant ${key.tenantId}`,
      );
    }
    const objectKey = tenantObjectKey(key);
    const tenantRoot = join(this.rootReal, key.tenantId);
    const candidate = join(tenantRoot, key.namespace, key.key);
    const normalizedCandidate = normalize(candidate);
    if (isAbsolute(normalizedCandidate) === false) {
      throw new BlobStoreError('E_INVALID_KEY', `resolved path ${JSON.stringify(normalizedCandidate)} is not absolute`);
    }
    const insideTenant = normalizedCandidate.startsWith(tenantRoot + sep) || normalizedCandidate === tenantRoot;
    if (!insideTenant) {
      throw new BlobStoreError('E_TRAVERSAL', `key ${JSON.stringify(objectKey)} escapes tenant root`);
    }
    return normalizedCandidate;
  }

  /**
   * Walk the resolved path component-by-component, refusing any symlink
   * that points outside the tenant root. Returns the path of the
   * containing directory and the basename once the directory is
   * confirmed to be inside the root.
   */
  private resolveContained(key: TenantScopedKey, candidate: string): { directory: string; base: string } {
    const tenantRoot = join(this.rootReal, key.tenantId);
    let tenantRootReal: string;
    try {
      tenantRootReal = realpathSync(tenantRoot);
    } catch (cause) {
      throw new BlobStoreError('E_BACKEND_FAILURE', `tenant root ${JSON.stringify(tenantRoot)} is not resolvable`, { cause });
    }

    const relativeCandidate = relative(tenantRoot, candidate);
    if (
      relativeCandidate === '..' ||
      relativeCandidate.startsWith(`..${sep}`) ||
      isAbsolute(relativeCandidate)
    ) {
      throw new BlobStoreError('E_TRAVERSAL', `path ${JSON.stringify(candidate)} escapes tenant root`);
    }

    const parts = relativeCandidate.split(sep).filter(Boolean);
    const base = basename(candidate);
    parts.pop();
    let cursor = tenantRootReal;

    for (const part of parts) {
      const next = join(cursor, part);
      try {
        const entry = lstatSync(next);
        if (entry.isSymbolicLink()) {
          let resolvedTarget: string;
          try {
            resolvedTarget = realpathSync(next);
          } catch (cause) {
            throw new BlobStoreError('E_SYMLINK_ESCAPE', `symlink at ${JSON.stringify(next)} is unresolvable`, { cause });
          }
          if (
            resolvedTarget !== tenantRootReal &&
            !resolvedTarget.startsWith(`${tenantRootReal}${sep}`)
          ) {
            throw new BlobStoreError(
              'E_SYMLINK_ESCAPE',
              `path component ${JSON.stringify(next)} resolves outside tenant root`,
            );
          }
          cursor = resolvedTarget;
        } else {
          cursor = next;
        }
      } catch (cause) {
        if (cause instanceof BlobStoreError) throw cause;
        const error = cause as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
          cursor = next;
          continue;
        }
        throw new BlobStoreError('E_BACKEND_FAILURE', `unable to stat ${JSON.stringify(next)}`, { cause });
      }
    }

    return { directory: cursor, base };
  }

  /**
   * Verify that the directory portion of a path is itself a real
   * directory inside the tenant root, with no symlink escape. Used after
   * `resolvePath` to ensure that an existing directory tree is contained.
   */
  private verifyContainedDir(candidate: string, key: TenantScopedKey): boolean {
    const directory = dirname(candidate);
    const base = candidate.slice(directory.length + 1);
    const { directory: resolvedDir, base: resolvedBase } = this.resolveContained(key, join(directory, base));
    if (resolvedBase !== base) {
      throw new BlobStoreError('E_SYMLINK_ESCAPE', `path ${JSON.stringify(candidate)} resolves to a different name`);
    }
    try {
      const directoryStat = statSync(resolvedDir);
      if (!directoryStat.isDirectory()) {
        throw new BlobStoreError('E_SYMLINK_ESCAPE', `path ${JSON.stringify(resolvedDir)} is not a directory`);
      }
    } catch (cause) {
      if (cause instanceof BlobStoreError) throw cause;
      const error = cause as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return false;
      throw new BlobStoreError('E_BACKEND_FAILURE', `unable to stat directory ${JSON.stringify(resolvedDir)}`, { cause });
    }

    try {
      const candidateStat = lstatSync(candidate);
      if (candidateStat.isSymbolicLink()) {
        const resolvedCandidate = realpathSync(candidate);
        const tenantRootReal = realpathSync(join(this.rootReal, key.tenantId));
        if (
          resolvedCandidate !== tenantRootReal &&
          !resolvedCandidate.startsWith(`${tenantRootReal}${sep}`)
        ) {
          throw new BlobStoreError(
            'E_SYMLINK_ESCAPE',
            `object ${JSON.stringify(candidate)} resolves outside tenant root`,
          );
        }
      }
    } catch (cause) {
      if (cause instanceof BlobStoreError) throw cause;
      const error = cause as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        throw new BlobStoreError('E_BACKEND_FAILURE', `unable to validate ${JSON.stringify(candidate)}`, { cause });
      }
    }
    return true;
  }

  async put(key: TenantScopedKey, bytes: Uint8Array, options: BlobPutOptions): Promise<BlobObject> {
    if (key.key.length === 0) {
      throw new BlobStoreError('E_INVALID_KEY', 'put requires a non-empty object key');
    }
    if (key.namespace === 'video') {
      throw new BlobStoreError('E_VIDEO_WRITE_FORBIDDEN', 'video namespace is read-only in V1');
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new BlobStoreError(
        'E_BYTES_EXCEEDED',
        `object of ${bytes.byteLength} bytes exceeds max ${this.maxBytes}`,
      );
    }
    const candidate = this.resolvePath(key);
    const directory = dirname(candidate);
    const base = candidate.slice(directory.length + 1);
    const { directory: resolvedDir, base: resolvedBase } = this.resolveContained(key, join(directory, base));
    if (resolvedBase !== base) {
      throw new BlobStoreError('E_SYMLINK_ESCAPE', `put target ${JSON.stringify(candidate)} resolves to a different name`);
    }
    try {
      mkdirSync(resolvedDir, { recursive: true });
    } catch (cause) {
      throw new BlobStoreError('E_BACKEND_FAILURE', `unable to create directory ${JSON.stringify(resolvedDir)}`, { cause });
    }
    const tempPath = join(resolvedDir, `.${base}.${process.pid}.${Date.now()}.tmp`);
    const sha256 = createHash('sha256');
    sha256.update(bytes);
    const hex = sha256.digest('hex');
    try {
      const fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      try {
        writeFileSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      if (options.atomic === false) {
        try {
          rmSync(candidate, { force: true });
        } catch (cause) {
          const err = cause as NodeJS.ErrnoException;
          if (!err || err.code !== 'ENOENT') {
            throw new BlobStoreError('E_BACKEND_FAILURE', `unable to remove existing object ${JSON.stringify(candidate)}`, { cause });
          }
        }
        try {
          renameSync(tempPath, candidate);
        } catch (cause) {
          throw new BlobStoreError('E_BACKEND_FAILURE', `unable to rename ${JSON.stringify(tempPath)} to ${JSON.stringify(candidate)}`, { cause });
        }
      } else {
        try {
          renameSync(tempPath, candidate);
        } catch (cause) {
          const err = cause as NodeJS.ErrnoException;
          if (err && err.code === 'EEXIST') {
            try {
              rmSync(candidate, { force: true });
            } catch (rmCause) {
              throw new BlobStoreError('E_BACKEND_FAILURE', `unable to remove existing object ${JSON.stringify(candidate)}`, { cause: rmCause });
            }
            try {
              renameSync(tempPath, candidate);
            } catch (renameCause) {
              throw new BlobStoreError('E_BACKEND_FAILURE', `unable to rename ${JSON.stringify(tempPath)} to ${JSON.stringify(candidate)} after replace`, { cause: renameCause });
            }
          } else {
            throw new BlobStoreError('E_BACKEND_FAILURE', `unable to rename ${JSON.stringify(tempPath)} to ${JSON.stringify(candidate)}`, { cause });
          }
        }
      }
    } catch (cause) {
      if (cause instanceof BlobStoreError) {
        throw cause;
      }
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore cleanup failures
      }
      throw new BlobStoreError('E_BACKEND_FAILURE', `unable to write ${JSON.stringify(candidate)}`, { cause });
    }
    if (!this.verifyContainedDir(candidate, key)) {
      throw new BlobStoreError('E_BACKEND_FAILURE', `written object directory disappeared for ${JSON.stringify(candidate)}`);
    }
    return {
      key,
      sizeBytes: bytes.byteLength,
      sha256Hex: hex,
      contentType: options.contentType,
      lastModifiedAt: this.now().toISOString(),
    };
  }

  async get(key: TenantScopedKey, _options?: BlobReadOptions): Promise<Uint8Array> {
    const candidate = this.resolvePath(key);
    if (!this.verifyContainedDir(candidate, key)) {
      throw new BlobStoreError('E_NOT_FOUND', `object ${JSON.stringify(tenantObjectKey(key))} not found`);
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(candidate);
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err && err.code === 'ENOENT') {
        throw new BlobStoreError('E_NOT_FOUND', `object ${JSON.stringify(tenantObjectKey(key))} not found`);
      }
      throw new BlobStoreError('E_BACKEND_FAILURE', `unable to stat ${JSON.stringify(candidate)}`, { cause });
    }
    if (stat.isDirectory()) {
      throw new BlobStoreError('E_NOT_FOUND', `object ${JSON.stringify(tenantObjectKey(key))} not found`);
    }
    if (stat.size > this.maxBytes) {
      throw new BlobStoreError('E_BYTES_EXCEEDED', `object ${JSON.stringify(tenantObjectKey(key))} exceeds max ${this.maxBytes}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(candidate);
    } catch (cause) {
      throw new BlobStoreError('E_BACKEND_FAILURE', `unable to read ${JSON.stringify(candidate)}`, { cause });
    }
    return bytes;
  }

  async stat(key: TenantScopedKey): Promise<BlobObject> {
    const candidate = this.resolvePath(key);
    if (!this.verifyContainedDir(candidate, key)) {
      throw new BlobStoreError('E_NOT_FOUND', `object ${JSON.stringify(tenantObjectKey(key))} not found`);
    }
    let lstat: ReturnType<typeof lstatSync>;
    try {
      lstat = lstatSync(candidate);
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err && err.code === 'ENOENT') {
        throw new BlobStoreError('E_NOT_FOUND', `object ${JSON.stringify(tenantObjectKey(key))} not found`);
      }
      throw new BlobStoreError('E_BACKEND_FAILURE', `unable to stat ${JSON.stringify(candidate)}`, { cause });
    }
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      throw new BlobStoreError('E_NOT_FOUND', `object ${JSON.stringify(tenantObjectKey(key))} not found`);
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(candidate);
    } catch (cause) {
      throw new BlobStoreError('E_BACKEND_FAILURE', `unable to read ${JSON.stringify(candidate)}`, { cause });
    }
    const sha256 = createHash('sha256');
    sha256.update(bytes);
    return {
      key,
      sizeBytes: lstat.size,
      sha256Hex: sha256.digest('hex'),
      contentType: null,
      lastModifiedAt: lstat.mtime.toISOString(),
    };
  }

  async exists(key: TenantScopedKey): Promise<boolean> {
    try {
      const candidate = this.resolvePath(key);
      const entry = lstatSync(candidate);
      if (entry.isSymbolicLink()) {
        this.verifyContainedDir(candidate, key);
        return statSync(candidate).isFile();
      }
      return entry.isFile();
    } catch {
      return false;
    }
  }

  async delete(key: TenantScopedKey): Promise<void> {
    if (key.namespace === 'video') {
      throw new BlobStoreError('E_VIDEO_WRITE_FORBIDDEN', 'video namespace is read-only in V1');
    }
    const candidate = this.resolvePath(key);
    if (!this.verifyContainedDir(candidate, key)) {
      throw new BlobStoreError('E_NOT_FOUND', `object ${JSON.stringify(tenantObjectKey(key))} not found`);
    }
    try {
      const lstat = lstatSync(candidate);
      if (lstat.isDirectory()) {
        throw new BlobStoreError('E_NOT_FOUND', `object ${JSON.stringify(tenantObjectKey(key))} not found`);
      }
      unlinkSync(candidate);
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err && err.code === 'ENOENT') {
        throw new BlobStoreError('E_NOT_FOUND', `object ${JSON.stringify(tenantObjectKey(key))} not found`);
      }
      if (cause instanceof BlobStoreError) {
        throw cause;
      }
      throw new BlobStoreError('E_BACKEND_FAILURE', `unable to delete ${JSON.stringify(candidate)}`, { cause });
    }
  }

  async copy(source: TenantScopedKey, destination: TenantScopedKey): Promise<BlobObject> {
    if (source.tenantId !== this.tenantId || destination.tenantId !== this.tenantId) {
      throw new BlobStoreError('E_CROSS_TENANT', 'LocalBlobStore copy is restricted to a single tenant');
    }
    const bytes = await this.get(source);
    return this.put(destination, bytes, { contentType: 'application/octet-stream', atomic: true });
  }

  async list(
    prefix: TenantScopedKey,
    limit: number = 1000,
  ): Promise<{ keys: readonly TenantScopedKey[]; cursor: string | null }> {
    if (limit <= 0) {
      throw new BlobStoreError('E_INVALID_KEY', 'list limit must be a positive integer');
    }
    const candidate = this.resolvePath(prefix);
    if (!this.verifyContainedDir(candidate, prefix)) {
      return { keys: [], cursor: null };
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(candidate);
    } catch {
      return { keys: [], cursor: null };
    }
    if (!stat.isDirectory()) {
      return { keys: [], cursor: null };
    }
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(candidate, { withFileTypes: true });
    const collected: TenantScopedKey[] = [];
    const relativePrefix = prefix.key;
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const childCandidate = join(candidate, entry.name);
      let isFile = entry.isFile();
      let isSymlink = entry.isSymbolicLink();
      if (isSymlink) {
        let realChild: string;
        try {
          realChild = realpathSync(childCandidate);
        } catch {
          continue;
        }
        const tenantRoot = join(this.rootReal, prefix.tenantId);
        const insideRoot = realChild === tenantRoot || realChild.startsWith(tenantRoot + sep);
        if (!insideRoot) {
          continue;
        }
        let realStat: ReturnType<typeof statSync>;
        try {
          realStat = statSync(realChild);
        } catch {
          continue;
        }
        isFile = realStat.isFile();
      }
      if (!isFile) {
        continue;
      }
      const childKey = relativePrefix.length === 0 ? entry.name : `${relativePrefix}/${entry.name}`;
      collected.push({
        tenantId: prefix.tenantId,
        namespace: prefix.namespace,
        key: childKey,
      });
      if (collected.length >= limit) {
        break;
      }
    }
    collected.sort((a, b) => a.key.localeCompare(b.key));
    return { keys: collected, cursor: null };
  }
}

// ---------------------------------------------------------------------------
// S3-compatible client contract
// ---------------------------------------------------------------------------

/**
 * Minimal S3-compatible client contract. The package deliberately does
 * NOT import any cloud SDK; consumers inject a client that satisfies this
 * surface. Methods are async so S3, R2, MinIO, and test doubles all
 * satisfy the same shape.
 */
export interface S3Client {
  /**
   * Upload an object. `body` is the raw bytes. Returns the ETag reported
   * by the server, or `null` if the server does not report one. `ifNoneMatch`
   * is passed through as the `If-None-Match` header when the caller wants
   * an atomic conditional put.
   */
  putObject(input: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
    ifNoneMatch?: string;
  }): Promise<{ etag: string | null }>;

  /**
   * Download an object. Throws if the object does not exist; callers
   * translate the error to `E_NOT_FOUND` via the `S3BlobStore` wrapper.
   */
  getObject(input: { bucket: string; key: string }): Promise<{
    body: Uint8Array;
    contentType: string | null;
    lastModified: string | null;
    etag: string | null;
  }>;

  /**
   * Head an object. Throws if the object does not exist; the wrapper
   * translates the error to `E_NOT_FOUND`.
   */
  headObject(input: { bucket: string; key: string }): Promise<{
    sizeBytes: number;
    contentType: string | null;
    lastModified: string | null;
    etag: string | null;
  }>;

  /**
   * Delete an object. Idempotent: returns normally even if the object is
   * absent. `S3BlobStore.delete` re-checks via `headObject` when callers
   * need strict existence semantics.
   */
  deleteObject(input: { bucket: string; key: string }): Promise<void>;

  /**
   * Server-side copy. Returns the destination ETag. Throws if the source
   * does not exist; the wrapper translates the error to `E_NOT_FOUND`.
   */
  copyObject(input: { bucket: string; sourceKey: string; destinationKey: string }): Promise<{ etag: string | null }>;

  /**
   * List objects under a prefix. Returns up to `limit` keys and a
   * continuation token for the next page. The wrapper translates
   * not-found errors to an empty list.
   */
  listObjects(input: {
    bucket: string;
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<{ keys: readonly { key: string; sizeBytes: number }[]; cursor: string | null }>;
}

export interface S3BlobStoreOptions {
  readonly client: S3Client;
  readonly bucket: string;
  /**
   * Optional hard cap on a single object size in bytes. Puts larger than
   * this fail with `E_BYTES_EXCEEDED`. Defaults to 50 MiB.
   */
  readonly maxBytes?: number;
  /**
   * Caller-supplied clock. Defaults to `() => new Date()`. Tests inject a
   * deterministic clock so `lastModifiedAt` is reproducible.
   */
  readonly now?: () => Date;
}

/**
 * S3-backed BlobStore. The store is bound to a single tenant at
 * construction time; every key's `tenantId` MUST match the binding.
 * Object keys are formed as `<tenantId>/<namespace>/<key>` and prefixed
 * with the configured bucket. The package imports no cloud SDK; consumers
 * inject a client that satisfies the `S3Client` contract.
 */
export class S3BlobStore implements BlobStore {
  public readonly tenantId: TenantId;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(tenantId: TenantId, options: S3BlobStoreOptions) {
    this.tenantId = tenantId;
    if (!options.client) {
      throw new BlobStoreError('E_INVALID_KEY', 'S3BlobStore requires a client');
    }
    if (!options.bucket || typeof options.bucket !== 'string') {
      throw new BlobStoreError('E_INVALID_KEY', 'S3BlobStore requires a non-empty bucket');
    }
    this.client = options.client;
    this.bucket = options.bucket;
    this.maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
    this.now = options.now ?? ((): Date => new Date());
  }

  private assertTenant(key: TenantScopedKey): void {
    if (key.tenantId !== this.tenantId) {
      throw new BlobStoreError(
        'E_CROSS_TENANT',
        `S3BlobStore bound to tenant ${this.tenantId} cannot access key for tenant ${key.tenantId}`,
      );
    }
  }

  private toObjectKey(key: TenantScopedKey): string {
    return tenantObjectKey(key);
  }

  private fromObjectKey(objectKey: string, namespace: ObjectNamespace): TenantScopedKey {
    const expectedPrefix = `${this.tenantId}/${namespace}/`;
    if (!objectKey.startsWith(expectedPrefix)) {
      throw new BlobStoreError('E_CROSS_TENANT', `object key ${JSON.stringify(objectKey)} is not under tenant namespace`);
    }
    const suffix = objectKey.slice(expectedPrefix.length);
    return tenantScopedKey({ tenantId: this.tenantId, namespace, key: suffix });
  }

  async put(key: TenantScopedKey, bytes: Uint8Array, options: BlobPutOptions): Promise<BlobObject> {
    this.assertTenant(key);
    if (key.namespace === 'video') {
      throw new BlobStoreError('E_VIDEO_WRITE_FORBIDDEN', 'video namespace is read-only in V1');
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new BlobStoreError(
        'E_BYTES_EXCEEDED',
        `object of ${bytes.byteLength} bytes exceeds max ${this.maxBytes}`,
      );
    }
    const objectKey = this.toObjectKey(key);
    try {
      await this.client.putObject({
        bucket: this.bucket,
        key: objectKey,
        body: bytes,
        contentType: options.contentType,
        ...(options.atomic === false ? {} : { ifNoneMatch: '*' }),
      });
    } catch (cause) {
      throw new BlobStoreError('E_BACKEND_FAILURE', `S3 put failed for ${JSON.stringify(objectKey)}`, { cause });
    }
    const sha256 = createHash('sha256');
    sha256.update(bytes);
    return {
      key,
      sizeBytes: bytes.byteLength,
      sha256Hex: sha256.digest('hex'),
      contentType: options.contentType,
      lastModifiedAt: this.now().toISOString(),
    };
  }

  async get(key: TenantScopedKey, _options?: BlobReadOptions): Promise<Uint8Array> {
    this.assertTenant(key);
    const objectKey = this.toObjectKey(key);
    try {
      const result = await this.client.getObject({ bucket: this.bucket, key: objectKey });
      return result.body;
    } catch (cause) {
      const wrapped = this.translateError(cause, objectKey);
      if (wrapped) throw wrapped;
      throw new BlobStoreError('E_BACKEND_FAILURE', `S3 get failed for ${JSON.stringify(objectKey)}`, { cause });
    }
  }

  async stat(key: TenantScopedKey): Promise<BlobObject> {
    this.assertTenant(key);
    const objectKey = this.toObjectKey(key);
    try {
      const object = await this.client.getObject({ bucket: this.bucket, key: objectKey });
      const sha256 = createHash('sha256');
      sha256.update(object.body);
      return {
        key,
        sizeBytes: object.body.byteLength,
        sha256Hex: sha256.digest('hex'),
        contentType: object.contentType,
        lastModifiedAt: object.lastModified ?? this.now().toISOString(),
      };
    } catch (cause) {
      const wrapped = this.translateError(cause, objectKey);
      if (wrapped) throw wrapped;
      throw new BlobStoreError('E_BACKEND_FAILURE', `S3 stat failed for ${JSON.stringify(objectKey)}`, { cause });
    }
  }

  async exists(key: TenantScopedKey): Promise<boolean> {
    this.assertTenant(key);
    const objectKey = this.toObjectKey(key);
    try {
      await this.client.headObject({ bucket: this.bucket, key: objectKey });
      return true;
    } catch (cause) {
      const wrapped = this.translateError(cause, objectKey);
      if (wrapped && wrapped.code === 'E_NOT_FOUND') {
        return false;
      }
      if (wrapped) {
        throw wrapped;
      }
      return false;
    }
  }

  async delete(key: TenantScopedKey): Promise<void> {
    this.assertTenant(key);
    if (key.namespace === 'video') {
      throw new BlobStoreError('E_VIDEO_WRITE_FORBIDDEN', 'video namespace is read-only in V1');
    }
    const objectKey = this.toObjectKey(key);
    try {
      await this.client.deleteObject({ bucket: this.bucket, key: objectKey });
    } catch (cause) {
      const wrapped = this.translateError(cause, objectKey);
      if (wrapped) throw wrapped;
      throw new BlobStoreError('E_BACKEND_FAILURE', `S3 delete failed for ${JSON.stringify(objectKey)}`, { cause });
    }
  }

  async copy(source: TenantScopedKey, destination: TenantScopedKey): Promise<BlobObject> {
    this.assertTenant(source);
    this.assertTenant(destination);
    if (source.namespace === 'video' || destination.namespace === 'video') {
      throw new BlobStoreError('E_VIDEO_WRITE_FORBIDDEN', 'video namespace is read-only in V1');
    }
    const sourceKey = this.toObjectKey(source);
    const destinationKey = this.toObjectKey(destination);
    try {
      await this.client.copyObject({
        bucket: this.bucket,
        sourceKey,
        destinationKey,
      });
    } catch (cause) {
      const wrapped = this.translateError(cause, destinationKey);
      if (wrapped) throw wrapped;
      throw new BlobStoreError('E_BACKEND_FAILURE', `S3 copy failed for ${JSON.stringify(destinationKey)}`, { cause });
    }
    return this.stat(destination);
  }

  async list(
    prefix: TenantScopedKey,
    limit: number = 1000,
  ): Promise<{ keys: readonly TenantScopedKey[]; cursor: string | null }> {
    this.assertTenant(prefix);
    if (limit <= 0) {
      throw new BlobStoreError('E_INVALID_KEY', 'list limit must be a positive integer');
    }
    const objectPrefix = this.toObjectKey(prefix);
    try {
      const result = await this.client.listObjects({
        bucket: this.bucket,
        prefix: objectPrefix,
        limit,
      });
      const keys: TenantScopedKey[] = [];
      for (const entry of result.keys) {
        const keySuffix = entry.key.slice(objectPrefix.length);
        if (keySuffix.length === 0) {
          continue;
        }
        keys.push(this.fromObjectKey(entry.key, prefix.namespace));
      }
      return { keys, cursor: result.cursor };
    } catch (cause) {
      const wrapped = this.translateError(cause, objectPrefix);
      if (wrapped && wrapped.code === 'E_NOT_FOUND') {
        return { keys: [], cursor: null };
      }
      if (wrapped) throw wrapped;
      throw new BlobStoreError('E_BACKEND_FAILURE', `S3 list failed for ${JSON.stringify(objectPrefix)}`, { cause });
    }
  }

  /**
   * Map a backend-specific error to a `BlobStoreError`. Returns `null`
   * when the cause is not a not-found-style error and the caller should
   * re-raise as `E_BACKEND_FAILURE`.
   */
  private translateError(cause: unknown, objectKey: string): BlobStoreError | null {
    if (cause instanceof BlobStoreError) {
      return cause;
    }
    const err = cause as { name?: string; code?: string; status?: number; $metadata?: { httpStatusCode?: number } };
    const code = err?.code ?? err?.name;
    const status = err?.status ?? err?.$metadata?.httpStatusCode;
    if (code === 'NoSuchKey' || code === 'NotFound' || status === 404) {
      return new BlobStoreError('E_NOT_FOUND', `object ${JSON.stringify(objectKey)} not found`, { cause });
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Image media field contracts
// ---------------------------------------------------------------------------

/** Closed union of supported image output formats. */
export type ImageFormat = 'webp' | 'jpeg' | 'png' | 'avif';

/**
 * Closed union of supported MIME types accepted at the pipeline boundary.
 * The pipeline asserts declared MIME against the detector output and
 * refuses mismatches with `E_MIME_SPOOFED`.
 */
export type DeclaredMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/avif'
  | 'image/gif'
  | 'video/mp4'
  | 'video/webm';

/**
 * Alt-text contract. Peer locales `en` and `es` are first-class; an image
 * may be `decorative` (in which case alt is forbidden in both locales) or
 * informative (in which case both peer locales MUST be present).
 */
export interface MediaPipelineInputAlt {
  readonly en?: string;
  readonly es?: string;
  readonly decorative?: boolean;
}

/**
 * Focal point in normalized 0..1 coordinates. `(0, 0)` is the top-left
 * corner; `(1, 1)` is the bottom-right. The pipeline refuses out-of-range
 * values with `E_FOCAL_OUT_OF_BOUNDS`.
 */
export interface MediaPipelineFocal {
  readonly x: number;
  readonly y: number;
}

/**
 * Crop region in pixel coordinates relative to the source image. The
 * pipeline refuses out-of-range crops with `E_CROP_OUT_OF_BOUNDS`.
 */
export interface MediaPipelineCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Limits enforced by the pipeline before any processing. */
export interface MediaPipelineLimits {
  readonly maxBytes: number;
  readonly maxPixels: number;
  readonly maxDimension: number;
}

/**
 * A single responsive derivative spec. The pipeline emits one stored
 * derivative per spec, each with a unique `width` and `format`.
 */
export interface MediaPipelineDerivativePlanSpec {
  readonly width: number;
  readonly format: ImageFormat;
}

/**
 * A single responsive derivative produced by the pipeline. `storageKey`
 * is the fully-qualified `TenantScopedKey` for the stored derivative.
 */
export interface MediaPipelineDerivative {
  readonly kind: 'responsive';
  readonly width: number;
  readonly format: ImageFormat;
  readonly hash: string;
  readonly sizeBytes: number;
  readonly storageKey: TenantScopedKey;
}

/**
 * Attestation that the pipeline preserved ICC profiles and stripped
 * privacy-EXIF metadata. The pipeline MUST set both flags to `true` on
 * success; absence of either flag is a hard error.
 */
export interface MediaPipelineAttestation {
  readonly iccPreserved: boolean;
  readonly privacyExifStripped: boolean;
}

/** A quarantine entry recorded when the pipeline rejects media. */
export interface MediaPipelineQuarantineEntry {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly storageKey: TenantScopedKey;
  readonly declaredMime: DeclaredMime;
  readonly detectedMime: string;
  readonly sizeBytes: number;
  readonly originalFilename: string;
  readonly capturedAt: string;
}

/** Successful pipeline result. The pipeline promotes bytes to `published/`. */
export interface MediaPipelineSuccess {
  readonly kind: 'promoted';
  readonly canonical: TenantScopedKey;
  readonly derivatives: readonly MediaPipelineDerivative[];
  readonly attestation: MediaPipelineAttestation;
  readonly width: number;
  readonly height: number;
  readonly alt: {
    readonly en: string | null;
    readonly es: string | null;
    readonly decorative: boolean;
  };
  readonly focal: MediaPipelineFocal | null;
  readonly crop: MediaPipelineCrop | null;
}

/** Failure pipeline result. `quarantined` is recorded; `rejected` is not. */
export interface MediaPipelineFailure {
  readonly kind: 'quarantined' | 'rejected';
  readonly code: MediaPipelineErrorCode;
  readonly stage: string;
  readonly quarantineId?: string;
  readonly reason: string;
}

/** Result union for a pipeline ingest call. */
export type MediaPipelineResult = MediaPipelineSuccess | MediaPipelineFailure;

/**
 * Closed union of stable, machine-readable pipeline error codes. API,
 * CLI, and MCP layers pattern-match on these codes to render localized
 * messages without string matching.
 */
export type MediaPipelineErrorCode =
  | 'E_AUTH_REQUIRED'
  | 'E_CROSS_TENANT'
  | 'E_FILENAME_UNSAFE'
  | 'E_MIME_SPOOFED'
  | 'E_SIGNATURE_MISMATCH'
  | 'E_BYTES_EXCEEDED'
  | 'E_DECOMPRESSION_BOMB'
  | 'E_MALWARE_DETECTED'
  | 'E_MALWARE_SCAN_UNAVAILABLE'
  | 'E_ALT_MISSING_PEER_LOCALE'
  | 'E_CROP_OUT_OF_BOUNDS'
  | 'E_FOCAL_OUT_OF_BOUNDS'
  | 'E_ICC_ATTESTATION_MISSING'
  | 'E_EXIF_ATTESTATION_MISSING'
  | 'E_VIDEO_MUTATION_FORBIDDEN'
  | 'E_PROCESSOR_DECODE_FAILED'
  | 'E_PROCESSOR_ENCODE_FAILED'
  | 'E_INVALID_INPUT';

/** Readonly tuple mirror of `MediaPipelineErrorCode`. */
export const MEDIA_PIPELINE_ERROR_CODES: readonly MediaPipelineErrorCode[] = [
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

/** Pipeline error. Carries a stable `code` from the closed union above. */
export class MediaPipelineError extends Error {
  public readonly code: MediaPipelineErrorCode;
  public override readonly cause?: unknown;

  constructor(code: MediaPipelineErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'MediaPipelineError';
    this.code = code;
    if (options && 'cause' in options && options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Injected malware-scanner contract. The pipeline refuses to operate
 * without a scanner; `scan` returns a verdict. A scanner that cannot
 * reach its backend MUST throw with `E_MALWARE_SCAN_UNAVAILABLE`.
 */
export interface MalwareScanner {
  scan(input: { tenantId: TenantId; bytes: Uint8Array; declaredMime: DeclaredMime }): Promise<{ clean: boolean; reason?: string }>;
}

/**
 * Injected image processor contract. The pipeline refuses to operate
 * without a processor; the processor MUST emit `MediaPipelineAttestation`
 * and refuse to encode when it cannot preserve ICC or strip privacy-EXIF.
 */
export interface MediaImageProcessor {
  decode(input: { bytes: Uint8Array }): Promise<{
    width: number;
    height: number;
    hasIccProfile: boolean;
  }>;
  encode(input: {
    bytes: Uint8Array;
    width: number;
    height: number;
    format: ImageFormat;
    crop?: MediaPipelineCrop;
  }): Promise<{
    bytes: Uint8Array;
    width: number;
    height: number;
    iccPreserved: boolean;
    privacyExifStripped: boolean;
  }>;
}

/** Authenticated identity used by the pipeline. */
export interface MediaPipelineIdentity {
  readonly actorId: string;
  readonly tenantId: TenantId;
  readonly kind: 'human' | 'service';
}

/**
 * Pipeline configuration. All four injected services are required; the
 * pipeline refuses to operate without them.
 */
export interface MediaPipelineConfig {
  readonly blobStore: BlobStore;
  readonly auth: { requireHuman(input: MediaPipelineIdentity): void };
  readonly malwareScanner: MalwareScanner;
  readonly processor: MediaImageProcessor;
  readonly limits: MediaPipelineLimits;
  readonly derivativePlan: readonly MediaPipelineDerivativePlanSpec[];
}

/**
 * Pipeline input. `bytes` is the raw source bytes; the pipeline never
 * trusts the caller's declared MIME and runs its own signature check.
 */
export interface MediaPipelineInput {
  readonly tenantId: TenantId;
  readonly identity: MediaPipelineIdentity;
  readonly declaredMime: DeclaredMime;
  readonly originalFilename: string;
  readonly bytes: Uint8Array;
  readonly locale: 'en' | 'es';
  readonly alt: MediaPipelineInputAlt;
  readonly crop?: MediaPipelineCrop;
  readonly focal?: MediaPipelineFocal;
}

/**
 * Governing class symbol. The full implementation lives in
 * `src/pipeline.ts`; this file only re-exports the type so callers can
 * wire dependencies without importing the implementation.
 */
export interface GovernedMediaPipeline {
  readonly config: MediaPipelineConfig;
  ingest(input: MediaPipelineInput): Promise<MediaPipelineResult>;
  runVideo(input: MediaPipelineInput): Promise<MediaPipelineResult>;
}
