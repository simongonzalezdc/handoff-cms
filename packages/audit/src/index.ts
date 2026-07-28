/**
 * Audit envelope: bounded, immutable AuditEvent validation, deterministic
 * serialization, content hashing, detached JWS signing, and verification.
 *
 * The envelope proves:
 *  - tenant (string id, non-empty)
 *  - actor (string id of the originating service or system identity)
 *  - delegatedHuman (optional) — present only when a human acted through a delegating service
 *  - proposal (object describing the change being proposed)
 *  - approval (object describing the human approval) and selfApproved flag
 *  - hostResult (canonical host-side outcome)
 *  - deployResult (object describing the deploy outcome)
 *  - rollbackLineage (array of references to prior events that this one rolls back)
 *
 * Never stores secrets. Optional fields are present only with a non-default
 * value; absent fields are omitted from canonical bytes entirely.
 *
 * Verification contract (`verifyEnvelope`):
 *  - Returns `boolean`. Never throws for any malformed envelope input
 *    (wrong shape, mismatched proposal hash, invalid signature, mismatched
 *    event id, missing fields, etc.). A `false` result is the universal
 *    signal for "this envelope is not authentic for the given public key".
 *  - Construction-time validation (`buildEvent`, `signEvent`) still throws
 *    `AuditError` on programmer error, because the caller must fix the input
 *    before it can produce a meaningful envelope.
 */

import {
  canonicalize,
  CanonicalError,
  contentHash,
  canonicalNDJSON,
} from './canonical.js';
import {
  generateEd25519KeyPair,
  signDetached,
  verifyDetached,
  JwsError,
} from './jws.js';
import type { JwsSignature } from './jws.js';

export { CanonicalError, JwsError };
export {
  canonicalize,
  canonicalNDJSON,
  contentHash,
  generateEd25519KeyPair,
  signDetached,
  verifyDetached,
};
export type { JwsSignature };

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

/** Reference id of a prior event (sha256 hex of its canonical bytes). */
export type EventId = string & { readonly __brand: 'EventId' };

/** A reference a deploy makes back to a prior event id (sha256 hex). */
export interface RollbackRef {
  /** id of the prior event being rolled back / superseded */
  id: EventId;
  /** human-readable reason (non-empty) */
  reason: string;
}

/** Canonical, host-asserted result for an authored outcome. */
export type HostResultStatus = 'committed' | 'skipped' | 'failed';

/** Idempotent proposal: what change the event describes. */
export interface Proposal {
  /** slug/id of the change (non-empty) */
  ref: string;
  /** human-readable title (non-empty, must not contain control chars) */
  title: string;
  /** free-form structured fields restricted to canonical-compatible types */
  fields: { readonly [k: string]: unknown };
}

/** Approval record from a (human or system) approver. */
export interface Approval {
  /** who approved (must be human id or the same actor when selfApproved) */
  approver: string;
  /** unix seconds, integer */
  at: number;
  /** non-empty comment or note */
  note?: string;
}

/** Outcome of the deploy step. */
export interface DeployResult {
  status: 'deployed' | 'rolled-back' | 'noop';
  /** unix seconds, integer */
  at: number;
  /** rolled-back target ids (sha256 hex) */
  rolledBackFrom?: readonly EventId[];
}

/**
 * Top-level AuditEvent envelope.
 *
 * Required fields are always set. Optional fields are omitted entirely from
 * the canonical bytes when not present. `delegatedHuman` is only present when
 * a human is acting through a delegating service; otherwise it must be unset.
 */
export interface AuditEvent {
  /** schema version, always 1 for this package */
  v: 1;
  /** content hash of the proposal (sha256 hex, 64 chars). MUST equal
   *  `contentHash(event.proposal)` for the envelope to verify. */
  proposalHash: string;
  tenant: string;
  actor: string;
  delegatedHuman?: string;
  proposal: Proposal;
  approval: Approval;
  /** true iff the actor approved its own proposal (no human in the loop) */
  selfApproved: boolean;
  hostResult: {
    status: HostResultStatus;
    /** content hash of the canonical host-side artifact */
    artifactHash: string;
    /** artifact reference, opaque to this package */
    artifactRef: string;
  };
  deployResult: DeployResult;
  rollbackLineage: readonly RollbackRef[];
}

export interface SignedAuditEnvelope {
  /** the AuditEvent envelope (canonicalized for signing) */
  event: AuditEvent;
  /** sha256 hex of the canonical bytes of the event */
  eventId: EventId;
  /** detached JWS over the canonical bytes */
  signature: JwsSignature;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const HEX_64_RE = /^[0-9a-f]{64}$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}

