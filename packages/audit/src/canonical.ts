/**
 * Deterministic canonical NDJSON serialization.
 *
 * Rules:
 *  - Object keys are sorted lexicographically by UTF-16 code unit order.
 *  - Arrays preserve order.
 *  - Only a closed set of value shapes is accepted:
 *      * finite numbers
 *      * non-empty strings (UTF-8)
 *      * booleans
 *      * null
 *      * arrays of supported values
 *      * plain objects whose values are supported values
 *  - The byte representation never contains literal NaN, Infinity, or undefined.
 *  - BigInt and Symbol are rejected to avoid coercion ambiguity.
 *  - Functions, Dates, Maps, Sets, and any non-plain object prototypes are rejected.
 *
 * Output is the canonical UTF-8 encoding of a single JSON value with no trailing newline.
 *
 * Number canonicalization scope:
 *  - Numbers are serialized via `JSON.stringify`, which on Node 22 emits the
 *    shortest round-trippable decimal form. `assertSupported` rejects NaN
 *    and ±Infinity before encoding; `canonicalJSON` additionally double-checks
 *    the rendered string for residual `NaN`/`Infinity` tokens as defense in
 *    depth. This is the V8/Node 22 behavior; any future change to that
 *    representation (or a port off Node 22) requires re-auditing this scope.
 *
 * Hashing:
 *  - `contentHash` uses Node's synchronous `createHash('sha256')` from
 *    `node:crypto` over the canonical bytes of the value. The bytes are
 *    computed exactly once; the digest is taken over those bytes only.
 */

import { createHash } from 'node:crypto';

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

function assertSupported(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
      if (value.length === 0) {
        throw new CanonicalError(`unsupported empty string at ${path}`);
      }
      return;
    case 'boolean':
      return;
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalError(`unsupported non-finite number at ${path}`);
      }
      return;
    }
    case 'bigint':
      throw new CanonicalError(`unsupported bigint at ${path}`);
    case 'symbol':
      throw new CanonicalError(`unsupported symbol at ${path}`);
    case 'function':
      throw new CanonicalError(`unsupported function at ${path}`);
    case 'undefined':
      throw new CanonicalError(`unsupported undefined at ${path}`);
    case 'object': {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          assertSupported(value[i], `${path}[${i}]`);
        }
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalError(
          `unsupported non-plain object at ${path} (prototype=${proto?.constructor?.name ?? 'null'})`,
        );
      }
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        assertSupported(nested, `${path}.${key}`);
      }
      return;
    }
    default:
      throw new CanonicalError(`unsupported typeof ${typeof value} at ${path}`);
  }
}

function canonicalJSON(value: unknown, path: string): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    const s = JSON.stringify(value);
    if (s === undefined) {
      throw new CanonicalError(`unsupported non-finite number at ${path}`);
    }
    if (/NaN/i.test(s) || /[+-]?Infinity/i.test(s)) {
      throw new CanonicalError(`unsupported non-finite number at ${path}`);
    }
    return s;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      parts.push(canonicalJSON(value[i], `${path}[${i}]`));
    }
    return `[${parts.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${JSON.stringify(k)}:${canonicalJSON(obj[k], `${path}.${k}`)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Encode canonical bytes for the provided value. Validates first.
 */
export function canonicalize(value: unknown): Uint8Array {
  assertSupported(value, '$');
  const json = canonicalJSON(value, '$');
  return new TextEncoder().encode(json);
}

/**
 * Encode canonical bytes for an envelope that is itself a list of events
 * (NDJSON shape). Each event is canonicalized individually. The returned bytes
 * are the concatenation of canonical JSON for each event joined by a single LF
 * byte. There is no trailing newline.
 */
export function canonicalNDJSON(events: readonly unknown[]): Uint8Array {
  if (events.length === 0) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < events.length; i += 1) {
    if (i > 0) chunks.push(new Uint8Array([0x0a]));
    chunks.push(canonicalize(events[i]));
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Lowercase hex SHA-256 of canonical bytes derived from `value`.
 * Throws CanonicalError on unsupported values.
 */
export function contentHash(value: unknown): string {
  const bytes = canonicalize(value);
  return createHash('sha256').update(bytes).digest('hex');
}