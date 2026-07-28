/**
 * Domain types for the Handoff CMS governance kernel.
 *
 * Invariants encoded here:
 *   - RegionBinding is frozen. It owns exactly one canonicalSource, a
 *     non-empty set of derivedArtifacts and a regenerationContract whose
 *     `mode` is explicit (the only mode this kernel recognises today is
 *     `alias_symlink`, but the field is a discriminated union so additional
 *     modes can be added without breaking callers).
 *   - Identities are split into actor (human), service (non-human automation),
 *     and delegated-human (a human acting on another human's behalf).
 *     Service identities are forbidden from approving or publishing.
 *   - Proposals and revisions are separate: a proposal is an intent, a
 *     revision is the immutable artifact that survives approval.
 *   - Localised values are pairs of {en, es}; missing locales are rejected,
 *     never silently defaulted.
 *   - Audit-worthy approval/publication data carries the human identity,
 *     a cryptographic attestation hash slot, a UTC timestamp and the
 *     deterministic state transition that produced it.
 *   - Deploy status is a discriminated union, not a free-form string.
 *   - Stable machine error codes are a closed string literal union; the
 *     machine-readable `code` is the only field callers should pattern-match
 *     on; the `message` is for humans only.
 */

export type Iso8601 = string & { readonly __brand: 'Iso8601' };
export type Sha256Hex = string & { readonly __brand: 'Sha256Hex' };
export type Locale = 'en' | 'es';

/** All ISO-8601 strings entering the kernel are validated and branded. */
export function brandIso8601(value: string): Iso8601 {
  if (!isIso8601(value)) {
    throw new DomainInvariantError('E_BAD_TIMESTAMP', `not ISO-8601: ${value}`);
  }
  return value as Iso8601;
}

/** SHA-256 hex digests are 64 lowercase hex chars. */
export function brandSha256Hex(value: string): Sha256Hex {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new DomainInvariantError('E_BAD_HASH', `not sha256 hex: ${value}`);
  }
  return value as Sha256Hex;
}

function isIso8601(value: string): boolean {
  // Accept Z or explicit ±HH:MM offsets with seconds.
  // Reject date-only and loose strings.
  const shape =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const m = shape.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  if (second > 59) return false;
  // Validate calendar components independently of timezone conversion so
  // offset timestamps cannot hide rolled dates such as February 30.
  const calendarProbe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    calendarProbe.getUTCFullYear() !== year ||
    calendarProbe.getUTCMonth() + 1 !== month ||
    calendarProbe.getUTCDate() !== day ||
    calendarProbe.getUTCHours() !== hour ||
    calendarProbe.getUTCMinutes() !== minute ||
    calendarProbe.getUTCSeconds() !== second
  ) {
    return false;
  }
  // Finally ensure the complete timestamp, including its explicit offset,
  // is accepted by the runtime.
  return !Number.isNaN(new Date(value).getTime());
}

// --------------------------------------------------------------------
// Stable machine error codes
// --------------------------------------------------------------------

export const ERROR_CODES = [
  'E_BAD_TIMESTAMP',
  'E_BAD_HASH',
  'E_BAD_LOCALE',
  'E_BAD_PATH',
  'E_ABSOLUTE_PATH',
  'E_ESCAPING_PATH',
  'E_SELF_ALIAS',
  'E_CYCLIC_ALIAS',
  'E_AMBIGUOUS_CANONICAL',
  'E_BAD_REGENERATION_MODE',
  'E_EMPTY_DERIVED_ARTIFACTS',
  'E_INVALID_IDENTITY',
  'E_SERVICE_APPROVAL_FORBIDDEN',
  'E_MCP_APPROVAL_FORBIDDEN',
  'E_SELF_APPROVAL_FORBIDDEN',
  'E_INSUFFICIENT_AUTHORITY',
  'E_FIELD_CAPABILITY_MISSING',
  'E_ROLE_MISMATCH',
  'E_CONTENT_TYPE_MISMATCH',
  'E_ENVIRONMENT_MISMATCH',
  'E_ACTION_FORBIDDEN',
  'E_INVALID_TRANSITION',
  'E_ROLLBACK_WINDOW_EXPIRED',
  'E_FROZEN_VIOLATION',
  'E_MISSING_LOCALE',
  'E_INVALID_PROPOSAL',
  'E_INVALID_REVISION',
] as const;
Object.freeze(ERROR_CODES);