function requireHex64(value: unknown, path: string): void {
  if (typeof value !== 'string' || !HEX_64_RE.test(value)) {
    throw new AuditError(`${path} must be a 64-character lowercase hex sha256`);
  }
}

function requireString(value: unknown, path: string, minLen = 1, maxLen = 256): string {
  if (typeof value !== 'string') {
    throw new AuditError(`${path} must be a string`);
  }
  if (value.length < minLen || value.length > maxLen) {
    throw new AuditError(`${path} length must be ${minLen}-${maxLen}, got ${value.length}`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new AuditError(`${path} must not contain control characters`);
  }
  return value;
}

function requireUnixSeconds(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AuditError(`${path} must be an integer unix-seconds`);
  }
  if (value < 0 || value > 253402300799) {
    throw new AuditError(`${path} out of valid unix-seconds range`);
  }
  return value;
}

function asEventId(value: string): EventId {
  return value as EventId;
}

export function validateAuditEvent(value: unknown): asserts value is AuditEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuditError('event must be an object');
  }
  const e = value as Record<string, unknown>;
  if (e.v !== 1) {
    throw new AuditError('event.v must be 1');
  }
  requireHex64(e.proposalHash, 'event.proposalHash');

  const tenant = requireString(e.tenant, 'event.tenant');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tenant)) {
    throw new AuditError('event.tenant must be a lowercase slug');
  }
  const actor = requireString(e.actor, 'event.actor');
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(actor)) {
    throw new AuditError('event.actor must be a lowercase id');
  }

  // delegatedHuman: when present, must be a string id; when absent, must remain absent.
  if ('delegatedHuman' in e) {
    requireString(e.delegatedHuman, 'event.delegatedHuman');
  }

  // proposal
  const p = e.proposal;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new AuditError('event.proposal must be an object');
  }
  const pp = p as Record<string, unknown>;
  requireString(pp.ref, 'event.proposal.ref');
  requireString(pp.title, 'event.proposal.title');
  if (!pp.fields || typeof pp.fields !== 'object' || Array.isArray(pp.fields)) {
    throw new AuditError('event.proposal.fields must be a plain object');
  }
  // Validate that the canonical form of fields is acceptable.
  canonicalize(pp.fields);

  // Enforce proposalHash === contentHash(proposal). Mismatch is a hard error:
  // an envelope whose recorded proposal hash does not match the proposal it
  // names cannot verify, and silently accepting it would let a forged
  // proposal slide through with a stale hash.
  const expectedProposalHash = contentHash(pp);
  if (e.proposalHash !== expectedProposalHash) {
    throw new AuditError(
      `event.proposalHash must equal contentHash(event.proposal): expected ${expectedProposalHash}, got ${e.proposalHash}`,
    );
  }

  // approval
  if (!e.approval || typeof e.approval !== 'object' || Array.isArray(e.approval)) {
    throw new AuditError('event.approval must be an object');
  }
  const a = e.approval as Record<string, unknown>;
  requireString(a.approver, 'event.approval.approver');
  requireUnixSeconds(a.at, 'event.approval.at');
  if ('note' in a) {
    requireString(a.note, 'event.approval.note');
  }

  if (typeof e.selfApproved !== 'boolean') {
    throw new AuditError('event.selfApproved must be a boolean');
  }
  if (e.selfApproved) {
    // When self-approved, approval.approver MUST equal actor and delegatedHuman MUST be absent.
    if (a.approver !== actor) {
      throw new AuditError('event.selfApproved=true requires approval.approver === actor');
    }
    if ('delegatedHuman' in e) {
      throw new AuditError('event.selfApproved=true forbids event.delegatedHuman');
    }
  }

  // hostResult
  if (!e.hostResult || typeof e.hostResult !== 'object' || Array.isArray(e.hostResult)) {
    throw new AuditError('event.hostResult must be an object');
  }
  const h = e.hostResult as Record<string, unknown>;
  if (h.status !== 'committed' && h.status !== 'skipped' && h.status !== 'failed') {
    throw new AuditError('event.hostResult.status must be committed|skipped|failed');
  }
  requireHex64(h.artifactHash, 'event.hostResult.artifactHash');
  requireString(h.artifactRef, 'event.hostResult.artifactRef');

  // deployResult
  if (!e.deployResult || typeof e.deployResult !== 'object' || Array.isArray(e.deployResult)) {
    throw new AuditError('event.deployResult must be an object');
  }
  const d = e.deployResult as Record<string, unknown>;
  if (d.status !== 'deployed' && d.status !== 'rolled-back' && d.status !== 'noop') {
    throw new AuditError('event.deployResult.status must be deployed|rolled-back|noop');
  }
  requireUnixSeconds(d.at, 'event.deployResult.at');
  if ('rolledBackFrom' in d) {
    if (!Array.isArray(d.rolledBackFrom)) {
      throw new AuditError('event.deployResult.rolledBackFrom must be an array');
    }
    for (let i = 0; i < d.rolledBackFrom.length; i += 1) {
      const id = d.rolledBackFrom[i];
      requireHex64(id, `event.deployResult.rolledBackFrom[${i}]`);
    }
  }

  // rollbackLineage
  if (!Array.isArray(e.rollbackLineage)) {
    throw new AuditError('event.rollbackLineage must be an array');
  }
  for (let i = 0; i < e.rollbackLineage.length; i += 1) {
    const r = e.rollbackLineage[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new AuditError(`event.rollbackLineage[${i}] must be an object`);
    }
    const rr = r as Record<string, unknown>;
    requireHex64(rr.id, `event.rollbackLineage[${i}].id`);
    requireString(rr.reason, `event.rollbackLineage[${i}].reason`);
  }

  // Sanity: verify the entire shape canonicalizes cleanly.
  canonicalize(e);
}

