/**
 * Detached Ed25519 JWS (RFC 7515, RFC 8037).
 *
 * - alg MUST be "EdDSA"
 * - Protected header carries crit: ["b64"] and b64: false
 * - Signing input = ASCII(BASE64URL(protected_header)) || "." || payload
 *   where payload bytes are taken verbatim (RFC 7797, b64:false unencoded payload)
 * - Verification rebuilds the signing input from the canonical bytes provided
 *   by the caller; any deviation in those bytes fails verification.
 *
 * Rejected:
 *  - alg != EdDSA (no algorithm substitution)
 *  - missing or extra crit members
 *  - b64 != false
 *  - any unknown header parameter
 *  - signature bytes that don't validate against the supplied public key
 */

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  KeyObject,
} from 'node:crypto';

export class JwsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwsError';
  }
}

const SUPPORTED_ALG = 'EdDSA';
const CRIT = ['b64'] as const;
const SUPPORTED_PARAMS = new Set(['alg', 'kid', 'crit', 'b64']);

export interface JwsProtectedHeader {
  alg: 'EdDSA';
  kid: string;
  crit: readonly ['b64'];
  b64: false;
}

export interface JwsSignature {
  /** Base64URL(no padding) of the JSON-encoded protected header. */
  protected: string;
  /** Base64URL(no padding) of the raw signature (Ed25519 64-byte output). */
  signature: string;
}

export interface SignOptions {
  /** Key identifier surfaced in the protected header; opaque UTF-8 string. */
  kid: string;
}

export function generateEd25519KeyPair(kid: string): {
  kid: string;
  privateKeyPem: string;
  publicKeyPem: string;
} {
  if (typeof kid !== 'string' || kid.length === 0) {
    throw new JwsError('kid must be a non-empty string');
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  return { kid, privateKeyPem, publicKeyPem };
}

/**
 * Build the protected header JSON string with deterministic key order:
 *   {"alg":"EdDSA","b64":false,"crit":["b64"],"kid":"<kid>"}
 */
function buildProtectedHeader(kid: string): string {
  const header: JwsProtectedHeader = {
    alg: 'EdDSA',
    kid,
    crit: ['b64'],
    b64: false,
  };
  return JSON.stringify(header);
}

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function b64urlDecode(s: string): Uint8Array {
  if (typeof s !== 'string') {
    throw new JwsError('base64url input must be a string');
  }
  const buf = Buffer.from(s, 'base64url');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Build the JWS signing input: BASE64URL(header) || "." || payload_bytes.
 * Both inputs are validated; copies are returned so callers may safely
 * discard the original payload buffer.
 */
function buildSigningInput(protectedB64: string, payload: Uint8Array): Uint8Array {
  if (typeof protectedB64 !== 'string') {
    throw new JwsError('protected header b64 must be a string');
  }
  const headerBytes = new TextEncoder().encode(protectedB64);
  const dot = new TextEncoder().encode('.');
  const out = new Uint8Array(headerBytes.length + dot.length + payload.length);
  out.set(headerBytes, 0);
  out.set(dot, headerBytes.length);
  out.set(payload, headerBytes.length + dot.length);
  return out;
}

export function signDetached(
  payload: Uint8Array,
  privateKeyPem: string,
  opts: SignOptions,
): JwsSignature {
  if (!(payload instanceof Uint8Array)) {
    throw new JwsError('payload must be a Uint8Array');
  }
  if (typeof privateKeyPem !== 'string' || privateKeyPem.length === 0) {
    throw new JwsError('privateKeyPem must be a non-empty PEM string');
  }
  if (!opts || typeof opts !== 'object' || typeof opts.kid !== 'string' || opts.kid.length === 0) {
    throw new JwsError('opts.kid must be a non-empty string');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch (err) {
    throw new JwsError(`private key parse failed: ${(err as Error).message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new JwsError(`only Ed25519 keys are supported, got ${key.asymmetricKeyType ?? 'unknown'}`);
  }

  const protectedB64 = b64urlEncode(new TextEncoder().encode(buildProtectedHeader(opts.kid)));
  const signingInput = buildSigningInput(protectedB64, payload);
  const sig = nodeSign(null, signingInput, key);
  return {
    protected: protectedB64,
    signature: b64urlEncode(sig),
  };
}

export function verifyDetached(
  jws: JwsSignature,
  publicKeyPem: string,
  payload: Uint8Array,
): boolean {
  if (!jws || typeof jws !== 'object') {
    throw new JwsError('jws must be an object');
  }
  if (typeof jws.protected !== 'string' || jws.protected.length === 0) {
    throw new JwsError('jws.protected must be a non-empty base64url string');
  }
  if (typeof jws.signature !== 'string' || jws.signature.length === 0) {
    throw new JwsError('jws.signature must be a non-empty base64url string');
  }
  if (!(payload instanceof Uint8Array)) {
    throw new JwsError('payload must be a Uint8Array');
  }
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0) {
    throw new JwsError('publicKeyPem must be a non-empty PEM string');
  }

  // Decode + validate the protected header from the bytes the caller provided.
  let headerBytes: Uint8Array;
  try {
    headerBytes = b64urlDecode(jws.protected);
  } catch (err) {
    throw new JwsError(`protected header base64url decode failed: ${(err as Error).message}`);
  }
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes));
  } catch (err) {
    throw new JwsError(`protected header JSON parse failed: ${(err as Error).message}`);
  }
  validateProtectedHeader(header);

  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (err) {
    throw new JwsError(`public key parse failed: ${(err as Error).message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new JwsError(`only Ed25519 keys are supported, got ${key.asymmetricKeyType ?? 'unknown'}`);
  }

  const signingInput = buildSigningInput(jws.protected, payload);
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlDecode(jws.signature);
  } catch (err) {
    throw new JwsError(`signature base64url decode failed: ${(err as Error).message}`);
  }
  return nodeVerify(null, signingInput, key, sigBytes);
}

function validateProtectedHeader(header: unknown): asserts header is JwsProtectedHeader {
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new JwsError('protected header must be a JSON object');
  }
  const h = header as Record<string, unknown>;
  for (const k of Object.keys(h)) {
    if (!SUPPORTED_PARAMS.has(k)) {
      throw new JwsError(`unknown protected header parameter "${k}"`);
    }
  }
  if (h.alg !== SUPPORTED_ALG) {
    throw new JwsError(`alg must be "${SUPPORTED_ALG}", got "${JSON.stringify(h.alg)}"`);
  }
  if (typeof h.kid !== 'string' || h.kid.length === 0) {
    throw new JwsError('kid must be a non-empty string');
  }
  const crit = h.crit;
  if (!Array.isArray(crit)) {
    throw new JwsError('crit must be an array');
  }
  if (crit.length !== CRIT.length || !CRIT.every((c, i) => crit[i] === c)) {
    throw new JwsError(`crit must equal ${JSON.stringify(CRIT.slice())}, got ${JSON.stringify(crit)}`);
  }
  if (h.b64 !== false) {
    throw new JwsError('b64 must be literal false (payload is detached raw bytes)');
  }
}