export type ErrorCode = (typeof ERROR_CODES)[number];

export class DomainInvariantError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'DomainInvariantError';
    this.code = code;
  }
}

// --------------------------------------------------------------------
// Identities
// --------------------------------------------------------------------

export type IdentityKind = 'actor' | 'service' | 'delegated_human';

export interface IdentityBase {
  readonly id: string;
  readonly displayName: string;
  /** Capabilities granted by the host. Machine-readable strings. */
  readonly capabilities: readonly string[];
}

export interface ActorIdentity extends IdentityBase {
  readonly kind: 'actor';
}

export interface ServiceIdentity extends IdentityBase {
  readonly kind: 'service';
  /** Service identities are NEVER permitted to approve or publish. */
}

export interface DelegatedHumanIdentity extends IdentityBase {
  readonly kind: 'delegated_human';
  readonly delegatorId: string;
  /** Authority is current at this instant. The host is responsible for re-checking. */
  readonly delegatedAt: Iso8601;
  readonly delegatedUntil: Iso8601;
}

export type Identity = ActorIdentity | ServiceIdentity | DelegatedHumanIdentity;

export function isServiceIdentity(
  identity: Identity,
): identity is ServiceIdentity {
  return identity.kind === 'service';
}

export function isMcpIdentity(identity: Identity): boolean {
  return identity.capabilities.includes('mcp');
}

// --------------------------------------------------------------------
// RegionBinding
// --------------------------------------------------------------------

/**
 * A RegionBinding describes one content/asset region in the repository.
 * It is `frozen` semantically: every field is `readonly`, and the runtime
 * revalidates the shape on construction.
 */
export interface CanonicalSource {
  /** Repository-relative POSIX path. Absolute paths and `..` segments are rejected. */
  readonly repoPath: string;
  /** SHA-256 of the canonical bytes; the host is responsible for populating it. */
  readonly contentHash: Sha256Hex;
  /** Byte size; helps hosts decide between inlining and streaming. */
  readonly sizeBytes: number;
}

export interface DerivedArtifact {
  readonly repoPath: string;
  readonly kind: 'preview' | 'thumbnail' | 'transcode' | 'manifest' | 'other';
  readonly contentHash: Sha256Hex;
  readonly sizeBytes: number;
}

export type RegenerationMode = 'alias_symlink';

export interface AliasSymlinkContract {
  readonly mode: RegenerationMode;
  /** Repository-relative leaf targets. The pure core validates lexical
   * confinement and self-reference; adapters resolve filesystem chains/cycles. */
  readonly aliasTargets: readonly string[];
  /** Path of the alias file itself, repository-relative. */
  readonly aliasPath: string;
}

export type RegenerationContract = AliasSymlinkContract;

export interface RegionBinding {
  readonly id: string;
  readonly tenantId: string;
  readonly contentType: string;
  readonly environment: 'staging' | 'production';
  readonly locale: Locale;
  readonly canonicalSource: CanonicalSource;
  readonly derivedArtifacts: readonly DerivedArtifact[];
  readonly regenerationContract: RegenerationContract;
  /** Versioned governance metadata; never mutated in place. */
  readonly governanceVersion: number;
  readonly createdAt: Iso8601;
  readonly createdBy: Identity;
}

export function assertRegionBinding(binding: RegionBinding): void {
  if (binding.derivedArtifacts.length === 0) {
    throw new DomainInvariantError(
      'E_EMPTY_DERIVED_ARTIFACTS',
      `region ${binding.id} must have at least one derived artifact`,
    );
  }
  if (binding.regenerationContract.mode !== 'alias_symlink') {
    throw new DomainInvariantError(
      'E_BAD_REGENERATION_MODE',
      `unsupported regeneration mode: ${String(
        (binding.regenerationContract as { mode: unknown }).mode,
      )}`,
    );
  }
  // Canonical source must be repository-relative and must not escape.
  assertRepoRelativePath(binding.canonicalSource.repoPath, 'canonicalSource.repoPath');
  for (const art of binding.derivedArtifacts) {
    assertRepoRelativePath(art.repoPath, 'derivedArtifact.repoPath');
  }
  const contract = binding.regenerationContract;
  assertRepoRelativePath(contract.aliasPath, 'regenerationContract.aliasPath');
  for (const target of contract.aliasTargets) {
    assertRepoRelativePath(target, 'regenerationContract.aliasTargets[]');
  }
  validateAliasContract(binding);
}