// ---------------------------------------------------------------------------
// Construct / sign / verify
// ---------------------------------------------------------------------------

/**
 * Compute the canonical bytes for an event and the event id (sha256 hex).
 */
export function canonicalizeEvent(event: AuditEvent): { id: EventId; bytes: Uint8Array } {
  validateAuditEvent(event);
  const bytes = canonicalize(event);
  const id = contentHash(event) as EventId;
  return { id: asEventId(id), bytes };
}

/**
 * Build a new event from already-validated fields. Throws on any invalid input.
 *
 * Returns an immutable deep copy of the input: callers can mutate the
 * returned object freely without affecting any other reference, and
 * subsequent mutations to the input cannot leak back through. Uses
 * `structuredClone` for a sound structural copy rather than a JSON
 * round-trip, which would silently drop undefined values, Map/Set entries,
 * and non-JSON types. (The input has already been validated against the
 * canonical type whitelist, so plain structuredClone semantics are correct.)
 */
export function buildEvent(input: AuditEvent): AuditEvent {
  validateAuditEvent(input);
  return structuredClone(input) as AuditEvent;
}

/**
 * Sign an event and return the envelope with a detached JWS signature.
 *
 * The JWS protected header encodes the kid used to look up the verification
 * key. The signature is computed over the canonical bytes derived from the
 * event shape — not the JSON.stringify of the runtime object — so byte-level
 * canonical form is preserved across processes.
 */
export function signEvent(
  event: AuditEvent,
  privateKeyPem: string,
  kid: string,
): SignedAuditEnvelope {
  const { id, bytes } = canonicalizeEvent(event);
  const signature = signDetached(bytes, privateKeyPem, { kid });
  return { event, eventId: id, signature };
}

/**
 * Verify a signed envelope against a known public key.
 *
 * Contract: returns `boolean`. Never throws for malformed envelopes. Any
 * structural defect, canonicalization failure, hash mismatch, id mismatch,
 * or signature failure deterministically yields `false`. Construction-time
 * errors raised via `buildEvent`/`signEvent` still throw `AuditError`,
 * because there the caller has produced input that needs to be fixed
 * before a meaningful envelope can exist.
 *
 * Specifically, returns `true` only when:
 *  - the envelope and event are structurally valid (`AuditError`-clean)
 *  - `event.proposalHash === contentHash(event.proposal)`
 *  - the protected header is well-formed (alg EdDSA, b64 false, crit [b64])
 *  - the canonical bytes of `envelope.event` hash to `envelope.eventId`
 *  - the detached JWS verifies against those exact canonical bytes
 *
 * `eventId` is NOT trusted from the envelope; it is recomputed from canonical bytes.
 */
export function verifyEnvelope(
  envelope: SignedAuditEnvelope,
  publicKeyPem: string,
): boolean {
  if (!envelope || typeof envelope !== 'object') {
    return false;
  }
  let bytes: Uint8Array;
  let id: EventId;
  try {
    const result = canonicalizeEvent(envelope.event as AuditEvent);
    bytes = result.bytes;
    id = result.id;
  } catch (err) {
    if (err instanceof AuditError || err instanceof CanonicalError || err instanceof JwsError) {
      return false;
    }
    throw err;
  }
  if (id !== envelope.eventId) {
    return false;
  }
  try {
    return verifyDetached(envelope.signature, publicKeyPem, bytes);
  } catch (err) {
    if (err instanceof JwsError) {
      return false;
    }
    throw err;
  }
}