function validateAliasContract(binding: RegionBinding): void {
  const { aliasPath, aliasTargets } = binding.regenerationContract;
  for (const target of aliasTargets) {
    if (target === aliasPath) {
      throw new DomainInvariantError(
        'E_SELF_ALIAS',
        `alias path ${aliasPath} cannot target itself`,
      );
    }
  }
  // Ambiguous canonical: if more than one alias target equals the
  // canonical source path, the regeneration contract is ambiguous.
  const collisions = aliasTargets.filter(
    (t) => t === binding.canonicalSource.repoPath,
  ).length;
  if (collisions > 1) {
    throw new DomainInvariantError(
      'E_AMBIGUOUS_CANONICAL',
      `alias targets collide with canonicalSource more than once in region ${binding.id}`,
    );
  }
  // Pure core does NOT walk the alias graph. Direct self-alias is detected
  // above; lexical confinement of every target (no absolutes, no escaping,
  // normalised POSIX) is enforced by assertRepoRelativePath. Real
  // filesystem multi-hop / cycle resolution belongs to the host adapter,
  // which reports E_CYCLIC_ALIAS (kept in the closed union) on detection.
}

// --------------------------------------------------------------------
// Localised values
// --------------------------------------------------------------------

export interface LocalizedValue {
  readonly en: string;
  readonly es: string;
}

export function assertLocalized(value: LocalizedValue): void {
  if (typeof value.en !== 'string' || value.en.trim().length === 0) {
    throw new DomainInvariantError('E_MISSING_LOCALE', 'missing locale "en"');
  }
  if (typeof value.es !== 'string' || value.es.trim().length === 0) {
    throw new DomainInvariantError('E_MISSING_LOCALE', 'missing locale "es"');
  }
}

// --------------------------------------------------------------------
// Proposals and revisions
// --------------------------------------------------------------------

export type ProposalAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'retire';

export interface ContentPayload {
  readonly localizedTitle: LocalizedValue;
  readonly localizedBody: LocalizedValue;
  /** Repository-relative path of the proposed canonical file. */
  readonly canonicalRepoPath: string;
}

export interface AssetPayload {
  readonly bindingId: string;
  readonly canonicalRepoPath: string;
  readonly previewRepoPath: string;
}

export type ProposalPayload = ContentPayload | AssetPayload;

export interface ProposalBase {
  readonly id: string;
  readonly tenantId: string;
  readonly contentType: string;
  readonly environment: 'staging' | 'production';
  readonly action: ProposalAction;
  readonly createdBy: Identity;
  readonly createdAt: Iso8601;
  /** Drafts are mutable; everything else is frozen by policy. */
  readonly draft: boolean;
}

export interface ContentProposal extends ProposalBase {
  readonly kind: 'content';
  readonly payload: ContentPayload;
}

export interface AssetProposal extends ProposalBase {
  readonly kind: 'asset';
  readonly payload: AssetPayload;
}

export type Proposal = ContentProposal | AssetProposal;

export function assertProposal(proposal: Proposal): void {
  if (proposal.kind === 'content') {
    assertLocalized(proposal.payload.localizedTitle);
    assertLocalized(proposal.payload.localizedBody);
    assertRepoRelativePath(
      proposal.payload.canonicalRepoPath,
      'payload.canonicalRepoPath',
    );
  } else {
    assertRepoRelativePath(
      proposal.payload.canonicalRepoPath,
      'payload.canonicalRepoPath',
    );
    assertRepoRelativePath(
      proposal.payload.previewRepoPath,
      'payload.previewRepoPath',
    );
  }
}

// --------------------------------------------------------------------
// Revisions (immutable post-approval)
// --------------------------------------------------------------------

export interface ContentRevision {
  readonly id: string;
  readonly proposalId: string;
  readonly tenantId: string;
  readonly contentType: string;
  readonly environment: 'staging' | 'production';
  readonly locale: Locale;
  readonly localizedTitle: LocalizedValue;
  readonly localizedBody: LocalizedValue;
  readonly canonicalRepoPath: string;
  readonly canonicalHash: Sha256Hex;
  readonly createdAt: Iso8601;
  readonly createdBy: Identity;
}

export interface AssetRevision {
  readonly id: string;
  readonly proposalId: string;
  readonly tenantId: string;
  readonly bindingId: string;
  readonly environment: 'staging' | 'production';
  readonly canonicalRepoPath: string;
  readonly canonicalHash: Sha256Hex;
  readonly previewRepoPath: string;
  readonly previewHash: Sha256Hex;
  readonly createdAt: Iso8601;
  readonly createdBy: Identity;
}

export type Revision = ContentRevision | AssetRevision;

// --------------------------------------------------------------------
// Approvals, publications, deploy status
// --------------------------------------------------------------------

export interface Approval {
  readonly id: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly approvedBy: Identity;
  readonly approvedAt: Iso8601;
  /** Attestation hash captured by the host at approval time. */
  readonly attestationHash: Sha256Hex;
  readonly stateBefore: import('./state-machine.js').ContentState;
  readonly stateAfter: import('./state-machine.js').ContentState;
}

export interface Publication {
  readonly id: string;
  readonly revisionId: string;
  readonly publishedBy: Identity;
  readonly publishedAt: Iso8601;
  readonly attestationHash: Sha256Hex;
  readonly stateBefore: import('./state-machine.js').ContentState;
  readonly stateAfter: import('./state-machine.js').ContentState;
  readonly deployReceiptId: string;
}

export type DeployStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'in_flight'; readonly startedAt: Iso8601 }
  | { readonly kind: 'succeeded'; readonly finishedAt: Iso8601; readonly deployReceiptId: string }
  | { readonly kind: 'failed'; readonly finishedAt: Iso8601; readonly reason: ErrorCode; readonly message: string }
  | { readonly kind: 'rolled_back'; readonly rolledBackAt: Iso8601; readonly previousDeployReceiptId: string };

// --------------------------------------------------------------------
// Repository-confinement lexical helpers (exported for tests + index re-export)
// --------------------------------------------------------------------

/**
 * Validate that a path string is repository-relative, normalised POSIX,
 * contains no NUL bytes, and does not escape the repository via `..`
 * segments. This is a LEXICAL check on the string only; it does not
 * touch the filesystem.
 */
export function assertRepoRelativePath(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainInvariantError('E_BAD_PATH', `${field}: path must be non-empty string`);
  }
  if (value.includes('\0')) {
    throw new DomainInvariantError('E_BAD_PATH', `${field}: NUL byte in path`);
  }
  // Reject absolute POSIX and absolute Windows forms.
  if (value.startsWith('/')) {
    throw new DomainInvariantError('E_ABSOLUTE_PATH', `${field}: absolute POSIX path: ${value}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    throw new DomainInvariantError('E_ABSOLUTE_PATH', `${field}: absolute Windows path: ${value}`);
  }
  // Normalise to POSIX separators.
  const posix = value.replace(/\\/g, '/');
  if (value.includes('\\') || posix.includes('//') || posix.endsWith('/')) {
    throw new DomainInvariantError('E_BAD_PATH', `${field}: path must use normalized POSIX separators: ${value}`);
  }
  const parts = posix.split('/').filter((p) => p.length > 0);
  for (const part of parts) {
    if (part === '..' || part === '.') {
      throw new DomainInvariantError(
        'E_ESCAPING_PATH',
        `${field}: path contains '${part}' segment: ${value}`,
      );
    }
    if (!isSafeSegment(part)) {
      throw new DomainInvariantError(
        'E_BAD_PATH',
        `${field}: unsafe path segment '${part}' in ${value}`,
      );
    }
  }
}

/**
 * Identical to `assertRepoRelativePath` but returns a typed result so that
 * callers can branch without try/catch.
 */
export function checkRepoRelativePath(
  value: string,
  field: string,
): { ok: true } | { ok: false; code: ErrorCode; message: string } {
  try {
    assertRepoRelativePath(value, field);
    return { ok: true };
  } catch (err) {
    if (err instanceof DomainInvariantError) {
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
}

function isSafeSegment(seg: string): boolean {
  // Allow letters, digits, dash, underscore, dot. Reject control chars
  // and shell metacharacters. This is intentionally conservative.
  return /^[A-Za-z0-9._-]+$/.test(seg);
}