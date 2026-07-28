/**
 * @cms/storage — governance persistence contract and Postgres implementation.
 *
 * This module is the ONLY legitimate surface through which other packages
 * touch the governance database. It exposes:
 *
 *  - `Storage`: the persistence interface (transactional, idempotent,
 *    optimistic-concurrency-safe).
 *  - `PostgresStorage`: the canonical Drizzle/Postgres implementation.
 *  - Stable row types and result types for every governance operation.
 *  - Stable, machine-readable error classes.
 *
 * NON-GOALS:
 *  - This package does NOT model canonical CMS content/assets. The host
 *    repository, database, object store, or backing CMS remains canonical.
 *  - This package does NOT contain an in-memory or fake implementation.
 *    A `Storage` instance must be backed by a real Postgres database.
 *    In test environments the same Drizzle/Postgres dialect is run against
 *    an in-process Postgres (pglite) so the real DDL, CHECK constraints,
 *    and triggers execute end-to-end; no `Storage` subclass or fake layer
 *    is ever swapped in.
 *
 * Guarantees:
 *  - Every multi-row write is wrapped in a transaction.
 *  - Idempotency keys are uniquely keyed per (tenant, key) and never
 *    re-execute side effects on replay. `beginIdempotency` returns the
 *    recorded row unchanged for `succeeded`/`failed` outcomes so callers
 *    can short-circuit without re-inserting the side effect.
 *  - Optimistic concurrency: updates assert the expected `version` and
 *    bump it under a single SQL UPDATE.
 *  - Tenant-scoped mutators refuse writes against disabled tenants
 *    (`tenant_disabled`). Disabling an already-disabled tenant is a no-op
 *    that returns the current row rather than `not_found`.
 *  - Frozen-core guard: `region_bindings` rows that have reached
 *    `approved` or `retired` refuse further frozen-core upserts. To
 *    redirect canonical sources, retire the existing binding explicitly
 *    and create a new one.
 *  - Append-only enforcement: `audit_events` refuses UPDATE/DELETE/TRUNCATE
 *    via triggers (see migration). `idempotency_records` transitions from
 *    in_progress to a terminal outcome under the same transaction; the
 *    schema-layer CHECK constraints guard that transition.
 *  - No managed-service dependency is required at runtime.
 *
 * Error model:
 *  - `StorageError` is the root; concrete subclasses carry stable,
 *    machine-readable `code` fields so callers (API/CLI/MCP/UI) can map
 *    to localized messages via `@cms/i18n` without string matching.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  type NodePgDatabase,
  drizzle as drizzlePg,
} from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
  type ActorKind,
  type DeployStatus,
  type IdempotencyOutcome,
  type ProposalState,
  type PublicationStatus,
  type RegenerationContractMode,
  type RevisionKind,
  actors,
  approvals,
  auditEvents,
  deployReceipts,
  idempotencyRecords,
  proposals,
  publications,
  regionBindings,
  revisions,
  tenants,
} from './schema.js';

// ---------------------------------------------------------------------------
// Internal markers used by tests and the append-only / frozen-core classifier.
// Consumers MUST NOT depend on these — they are stable only within a major
// version of @cms/storage.
// ---------------------------------------------------------------------------

/**
 * Marker prefix the append-only trigger emits. The storage classifier matches
 * this marker verbatim to disambiguate trigger-raised P0001 exceptions from
 * other P0001 emissions (e.g. CHECK constraints). Keeping the marker in one
 * place avoids drift between the SQL DDL and the TypeScript classifier.
 */
export const APPEND_ONLY_MARKER = 'cms_storage.audit_events is append-only';

/**
 * Marker used by `upsertRegionBinding` to refuse frozen-core changes once a
 * binding has reached `approved` or `retired`. Surfaced as `invalid_input`
 * rather than a CHECK violation because the refusal is policy-driven (no
 * `approval_state = approved` constraint forbids it at the SQL layer).
 */
export const FROZEN_CORE_REFUSED_MARKER = 'region_binding frozen core is immutable after approval';

/**
 * Marker used by `retireRegionBinding` when a caller tries to retire a
 * region binding that is already in a terminal approval state (`retired`
 * or `refused`). Retiring is one-way; once a binding is `retired` it can
 * never be re-bound to a canonical source.
 */
export const REGION_RETIRE_TERMINAL_MARKER = 'region_binding already retired or refused; cannot retire again';

/**
 * Marker used by `refuseRegionBinding` when a caller tries to refuse a
 * binding that is already `approved` or `retired`. Refusal is only valid
 * for `pending` bindings; once a binding is approved, the only safe
 * transition is `retire` (preserves immutability of the frozen core).
 */
export const REGION_REFUSE_TERMINAL_MARKER = 'region_binding cannot refuse approved/retired bindings; use retire instead';

// ---------------------------------------------------------------------------
// Re-exports for downstream packages
// ---------------------------------------------------------------------------

export {
  actors,
  approvals,
  auditEvents,
  deployReceipts,
  idempotencyRecords,
  proposals,
  publications,
  regionBindings,
  revisions,
  tenants,
} from './schema.js';

export type {
  ActorKind,
  DeployStatus,
  IdempotencyOutcome,
  ProposalState,
  PublicationStatus,
  RegenerationContractMode,
  RevisionKind,
} from './schema.js';

// ---------------------------------------------------------------------------
// Domain row types (read shapes)
// ---------------------------------------------------------------------------

/** A tenant row. */
export interface TenantRow {
  id: string;
  slug: string;
  displayName: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  disabledAt: Date | null;
}

/** An actor row. */
export interface ActorRow {
  id: string;
  tenantId: string;
  kind: ActorKind;
  slug: string;
  displayName: string | null;
  issuer: string | null;
  publicKeyKid: string | null;
  declaredCapabilities: Record<string, unknown>;
  verified: boolean;
  createdAt: Date;
  disabledAt: Date | null;
}

/**
 * Canonical source identifier for a region binding. Mirrors the schema's
 * typed `canonical_source` jsonb shape: the adapter-specific opaque backend
 * descriptor plus its path/locator, with an optional content hash.
 */
export interface CanonicalSource {
  /** Adapter-specific opaque backend descriptor. */
  backend: string;
  /** Adapter-specific path/locator. */
  locator: string;
  /** Optional content-addressable hash captured at approval time. */
  contentHash?: string;
  /** Adapter-specific extensions (preserved verbatim through round-trip). */
  [extension: string]: unknown;
}

/** A region binding row. */
export interface RegionBindingRow {
  id: string;
  tenantId: string;
  slug: string;
  adapterId: string;
  canonicalSource: CanonicalSource;
  derivedArtifacts: readonly unknown[];
  regenerationContract: { mode: RegenerationContractMode; params?: Record<string, unknown> };
  schema: Record<string, unknown>;
  localePolicy: Record<string, unknown>;
  mediaFields: readonly unknown[];
  fieldCapabilities: Record<string, 'read_only' | 'coordinator_gated' | 'free_edit'>;
  approvalState: 'pending' | 'approved' | 'retired' | 'refused';
  version: number;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  approvedByActorId: string | null;
}

/** A proposal row. */
export interface ProposalRow {
  id: string;
  tenantId: string;
  regionBindingId: string;
  slug: string;
  proposedByActorId: string;
  delegatedHumanActorId: string | null;
  title: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  state: ProposalState;
  version: number;
  validatedAt: Date | null;
  approvedAt: Date | null;
  canonicalWrittenAt: Date | null;
  liveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An approval row. */
export interface ApprovalRow {
  id: string;
  tenantId: string;
  proposalId: string;
  approverActorId: string;
  delegatedHumanActorId: string | null;
  selfApproved: boolean;
  role: string;
  contentType: string;
  environment: string;
  note: string | null;
  targetState: 'approved' | 'rolled_back';
  rollbackTargetProposalId: string | null;
  createdAt: Date;
}

/** A revision row. */
export interface RevisionRow {
  id: string;
  tenantId: string;
  proposalId: string;
  regionBindingId: string;
  kind: RevisionKind;
  version: number;
  slug: string;
  parentRevisionId: string | null;
  beforeRef: string | null;
  afterRef: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  actorId: string;
  approverActorId: string | null;
  selfApproved: boolean;
  rollbackTargetRevisionId: string | null;
  diff: Record<string, unknown>;
  diffHash: string;
  createdAt: Date;
}

/** A publication row. */
export interface PublicationRow {
  id: string;
  tenantId: string;
  proposalId: string;
  canonicalRevisionId: string;
  status: PublicationStatus;
  canonicalWrittenAt: Date;
  liveAt: Date | null;
  failureReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A deploy receipt row. */
export interface DeployReceiptRow {
  id: string;
  tenantId: string;
  publicationId: string;
  adapterId: string;
  externalDeployId: string;
  status: DeployStatus;
  payload: Record<string, unknown>;
  liveUrl: string | null;
  receivedAt: Date;
  completedAt: Date | null;
}

/** An audit event row. */
export interface AuditEventRow {
  eventHash: string;
  tenantId: string;
  actorId: string;
  delegatedHumanActorId: string | null;
  proposalId: string | null;
  approvalId: string | null;
  occurredAt: Date;
  schemaVersion: number;
  selfApproved: boolean;
  event: Record<string, unknown>;
  persistedAt: Date;
}

/** An idempotency record row. */
export interface IdempotencyRecordRow {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  endpoint: string;
  outcome: IdempotencyOutcome;
  response: Record<string, unknown> | null;
  responseStatus: number | null;
  lockedBy: string | null;
  lockExpiresAt: Date | null;
  createdAt: Date;
  finalizedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/** Stable machine-readable error codes. Localize via @cms/i18n; never match strings. */
export type StorageErrorCode =
  | 'not_found'
  | 'tenant_disabled'
  | 'idempotency_replay_mismatch'
  | 'idempotency_in_progress'
  | 'optimistic_concurrency_conflict'
  | 'unique_violation'
  | 'foreign_key_violation'
  | 'check_violation'
  | 'append_only_violation'
  | 'invalid_input'
  | 'transaction_aborted'
  | 'connection_failed'
  | 'unsupported';

/** Root storage error. Callers branch on `code`, never on `message`. */
export class StorageError extends Error {
  public readonly code: StorageErrorCode;
  public readonly detail: Record<string, unknown> | undefined;
  constructor(code: StorageErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.detail = detail;
  }
}

export class NotFoundError extends StorageError {
  constructor(entity: string, detail?: Record<string, unknown>) {
    super('not_found', `${entity} not found`, { entity, ...detail });
    this.name = 'NotFoundError';
  }
}

export class OptimisticConcurrencyError extends StorageError {
  constructor(entity: string, expectedVersion: number, detail?: Record<string, unknown>) {
    super(
      'optimistic_concurrency_conflict',
      `${entity} version mismatch (expected ${expectedVersion})`,
      { entity, expectedVersion, ...detail },
    );
    this.name = 'OptimisticConcurrencyError';
  }
}

export class IdempotencyReplayMismatchError extends StorageError {
  constructor(detail?: Record<string, unknown>) {
    super(
      'idempotency_replay_mismatch',
      'idempotency key replayed with a different request body',
      detail,
    );
    this.name = 'IdempotencyReplayMismatchError';
  }
}

export class IdempotencyInProgressError extends StorageError {
  constructor(detail?: Record<string, unknown>) {
    super('idempotency_in_progress', 'idempotency key is locked by an in-progress attempt', detail);
    this.name = 'IdempotencyInProgressError';
  }
}

export class UniqueViolationError extends StorageError {
  constructor(constraint: string, detail?: Record<string, unknown>) {
    super('unique_violation', `unique constraint violated: ${constraint}`, { constraint, ...detail });
    this.name = 'UniqueViolationError';
  }
}

export class ForeignKeyViolationError extends StorageError {
  constructor(constraint: string, detail?: Record<string, unknown>) {
    super('foreign_key_violation', `foreign key violated: ${constraint}`, { constraint, ...detail });
    this.name = 'ForeignKeyViolationError';
  }
}

export class CheckViolationError extends StorageError {
  constructor(constraint: string, detail?: Record<string, unknown>) {
    super('check_violation', `check constraint violated: ${constraint}`, { constraint, ...detail });
    this.name = 'CheckViolationError';
  }
}

export class AppendOnlyViolationError extends StorageError {
  constructor(table: string, detail?: Record<string, unknown>) {
    super('append_only_violation', `append-only table ${table} rejected mutation`, { table, ...detail });
    this.name = 'AppendOnlyViolationError';
  }
}

export class InvalidInputError extends StorageError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super('invalid_input', message, detail);
    this.name = 'InvalidInputError';
  }
}

/** Thrown when a write is attempted against a tenant that has been disabled. */
export class TenantDisabledError extends StorageError {
  constructor(tenantId: string, detail?: Record<string, unknown>) {
    super('tenant_disabled', `tenant ${tenantId} is disabled; writes are refused`, { tenantId, ...detail });
    this.name = 'TenantDisabledError';
  }
}

// ---------------------------------------------------------------------------
// Operation input shapes
// ---------------------------------------------------------------------------

export interface CreateTenantInput {
  slug: string;
  displayName: string;
  metadata?: Record<string, unknown>;
}

export interface DisableTenantInput {
  tenantId: string;
}

export interface UpsertActorInput {
  tenantId: string;
  kind: ActorKind;
  slug: string;
  displayName?: string;
  issuer?: string;
  publicKeyKid?: string;
  declaredCapabilities?: Record<string, unknown>;
  /**
   * Explicit verification state. When omitted, the existing `verified` flag is
   * preserved for an existing disabled actor so re-enabling an unverified
   * actor does not silently mark it as verified. For a freshly created row,
   * the default is `false`.
   */
  verified?: boolean;
}

export interface UpsertRegionBindingInput {
  tenantId: string;
  slug: string;
  adapterId: string;
  canonicalSource: CanonicalSource;
  derivedArtifacts?: readonly unknown[];
  regenerationContract: { mode: RegenerationContractMode; params?: Record<string, unknown> };
  schema: Record<string, unknown>;
  localePolicy: Record<string, unknown>;
  mediaFields?: readonly unknown[];
  fieldCapabilities?: Record<string, 'read_only' | 'coordinator_gated' | 'free_edit'>;
}

export interface ApproveRegionBindingInput {
  tenantId: string;
  regionBindingId: string;
  approverActorId: string;
  expectedVersion: number;
}

export interface RetireRegionBindingInput {
  tenantId: string;
  regionBindingId: string;
  /** Optimistic-concurrency version of the binding row being retired. */
  expectedVersion: number;
  /** Optional human note attached to the retirement (audit context only). */
  reason?: string;
}

export interface RefuseRegionBindingInput {
  tenantId: string;
  regionBindingId: string;
  /** Optimistic-concurrency version of the binding row being refused. */
  expectedVersion: number;
  /** Optional human note attached to the refusal (audit context only). */
  reason?: string;
}

export interface CreateProposalInput {
  tenantId: string;
  regionBindingId: string;
  slug: string;
  proposedByActorId: string;
  delegatedHumanActorId?: string;
  title: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  idempotencyKey: string;
  requestFingerprint: string;
  endpoint: string;
}

export interface TransitionProposalInput {
  tenantId: string;
  proposalId: string;
  expectedVersion: number;
  nextState: ProposalState;
  /** Optional timestamp overrides for testability; defaults to now(). */
  validatedAt?: Date;
  approvedAt?: Date;
  canonicalWrittenAt?: Date;
  liveAt?: Date;
}

export interface RecordApprovalInput {
  tenantId: string;
  proposalId: string;
  approverActorId: string;
  delegatedHumanActorId?: string;
  selfApproved: boolean;
  role: string;
  contentType: string;
  environment: string;
  note?: string;
  targetState: 'approved' | 'rolled_back';
  rollbackTargetProposalId?: string;
}

export interface AppendRevisionInput {
  tenantId: string;
  proposalId: string;
  regionBindingId: string;
  kind: RevisionKind;
  slug: string;
  parentRevisionId?: string;
  beforeRef?: string;
  afterRef?: string;
  beforeHash?: string;
  afterHash?: string;
  actorId: string;
  approverActorId?: string;
  selfApproved: boolean;
  rollbackTargetRevisionId?: string;
  diff: Record<string, unknown>;
  diffHash: string;
}

export interface RecordPublicationInput {
  tenantId: string;
  proposalId: string;
  canonicalRevisionId: string;
}

export interface TransitionPublicationInput {
  tenantId: string;
  publicationId: string;
  expectedVersion: number;
  nextStatus: PublicationStatus;
  liveAt?: Date;
  failureReason?: string;
}

export interface RecordDeployReceiptInput {
  tenantId: string;
  publicationId: string;
  adapterId: string;
  externalDeployId: string;
  status?: DeployStatus;
  payload?: Record<string, unknown>;
  liveUrl?: string;
  completedAt?: Date;
}

export interface AppendAuditEventInput {
  eventHash: string;
  tenantId: string;
  actorId: string;
  delegatedHumanActorId?: string;
  proposalId?: string;
  approvalId?: string;
  occurredAt: Date;
  schemaVersion?: number;
  selfApproved: boolean;
  event: Record<string, unknown>;
}

export interface BeginIdempotencyInput {
  tenantId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  endpoint: string;
  lockedBy: string;
  lockTtlSeconds: number;
}

/**
 * Outcome discriminator for `beginIdempotency`.
 *  - `in_progress`: a fresh lock was acquired; the caller may proceed.
 *  - `succeeded`: a previously-recorded successful response exists; the
 *    caller MUST short-circuit and surface the recorded response. Re-running
 *    the side effect would violate idempotency.
 *  - `failed`: a previously-recorded failed response exists; the caller MUST
 *    treat this as a replay and surface the recorded failure. Re-running the
 *    side effect would violate idempotency.
 */
export interface IdempotencyReplay {
  source: 'in_progress' | 'succeeded' | 'failed';
  record: IdempotencyRecordRow;
}

export interface FinalizeIdempotencyInput {
  tenantId: string;
  idempotencyKey: string;
  outcome: Exclude<IdempotencyOutcome, 'in_progress'>;
  response: Record<string, unknown>;
  responseStatus: number;
}

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

/** A database-agnostic transactional unit of work. Implementations rollback on throw. */
export interface Transactional<T> {
  (tx: PostgresStorage): Promise<T>;
}

// ---------------------------------------------------------------------------
// Storage interface
// ---------------------------------------------------------------------------

/**
 * The governance persistence contract.
 *
 * Every mutating operation is idempotent or optimistic-concurrency-safe.
 * Operations that span multiple rows take an explicit `Transactional<T>`
 * callback via `runInTransaction` so partial failures roll back atomically.
 */
export interface Storage {
  // Lifecycle
  close(): Promise<void>;

  // Tenants
  createTenant(input: CreateTenantInput): Promise<TenantRow>;
  disableTenant(input: DisableTenantInput): Promise<TenantRow>;
  getTenantById(tenantId: string): Promise<TenantRow | null>;
  getTenantBySlug(slug: string): Promise<TenantRow | null>;

  // Actors
  upsertActor(input: UpsertActorInput): Promise<ActorRow>;
  getActorById(tenantId: string, actorId: string): Promise<ActorRow | null>;
  getActorBySlug(tenantId: string, slug: string): Promise<ActorRow | null>;

  // Region bindings
  upsertRegionBinding(input: UpsertRegionBindingInput): Promise<RegionBindingRow>;
  approveRegionBinding(input: ApproveRegionBindingInput): Promise<RegionBindingRow>;
  /** Retire a region binding. One-way: pending or approved -> retired. */
  retireRegionBinding(input: RetireRegionBindingInput): Promise<RegionBindingRow>;
  /** Refuse a region binding. Pending only: pending -> refused. */
  refuseRegionBinding(input: RefuseRegionBindingInput): Promise<RegionBindingRow>;
  getRegionBindingById(tenantId: string, regionBindingId: string): Promise<RegionBindingRow | null>;
  getRegionBindingBySlug(tenantId: string, slug: string): Promise<RegionBindingRow | null>;

  // Proposals
  createProposal(input: CreateProposalInput): Promise<ProposalRow>;
  transitionProposal(input: TransitionProposalInput): Promise<ProposalRow>;
  getProposalById(tenantId: string, proposalId: string): Promise<ProposalRow | null>;

  // Approvals
  recordApproval(input: RecordApprovalInput): Promise<ApprovalRow>;

  // Revisions
  appendRevision(input: AppendRevisionInput): Promise<RevisionRow>;
  listRevisionsForProposal(tenantId: string, proposalId: string): Promise<readonly RevisionRow[]>;

  // Publications
  recordPublication(input: RecordPublicationInput): Promise<PublicationRow>;
  transitionPublication(input: TransitionPublicationInput): Promise<PublicationRow>;

  // Deploy receipts
  recordDeployReceipt(input: RecordDeployReceiptInput): Promise<DeployReceiptRow>;

  // Audit events (append-only)
  appendAuditEvent(input: AppendAuditEventInput): Promise<AuditEventRow>;
  getAuditEventByHash(tenantId: string, eventHash: string): Promise<AuditEventRow | null>;
  listAuditEventsForProposal(tenantId: string, proposalId: string): Promise<readonly AuditEventRow[]>;

  // Idempotency
  beginIdempotency(input: BeginIdempotencyInput): Promise<IdempotencyReplay>;
  finalizeIdempotency(input: FinalizeIdempotencyInput): Promise<IdempotencyRecordRow>;
  releaseIdempotency(tenantId: string, idempotencyKey: string): Promise<void>;

  // Transactions
  runInTransaction<T>(work: Transactional<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Drizzle row → domain row adapters
// ---------------------------------------------------------------------------

type RawTenant = typeof tenants.$inferSelect;
type RawActor = typeof actors.$inferSelect;
type RawRegionBinding = typeof regionBindings.$inferSelect;
type RawProposal = typeof proposals.$inferSelect;
type RawApproval = typeof approvals.$inferSelect;
type RawRevision = typeof revisions.$inferSelect;
type RawPublication = typeof publications.$inferSelect;
type RawDeployReceipt = typeof deployReceipts.$inferSelect;
type RawAuditEvent = typeof auditEvents.$inferSelect;
type RawIdempotencyRecord = typeof idempotencyRecords.$inferSelect;

// Strict row decoders. The CHECK constraints in schema.ts pin these string
// columns to the union members listed here, so a runtime assertion is safe
// and keeps the public domain types narrow without weakening the schema.
type RegionApprovalState = 'pending' | 'approved' | 'retired' | 'refused';
const REGION_APPROVAL_STATES: readonly RegionApprovalState[] = [
  'pending',
  'approved',
  'retired',
  'refused',
];

type ApprovalTargetState = 'approved' | 'rolled_back';
const APPROVAL_TARGET_STATES: readonly ApprovalTargetState[] = ['approved', 'rolled_back'];

function decodeRegionApprovalState(value: string): RegionApprovalState {
  for (const candidate of REGION_APPROVAL_STATES) {
    if (candidate === value) return candidate;
  }
  throw new StorageError(
    'check_violation',
    `unexpected region binding approval state: ${value}`,
    { value },
  );
}

function decodeProposalState(value: string): ProposalState {
  switch (value) {
    case 'draft':
    case 'proposed':
    case 'validated':
    case 'previewing':
    case 'approved':
    case 'applying':
    case 'canonical_written':
    case 'propagating':
    case 'live':
    case 'reconciled':
    case 'apply_failed':
    case 'deploy_pending':
    case 'deploy_failed':
    case 'reconcile_pending':
    case 'rolled_back':
    case 'refused':
      return value;
    default:
      throw new StorageError('check_violation', `unexpected proposal state: ${value}`, { value });
  }
}

function decodeApprovalTargetState(value: string): ApprovalTargetState {
  for (const candidate of APPROVAL_TARGET_STATES) {
    if (candidate === value) return candidate;
  }
  throw new StorageError(
    'check_violation',
    `unexpected approval target state: ${value}`,
    { value },
  );
}

function toTenantRow(row: RawTenant): TenantRow {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    metadata: row.metadata,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
  };
}

function toActorRow(row: RawActor): ActorRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    slug: row.slug,
    displayName: row.displayName,
    issuer: row.issuer,
    publicKeyKid: row.publicKeyKid,
    declaredCapabilities: row.declaredCapabilities,
    verified: row.verified,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
  };
}

function toRegionBindingRow(row: RawRegionBinding): RegionBindingRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    adapterId: row.adapterId,
    canonicalSource: row.canonicalSource,
    derivedArtifacts: row.derivedArtifacts,
    regenerationContract: row.regenerationContract,
    schema: row.schema,
    localePolicy: row.localePolicy,
    mediaFields: row.mediaFields,
    fieldCapabilities: row.fieldCapabilities,
    approvalState: decodeRegionApprovalState(row.approvalState),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    approvedAt: row.approvedAt,
    approvedByActorId: row.approvedByActorId,
  };
}

function toProposalRow(row: RawProposal): ProposalRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    regionBindingId: row.regionBindingId,
    slug: row.slug,
    proposedByActorId: row.proposedByActorId,
    delegatedHumanActorId: row.delegatedHumanActorId,
    title: row.title,
    payload: row.payload,
    payloadHash: row.payloadHash,
    state: decodeProposalState(row.state),
    version: row.version,
    validatedAt: row.validatedAt,
    approvedAt: row.approvedAt,
    canonicalWrittenAt: row.canonicalWrittenAt,
    liveAt: row.liveAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toApprovalRow(row: RawApproval): ApprovalRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    proposalId: row.proposalId,
    approverActorId: row.approverActorId,
    delegatedHumanActorId: row.delegatedHumanActorId,
    selfApproved: row.selfApproved,
    role: row.role,
    contentType: row.contentType,
    environment: row.environment,
    note: row.note,
    targetState: decodeApprovalTargetState(row.targetState),
    rollbackTargetProposalId: row.rollbackTargetProposalId,
    createdAt: row.createdAt,
  };
}

function toRevisionRow(row: RawRevision): RevisionRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    proposalId: row.proposalId,
    regionBindingId: row.regionBindingId,
    kind: row.kind,
    version: row.version,
    slug: row.slug,
    parentRevisionId: row.parentRevisionId,
    beforeRef: row.beforeRef,
    afterRef: row.afterRef,
    beforeHash: row.beforeHash,
    afterHash: row.afterHash,
    actorId: row.actorId,
    approverActorId: row.approverActorId,
    selfApproved: row.selfApproved,
    rollbackTargetRevisionId: row.rollbackTargetRevisionId,
    diff: row.diff,
    diffHash: row.diffHash,
    createdAt: row.createdAt,
  };
}

function toPublicationRow(row: RawPublication): PublicationRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    proposalId: row.proposalId,
    canonicalRevisionId: row.canonicalRevisionId,
    status: row.status,
    canonicalWrittenAt: row.canonicalWrittenAt,
    liveAt: row.liveAt,
    failureReason: row.failureReason,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDeployReceiptRow(row: RawDeployReceipt): DeployReceiptRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    publicationId: row.publicationId,
    adapterId: row.adapterId,
    externalDeployId: row.externalDeployId,
    status: row.status,
    payload: row.payload,
    liveUrl: row.liveUrl,
    receivedAt: row.receivedAt,
    completedAt: row.completedAt,
  };
}

function toAuditEventRow(row: RawAuditEvent): AuditEventRow {
  return {
    eventHash: row.eventHash,
    tenantId: row.tenantId,
    actorId: row.actorId,
    delegatedHumanActorId: row.delegatedHumanActorId,
    proposalId: row.proposalId,
    approvalId: row.approvalId,
    occurredAt: row.occurredAt,
    schemaVersion: row.schemaVersion,
    selfApproved: row.selfApproved,
    event: row.event,
    persistedAt: row.persistedAt,
  };
}

function toIdempotencyRecordRow(row: RawIdempotencyRecord): IdempotencyRecordRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    endpoint: row.endpoint,
    outcome: row.outcome,
    response: row.response,
    responseStatus: row.responseStatus,
    lockedBy: row.lockedBy,
    lockExpiresAt: row.lockExpiresAt,
    createdAt: row.createdAt,
    finalizedAt: row.finalizedAt,
  };
}

// ---------------------------------------------------------------------------
// Postgres error classifier
// ---------------------------------------------------------------------------

interface PgError {
  code?: string;
  constraint?: string;
  table?: string;
  detail?: string;
  message?: string;
}

function isPgError(value: unknown): value is PgError {
  return typeof value === 'object' && value !== null && 'code' in value;
}

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';
const PG_INTEGRITY_CONSTRAINT_VIOLATION = '23000';
const APPEND_ONLY_VIOLATION_SQLSTATE = 'P0001';

/**
 * Classify a Postgres-shaped error into the right StorageError subclass.
 * Exported so tests can verify trigger-driven classifications without
 * having to drive a real mutation through the storage layer. The marker
 * check guards against misclassifying a generic P0001 CHECK constraint
 * as append-only.
 */

export function classifyPgError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  if (!isPgError(err)) {
    return new StorageError(
      'transaction_aborted',
      err instanceof Error ? err.message : 'unknown storage error',
      err instanceof Error && err.stack ? { stack: err.stack } : undefined,
    );
  }
  const code = err.code ?? '';
  const constraint = err.constraint ?? 'unknown';
  const message = err.message ?? 'unknown storage error';

  // P0001 emitted by the append-only trigger always begins with APPEND_ONLY_MARKER.
  // CHECK constraints and other triggers also emit P0001; we disambiguate by the
  // stable marker so an accidental CHECK violation cannot be mis-classified as
  // append-only.
  if (code === APPEND_ONLY_VIOLATION_SQLSTATE && message.includes(APPEND_ONLY_MARKER)) {
    return new AppendOnlyViolationError(err.table ?? 'audit_events', {
      detail: err.detail,
      message,
    });
  }

  switch (code) {
    case PG_UNIQUE_VIOLATION:
      return new UniqueViolationError(constraint, { detail: err.detail });
    case PG_FOREIGN_KEY_VIOLATION:
      return new ForeignKeyViolationError(constraint, { detail: err.detail, table: err.table });
    case PG_CHECK_VIOLATION:
      return new CheckViolationError(constraint, { detail: err.detail, table: err.table });
    case PG_INTEGRITY_CONSTRAINT_VIOLATION:
      return new StorageError(
        'transaction_aborted',
        message,
        { code, constraint, table: err.table, detail: err.detail },
      );
    default:
      if (code === APPEND_ONLY_VIOLATION_SQLSTATE) {
        // P0001 without the marker is a generic RAISE EXCEPTION — bubble up as
        // transaction_aborted so callers do not silently treat it as
        // append-only.
        return new StorageError(
          'transaction_aborted',
          message,
          { code, constraint, table: err.table, detail: err.detail },
        );
      }
      return new StorageError(
        'transaction_aborted',
        message,
        { code, constraint, table: err.table, detail: err.detail },
      );
  }
}

// ---------------------------------------------------------------------------
// PostgresStorage implementation
// ---------------------------------------------------------------------------

/**
 * PostgresStorage constructor options. The class is normally constructed by
 * the `createPostgresStorage` factory; tests pass a pre-built `database`
 * handle to bind the same Drizzle/Postgres dialect against an in-process
 * engine (e.g. pglite) without going through a `pg.Pool`.
 */
export type PostgresStorageOptions =
  | {
      /** Postgres connection string (e.g. postgres://user:pass@host:5432/db). Required unless `pool` or `database` is supplied. */
      connectionString: string;
      /** Optional pre-constructed pg.Pool. When supplied, the storage does NOT own the pool and `close()` is a no-op. */
      pool?: undefined;
      /** Optional pre-constructed Drizzle handle. Mutually exclusive with `connectionString`/`pool`. */
      database?: undefined;
      /** Application name reported to Postgres. */
      applicationName?: string;
    }
  | {
      /** Required: a pre-constructed pg.Pool. The storage does NOT own the pool and `close()` is a no-op. */
      connectionString?: undefined;
      pool: pg.Pool;
      /** Optional pre-constructed Drizzle handle. Mutually exclusive with `connectionString`/`pool`. */
      database?: undefined;
      /** Application name reported to Postgres (only used for connection-string construction, ignored here). */
      applicationName?: string;
    }
  | {
      /** Pre-constructed Drizzle handle (e.g. bound to pglite). The storage does NOT own any underlying pool. */
      connectionString?: undefined;
      pool?: undefined;
      database: NodePgDatabase;
      /** Application name (diagnostic only; not used when `database` is supplied). */
      applicationName?: string;
    };

/**
 * PostgresStorage is the canonical Storage implementation. It owns a pg.Pool
 * and a Drizzle database handle. All mutating operations are wrapped in
 * transactions via `runInTransaction`; readers do not require a transaction.
 *
 * This class never holds an in-memory cache, fallback, or shadow store. A
 * connection failure surfaces as a `transaction_aborted` StorageError.
 */
export class PostgresStorage implements Storage {
  private readonly pool: pg.Pool | null;
  private readonly db: NodePgDatabase;
  private readonly ownsPool: boolean;

  /**
   * Schema object literal type used by Drizzle. Captured here so we can
   * pass it into both `drizzlePg()` (which infers the schema generic) and
   * any future narrowing of the bound handle.
   */
  private static readonly schemaObject = {
    actors,
    approvals,
    auditEvents,
    deployReceipts,
    idempotencyRecords,
    proposals,
    publications,
    regionBindings,
    revisions,
    tenants,
  } as const;

  constructor(options: PostgresStorageOptions) {
    if (options.database) {
      this.pool = null;
      this.ownsPool = false;
      this.db = options.database;
      return;
    }
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      if (typeof options.connectionString !== 'string' || options.connectionString.length === 0) {
        throw new InvalidInputError(
          'connectionString is required when no pg.Pool or Drizzle handle is supplied',
          { connectionString: options.connectionString },
        );
      }
      this.pool = new pg.Pool({
        connectionString: options.connectionString,
        application_name: options.applicationName ?? '@cms/storage',
        max: 10,
        idleTimeoutMillis: 30_000,
      });
      this.ownsPool = true;
    }
    // The schema-aware handle from Drizzle is structurally compatible with
    // the un-generic `NodePgDatabase` we expose; the cast pins the type
    // boundary so downstream operations use the declared query surface.
    this.db = drizzlePg(this.pool, { schema: PostgresStorage.schemaObject }) as unknown as NodePgDatabase;
  }

  async close(): Promise<void> {
    if (this.ownsPool && this.pool) {
      await this.pool.end();
    }
  }

  // -------------------------------------------------------------------------
  // Tenant guard — central write gate for every tenant-scoped mutator.
  // -------------------------------------------------------------------------

  /**
   * Throws TenantDisabledError when `tenantId` refers to a disabled tenant.
   * Reads (`disabled_at IS NULL`) are permitted indefinitely; writes are
   * refused once a tenant is disabled so audit lineage stays reconstructible
   * while further state transitions are blocked. Used as the very first
   * step of every tenant-scoped mutator so the policy lives in one place.
   */
  async assertTenantEnabled(tenantId: string): Promise<void> {
    const [row] = await this.db
      .select({ disabledAt: tenants.disabledAt })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundError('tenant', { tenantId });
    if (row.disabledAt !== null) throw new TenantDisabledError(tenantId);
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  async runInTransaction<T>(work: Transactional<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        // Build a tx-scoped storage that shares the same db bind and rebinds
        // its Drizzle handle to the active transaction so every operation
        // inside `work` participates in the same atomic boundary.
        const txStorage = new PostgresStorage({ database: tx });
        return await work(txStorage);
      });
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Tenants
  // -------------------------------------------------------------------------

  async createTenant(input: CreateTenantInput): Promise<TenantRow> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.slug)) {
      throw new InvalidInputError('tenant slug must be lowercase alphanumeric with ._-', { slug: input.slug });
    }
    if (input.displayName.length < 1 || input.displayName.length > 256) {
      throw new InvalidInputError('tenant displayName must be 1..256 chars');
    }
    try {
      const [row] = await this.db
        .insert(tenants)
        .values({
          slug: input.slug,
          displayName: input.displayName,
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!row) throw new StorageError('transaction_aborted', 'insert returned no row');
      return toTenantRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async disableTenant(input: DisableTenantInput): Promise<TenantRow> {
    // Idempotent: if the tenant is already disabled, return the current row
    // instead of throwing NotFound. This keeps retry-safe admin tooling in
    // line with the rest of the storage layer.
    try {
      const [existing] = await this.db
        .select()
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      if (!existing) throw new NotFoundError('tenant', { tenantId: input.tenantId });
      if (existing.disabledAt !== null) return toTenantRow(existing);
      const [row] = await this.db
        .update(tenants)
        .set({ disabledAt: sql`now()` })
        .where(and(eq(tenants.id, input.tenantId), sql`${tenants.disabledAt} IS NULL`))
        .returning();
      if (!row) {
        // Concurrent disable: re-read and return the current row.
        const [reRead] = await this.db
          .select()
          .from(tenants)
          .where(eq(tenants.id, input.tenantId))
          .limit(1);
        if (!reRead) throw new NotFoundError('tenant', { tenantId: input.tenantId });
        return toTenantRow(reRead);
      }
      return toTenantRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async getTenantById(tenantId: string): Promise<TenantRow | null> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return row ? toTenantRow(row) : null;
  }

  async getTenantBySlug(slug: string): Promise<TenantRow | null> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    return row ? toTenantRow(row) : null;
  }

  // -------------------------------------------------------------------------
  // Actors
  // -------------------------------------------------------------------------

  async upsertActor(input: UpsertActorInput): Promise<ActorRow> {
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(input.slug)) {
      throw new InvalidInputError('actor slug must match [a-z0-9][a-z0-9._:-]{0,127}', { slug: input.slug });
    }
    if (input.kind === 'service' && input.displayName !== undefined) {
      throw new InvalidInputError('service actors must not have a displayName');
    }
    await this.assertTenantEnabled(input.tenantId);
    try {
      // Read-modify-write: the on-conflict branch must preserve `verified` when
      // the caller does not explicitly set it, otherwise re-enabling a disabled
      // actor would silently mark it as verified. To do that atomically we
      // first upsert with a temporary `verified` value, then patch if the
      // caller did not request a change. A single INSERT ... ON CONFLICT
      // DO UPDATE preserves the existing value via a self-reference (`excluded`
      // semantics would otherwise overwrite).
      const [row] = await this.db
        .insert(actors)
        .values({
          tenantId: input.tenantId,
          kind: input.kind,
          slug: input.slug,
          displayName: input.displayName ?? null,
          issuer: input.issuer ?? null,
          publicKeyKid: input.publicKeyKid ?? null,
          declaredCapabilities: input.declaredCapabilities ?? {},
          verified: input.verified ?? false,
        })
        .onConflictDoUpdate({
          target: [actors.tenantId, actors.slug],
          set: {
            kind: input.kind,
            displayName: input.displayName ?? null,
            issuer: input.issuer ?? null,
            publicKeyKid: input.publicKeyKid ?? null,
            declaredCapabilities: input.declaredCapabilities ?? {},
            verified: input.verified !== undefined
              ? input.verified
              : sql`${actors.verified}`,
            disabledAt: null,
          },
        })
        .returning();
      if (!row) throw new StorageError('transaction_aborted', 'upsert returned no row');
      return toActorRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  /**
   * Look up an actor by id, scoped to a tenant. Cross-tenant lookups are not
   * permitted — the tenant boundary is enforced at the query level so a
   * compromise in one tenant cannot read actor rows from another.
   */
  async getActorById(tenantId: string, actorId: string): Promise<ActorRow | null> {
    const [row] = await this.db
      .select()
      .from(actors)
      .where(and(eq(actors.tenantId, tenantId), eq(actors.id, actorId)))
      .limit(1);
    return row ? toActorRow(row) : null;
  }

  async getActorBySlug(tenantId: string, slug: string): Promise<ActorRow | null> {
    const [row] = await this.db
      .select()
      .from(actors)
      .where(and(eq(actors.tenantId, tenantId), eq(actors.slug, slug)))
      .limit(1);
    return row ? toActorRow(row) : null;
  }

  // -------------------------------------------------------------------------
  // Region bindings
  // -------------------------------------------------------------------------

  async upsertRegionBinding(input: UpsertRegionBindingInput): Promise<RegionBindingRow> {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.slug)) {
      throw new InvalidInputError('region slug must match [a-z0-9][a-z0-9._-]{0,127}', { slug: input.slug });
    }
    if (typeof input.canonicalSource !== 'object' || input.canonicalSource === null) {
      throw new InvalidInputError('canonicalSource must be an object');
    }
    if (!input.regenerationContract || !input.regenerationContract.mode) {
      throw new InvalidInputError('regenerationContract.mode is required');
    }
    await this.assertTenantEnabled(input.tenantId);

    // Frozen-core guard: if an existing binding is `approved` or `retired`,
    // refuse to overwrite. Redirecting a canonical source requires retiring
    // the existing binding explicitly and creating a new one — never silently
    // rewriting an approved frozen core.
    try {
      const [existing] = await this.db
        .select({ approvalState: regionBindings.approvalState, version: regionBindings.version })
        .from(regionBindings)
        .where(and(eq(regionBindings.tenantId, input.tenantId), eq(regionBindings.slug, input.slug)))
        .limit(1);
      if (existing && (existing.approvalState === 'approved' || existing.approvalState === 'retired')) {
        throw new InvalidInputError(
          `${FROZEN_CORE_REFUSED_MARKER} (state=${existing.approvalState}, version=${existing.version})`,
          {
            tenantId: input.tenantId,
            slug: input.slug,
            approvalState: existing.approvalState,
            version: existing.version,
          },
        );
      }

      const [row] = await this.db
        .insert(regionBindings)
        .values({
          tenantId: input.tenantId,
          slug: input.slug,
          adapterId: input.adapterId,
          canonicalSource: input.canonicalSource,
          derivedArtifacts: input.derivedArtifacts ?? [],
          regenerationContract: input.regenerationContract,
          schema: input.schema,
          localePolicy: input.localePolicy,
          mediaFields: input.mediaFields ?? [],
          fieldCapabilities: input.fieldCapabilities ?? {},
        })
        .onConflictDoUpdate({
          target: [regionBindings.tenantId, regionBindings.slug],
          set: {
            adapterId: input.adapterId,
            canonicalSource: input.canonicalSource,
            derivedArtifacts: input.derivedArtifacts ?? [],
            regenerationContract: input.regenerationContract,
            schema: input.schema,
            localePolicy: input.localePolicy,
            mediaFields: input.mediaFields ?? [],
            fieldCapabilities: input.fieldCapabilities ?? {},
            updatedAt: sql`now()`,
          },
        })
        .returning();
      if (!row) throw new StorageError('transaction_aborted', 'upsert returned no row');
      return toRegionBindingRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async approveRegionBinding(input: ApproveRegionBindingInput): Promise<RegionBindingRow> {
    await this.assertTenantEnabled(input.tenantId);
    try {
      const [row] = await this.db
        .update(regionBindings)
        .set({
          approvalState: 'approved',
          approvedAt: sql`now()`,
          approvedByActorId: input.approverActorId,
          version: sql`${regionBindings.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(regionBindings.tenantId, input.tenantId),
            eq(regionBindings.id, input.regionBindingId),
            eq(regionBindings.version, input.expectedVersion),
            eq(regionBindings.approvalState, 'pending'),
          ),
        )
        .returning();
      if (!row) {
        // Distinguish not-found from version-conflict.
        const [current] = await this.db
          .select()
          .from(regionBindings)
          .where(and(eq(regionBindings.tenantId, input.tenantId), eq(regionBindings.id, input.regionBindingId)))
          .limit(1);
        if (!current) throw new NotFoundError('region_binding', { regionBindingId: input.regionBindingId });
        throw new OptimisticConcurrencyError('region_binding', input.expectedVersion, {
          actualVersion: current.version,
          approvalState: current.approvalState,
        });
      }
      return toRegionBindingRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async retireRegionBinding(input: RetireRegionBindingInput): Promise<RegionBindingRow> {
    await this.assertTenantEnabled(input.tenantId);
    try {
      // Retiring is permitted from `pending` or `approved`. Once a binding
      // is `retired` or `refused`, retirement fails closed; callers create a
      // new binding rather than rewriting the frozen canonical core.
      const [row] = await this.db
        .update(regionBindings)
        .set({
          approvalState: 'retired',
          version: sql`${regionBindings.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(regionBindings.tenantId, input.tenantId),
            eq(regionBindings.id, input.regionBindingId),
            eq(regionBindings.version, input.expectedVersion),
            // Only pending/approved bindings are eligible for retirement.
            // SQL also serves as the immutability gate for the frozen core.
            sql`${regionBindings.approvalState} IN ('pending','approved')`,
          ),
        )
        .returning();
      if (!row) {
        const [current] = await this.db
          .select()
          .from(regionBindings)
          .where(and(eq(regionBindings.tenantId, input.tenantId), eq(regionBindings.id, input.regionBindingId)))
          .limit(1);
        if (!current) throw new NotFoundError('region_binding', { regionBindingId: input.regionBindingId });
        if (current.approvalState === 'retired' || current.approvalState === 'refused') {
          throw new InvalidInputError(
            `${REGION_RETIRE_TERMINAL_MARKER} (state=${current.approvalState}, version=${current.version})`,
            {
              tenantId: input.tenantId,
              regionBindingId: input.regionBindingId,
              approvalState: current.approvalState,
              version: current.version,
              reason: input.reason ?? null,
            },
          );
        }
        throw new OptimisticConcurrencyError('region_binding', input.expectedVersion, {
          actualVersion: current.version,
          approvalState: current.approvalState,
        });
      }
      return toRegionBindingRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async refuseRegionBinding(input: RefuseRegionBindingInput): Promise<RegionBindingRow> {
    await this.assertTenantEnabled(input.tenantId);
    try {
      // Refusal is permitted only from `pending`. Refusing an approved
      // binding would silently redirect an immutable frozen core — the
      // caller must use `retire` instead.
      const [row] = await this.db
        .update(regionBindings)
        .set({
          approvalState: 'refused',
          version: sql`${regionBindings.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(regionBindings.tenantId, input.tenantId),
            eq(regionBindings.id, input.regionBindingId),
            eq(regionBindings.version, input.expectedVersion),
            sql`${regionBindings.approvalState} = 'pending'`,
          ),
        )
        .returning();
      if (!row) {
        const [current] = await this.db
          .select()
          .from(regionBindings)
          .where(and(eq(regionBindings.tenantId, input.tenantId), eq(regionBindings.id, input.regionBindingId)))
          .limit(1);
        if (!current) throw new NotFoundError('region_binding', { regionBindingId: input.regionBindingId });
        if (current.approvalState !== 'pending') {
          throw new InvalidInputError(
            `${REGION_REFUSE_TERMINAL_MARKER} (state=${current.approvalState}, version=${current.version})`,
            {
              tenantId: input.tenantId,
              regionBindingId: input.regionBindingId,
              approvalState: current.approvalState,
              version: current.version,
              reason: input.reason ?? null,
            },
          );
        }
        throw new OptimisticConcurrencyError('region_binding', input.expectedVersion, {
          actualVersion: current.version,
          approvalState: current.approvalState,
        });
      }
      return toRegionBindingRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async getRegionBindingById(tenantId: string, regionBindingId: string): Promise<RegionBindingRow | null> {
    const [row] = await this.db
      .select()
      .from(regionBindings)
      .where(and(eq(regionBindings.tenantId, tenantId), eq(regionBindings.id, regionBindingId)))
      .limit(1);
    return row ? toRegionBindingRow(row) : null;
  }

  async getRegionBindingBySlug(tenantId: string, slug: string): Promise<RegionBindingRow | null> {
    const [row] = await this.db
      .select()
      .from(regionBindings)
      .where(and(eq(regionBindings.tenantId, tenantId), eq(regionBindings.slug, slug)))
      .limit(1);
    return row ? toRegionBindingRow(row) : null;
  }

  // -------------------------------------------------------------------------
  // Proposals
  // -------------------------------------------------------------------------

  async createProposal(input: CreateProposalInput): Promise<ProposalRow> {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.slug)) {
      throw new InvalidInputError('proposal slug must match [a-z0-9][a-z0-9._-]{0,127}', { slug: input.slug });
    }
    if (!/^[0-9a-f]{64}$/.test(input.payloadHash)) {
      throw new InvalidInputError('payloadHash must be 64-char lowercase hex');
    }
    if (input.title.length < 1 || input.title.length > 256) {
      throw new InvalidInputError('proposal title must be 1..256 chars');
    }
    await this.assertTenantEnabled(input.tenantId);
    return await this.runInTransaction(async (tx) => {
      // Acquire the idempotency lock first; this row is the gate. If the
      // record is already in a terminal state (succeeded/failed) we MUST
      // short-circuit and surface the recorded response — re-inserting a
      // proposal under the same key would either violate the unique index
      // or duplicate the side effect.
      const replay = await tx.beginIdempotency({
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        endpoint: input.endpoint,
        lockedBy: 'createProposal',
        lockTtlSeconds: 60,
      });
      // Extract a recorded proposalId from the response payload when present.
      const response = replay.record.response as { proposalId?: unknown; slug?: unknown } | null;
      const recordedProposalId = typeof response?.proposalId === 'string' ? response.proposalId : null;
      if (replay.source === 'failed') {
        // Replay of a `failed` outcome: surface the failure transparently
        // regardless of whether the response payload references a proposal.
        // Throwing here is correct — the caller will receive the recorded
        // status + response and can map them to an HTTP error.
        throw new StorageError(
          'transaction_aborted',
          'idempotent createProposal replay of a previously failed attempt',
          {
            tenantId: input.tenantId,
            idempotencyKey: input.idempotencyKey,
            proposalId: recordedProposalId,
            response: replay.record.response,
            responseStatus: replay.record.responseStatus,
          },
        );
      }
      if (replay.source === 'succeeded') {
        // Replay of a `succeeded` outcome: surface the recorded proposal
        // without re-inserting. If the recorded response doesn't reference
        // a proposalId (a legacy record or third-party writer), we cannot
        // resolve the row — bubble up as a transaction_aborted error.
        if (!recordedProposalId) {
          throw new StorageError(
            'transaction_aborted',
            'idempotency replay succeeded without a recorded proposalId',
            { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey },
          );
        }
        const existing = await tx.getProposalById(input.tenantId, recordedProposalId);
        if (!existing) {
          throw new StorageError(
            'transaction_aborted',
            'idempotency replay referenced a missing proposal',
            { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey, proposalId: recordedProposalId },
          );
        }
        return existing;
      }
      // replay.source === 'in_progress': fall through to the insert path.
      const [row] = await tx.__db()
        .insert(proposals)
        .values({
          tenantId: input.tenantId,
          regionBindingId: input.regionBindingId,
          slug: input.slug,
          proposedByActorId: input.proposedByActorId,
          delegatedHumanActorId: input.delegatedHumanActorId ?? null,
          title: input.title,
          payload: input.payload,
          payloadHash: input.payloadHash,
          state: 'draft',
        })
        .returning();
      if (!row) throw new StorageError('transaction_aborted', 'proposal insert returned no row');
      await tx.finalizeIdempotency({
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        outcome: 'succeeded',
        response: { proposalId: row.id, slug: row.slug },
        responseStatus: 201,
      });
      return toProposalRow(row);
    });
  }

  async transitionProposal(input: TransitionProposalInput): Promise<ProposalRow> {
    await this.assertTenantEnabled(input.tenantId);
    const updates: Record<string, unknown> = {
      state: input.nextState,
      version: sql`${proposals.version} + 1`,
      updatedAt: sql`now()`,
    };
    if (input.validatedAt !== undefined) updates.validatedAt = input.validatedAt;
    if (input.approvedAt !== undefined) updates.approvedAt = input.approvedAt;
    if (input.canonicalWrittenAt !== undefined) updates.canonicalWrittenAt = input.canonicalWrittenAt;
    if (input.liveAt !== undefined) updates.liveAt = input.liveAt;
    try {
      const [row] = await this.db
        .update(proposals)
        .set(updates)
        .where(
          and(
            eq(proposals.tenantId, input.tenantId),
            eq(proposals.id, input.proposalId),
            eq(proposals.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        const [current] = await this.db
          .select()
          .from(proposals)
          .where(and(eq(proposals.tenantId, input.tenantId), eq(proposals.id, input.proposalId)))
          .limit(1);
        if (!current) throw new NotFoundError('proposal', { proposalId: input.proposalId });
        throw new OptimisticConcurrencyError('proposal', input.expectedVersion, { actualVersion: current.version });
      }
      return toProposalRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async getProposalById(tenantId: string, proposalId: string): Promise<ProposalRow | null> {
    const [row] = await this.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId)))
      .limit(1);
    return row ? toProposalRow(row) : null;
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  async recordApproval(input: RecordApprovalInput): Promise<ApprovalRow> {
    if (input.role.length < 1 || input.role.length > 64) {
      throw new InvalidInputError('approval role must be 1..64 chars');
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.contentType)) {
      throw new InvalidInputError('approval contentType must match [a-z0-9][a-z0-9._-]{0,127}', { contentType: input.contentType });
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.environment)) {
      throw new InvalidInputError('approval environment must match [a-z0-9][a-z0-9._-]{0,63}', { environment: input.environment });
    }
    if (input.selfApproved && input.delegatedHumanActorId !== undefined) {
      throw new InvalidInputError('selfApproved approvals must not have a delegatedHumanActorId');
    }
    await this.assertTenantEnabled(input.tenantId);
    try {
      const [row] = await this.db
        .insert(approvals)
        .values({
          tenantId: input.tenantId,
          proposalId: input.proposalId,
          approverActorId: input.approverActorId,
          delegatedHumanActorId: input.delegatedHumanActorId ?? null,
          selfApproved: input.selfApproved,
          role: input.role,
          contentType: input.contentType,
          environment: input.environment,
          note: input.note ?? null,
          targetState: input.targetState,
          rollbackTargetProposalId: input.rollbackTargetProposalId ?? null,
        })
        .returning();
      if (!row) throw new StorageError('transaction_aborted', 'approval insert returned no row');
      return toApprovalRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Revisions
  // -------------------------------------------------------------------------

  async appendRevision(input: AppendRevisionInput): Promise<RevisionRow> {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.slug)) {
      throw new InvalidInputError('revision slug must match [a-z0-9][a-z0-9._-]{0,127}', { slug: input.slug });
    }
    if (!/^[0-9a-f]{64}$/.test(input.diffHash)) {
      throw new InvalidInputError('diffHash must be 64-char lowercase hex');
    }
    await this.assertTenantEnabled(input.tenantId);
    try {
      // The proposal-lineage `version` is computed under a row-level lock on
      // the proposal row's parent revision. We claim a SELECT ... FOR UPDATE
      // advisory hash derived from (tenantId, proposalId) so two concurrent
      // appendRevision calls serialize without a higher-level advisory lock
      // service. The `revisions_proposal_version_uq` UNIQUE index is the
      // secondary guarantee — even if both computations raced to the same
      // number, the second insert would fail with a UNIQUE_VIOLATION that we
      // surface as an optimistic-concurrency conflict.
      const result = await this.db.transaction(async (tx) => {
        // We derive a stable 31-bit hash from the (tenant, proposal) tuple
        // and acquire a transaction-scoped advisory lock so concurrent
        // appendRevision calls on the same proposal serialize. The
        // `revisions_proposal_version_uq` UNIQUE index is the secondary
        // guarantee if the lock is ever bypassed (e.g. by a non-storage
        // writer); the insert will fail with UNIQUE_VIOLATION which we
        // map to OptimisticConcurrencyError.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${input.tenantId} || ':' || ${input.proposalId}))`,
        );
        const existing = await tx
          .select({ v: revisions.version })
          .from(revisions)
          .where(and(eq(revisions.tenantId, input.tenantId), eq(revisions.proposalId, input.proposalId)));
        const nextVersion = existing.reduce((m, r) => (r.v > m ? r.v : m), 0) + 1;
        try {
          const [row] = await tx
            .insert(revisions)
            .values({
              tenantId: input.tenantId,
              proposalId: input.proposalId,
              regionBindingId: input.regionBindingId,
              kind: input.kind,
              version: nextVersion,
              slug: input.slug,
              parentRevisionId: input.parentRevisionId ?? null,
              beforeRef: input.beforeRef ?? null,
              afterRef: input.afterRef ?? null,
              beforeHash: input.beforeHash ?? null,
              afterHash: input.afterHash ?? null,
              actorId: input.actorId,
              approverActorId: input.approverActorId ?? null,
              selfApproved: input.selfApproved,
              rollbackTargetRevisionId: input.rollbackTargetRevisionId ?? null,
              diff: input.diff,
              diffHash: input.diffHash,
            })
            .returning();
          if (!row) throw new StorageError('transaction_aborted', 'revision insert returned no row');
          return row;
        } catch (err) {
          if (isPgError(err) && err.code === PG_UNIQUE_VIOLATION) {
            throw new OptimisticConcurrencyError('revision_lineage', nextVersion, {
              tenantId: input.tenantId,
              proposalId: input.proposalId,
              constraint: err.constraint,
            });
          }
          throw err;
        }
      });
      return toRevisionRow(result);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async listRevisionsForProposal(tenantId: string, proposalId: string): Promise<readonly RevisionRow[]> {
    const rows = await this.db
      .select()
      .from(revisions)
      .where(and(eq(revisions.tenantId, tenantId), eq(revisions.proposalId, proposalId)))
      .orderBy(revisions.version);
    return rows.map(toRevisionRow);
  }

  // -------------------------------------------------------------------------
  // Publications
  // -------------------------------------------------------------------------

  async recordPublication(input: RecordPublicationInput): Promise<PublicationRow> {
    await this.assertTenantEnabled(input.tenantId);
    try {
      const [row] = await this.db
        .insert(publications)
        .values({
          tenantId: input.tenantId,
          proposalId: input.proposalId,
          canonicalRevisionId: input.canonicalRevisionId,
          status: 'canonical_written',
          canonicalWrittenAt: sql`now()`,
        })
        .returning();
      if (!row) throw new StorageError('transaction_aborted', 'publication insert returned no row');
      return toPublicationRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async transitionPublication(input: TransitionPublicationInput): Promise<PublicationRow> {
    await this.assertTenantEnabled(input.tenantId);
    const updates: Record<string, unknown> = {
      status: input.nextStatus,
      version: sql`${publications.version} + 1`,
      updatedAt: sql`now()`,
    };
    if (input.liveAt !== undefined) updates.liveAt = input.liveAt;
    if (input.failureReason !== undefined) updates.failureReason = input.failureReason;
    try {
      const [row] = await this.db
        .update(publications)
        .set(updates)
        .where(
          and(
            eq(publications.tenantId, input.tenantId),
            eq(publications.id, input.publicationId),
            eq(publications.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        const [current] = await this.db
          .select()
          .from(publications)
          .where(and(eq(publications.tenantId, input.tenantId), eq(publications.id, input.publicationId)))
          .limit(1);
        if (!current) throw new NotFoundError('publication', { publicationId: input.publicationId });
        throw new OptimisticConcurrencyError('publication', input.expectedVersion, { actualVersion: current.version });
      }
      return toPublicationRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Deploy receipts
  // -------------------------------------------------------------------------

  async recordDeployReceipt(input: RecordDeployReceiptInput): Promise<DeployReceiptRow> {
    if (!/^[a-z0-9@/][a-z0-9@/_.-]{0,127}$/.test(input.adapterId)) {
      throw new InvalidInputError('adapterId must match [a-z0-9@/][a-z0-9@/_.-]{0,127}', { adapterId: input.adapterId });
    }
    if (input.externalDeployId.length < 1 || input.externalDeployId.length > 256) {
      throw new InvalidInputError('externalDeployId must be 1..256 chars');
    }
    await this.assertTenantEnabled(input.tenantId);
    try {
      const [row] = await this.db
        .insert(deployReceipts)
        .values({
          tenantId: input.tenantId,
          publicationId: input.publicationId,
          adapterId: input.adapterId,
          externalDeployId: input.externalDeployId,
          status: input.status ?? 'pending',
          payload: input.payload ?? {},
          liveUrl: input.liveUrl ?? null,
          completedAt: input.completedAt ?? null,
        })
        .returning();
      if (!row) throw new StorageError('transaction_aborted', 'deploy receipt insert returned no row');
      return toDeployReceiptRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Audit events (append-only)
  // -------------------------------------------------------------------------

  async appendAuditEvent(input: AppendAuditEventInput): Promise<AuditEventRow> {
    if (!/^[0-9a-f]{64}$/.test(input.eventHash)) {
      throw new InvalidInputError('eventHash must be 64-char lowercase hex');
    }
    if (input.selfApproved && input.delegatedHumanActorId !== undefined) {
      throw new InvalidInputError('selfApproved audit events must not have a delegatedHumanActorId');
    }
    await this.assertTenantEnabled(input.tenantId);
    try {
      const [row] = await this.db
        .insert(auditEvents)
        .values({
          eventHash: input.eventHash,
          tenantId: input.tenantId,
          actorId: input.actorId,
          delegatedHumanActorId: input.delegatedHumanActorId ?? null,
          proposalId: input.proposalId ?? null,
          approvalId: input.approvalId ?? null,
          occurredAt: input.occurredAt,
          schemaVersion: input.schemaVersion ?? 1,
          selfApproved: input.selfApproved,
          event: input.event,
        })
        .returning();
      if (!row) throw new StorageError('transaction_aborted', 'audit event insert returned no row');
      return toAuditEventRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async getAuditEventByHash(tenantId: string, eventHash: string): Promise<AuditEventRow | null> {
    const [row] = await this.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventHash, eventHash)))
      .limit(1);
    return row ? toAuditEventRow(row) : null;
  }

  async listAuditEventsForProposal(tenantId: string, proposalId: string): Promise<readonly AuditEventRow[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.proposalId, proposalId)))
      .orderBy(auditEvents.occurredAt);
    return rows.map(toAuditEventRow);
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  /**
   * Begin (or replay) an idempotency attempt. Returns an `IdempotencyReplay`
   * whose `source` discriminator tells the caller exactly what to do:
   *
   *  - `in_progress`: a fresh lock was acquired; the caller MAY proceed with
   *    the side effect, then call `finalizeIdempotency` to record the result.
   *  - `succeeded`: a previously-recorded successful response exists; the
   *    caller MUST short-circuit and surface the recorded response. Re-running
   *    the side effect would violate idempotency.
   *  - `failed`: a previously-recorded failed response exists; the caller MUST
   *    treat this as a replay of the recorded failure. Re-running the side
   *    effect would violate idempotency and may cause additional damage
   *    (e.g. duplicate external deploys).
   *
   * The stale-lock reclaim is atomic: a single UPDATE re-claims the lock
   * only when the row is still `in_progress` AND either `lock_expires_at` is
   * in the past or `NULL` (defensive). The unique constraint
   * `(tenant_id, idempotency_key)` ensures concurrent callers serialize.
   */
  async beginIdempotency(input: BeginIdempotencyInput): Promise<IdempotencyReplay> {
    if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 256) {
      throw new InvalidInputError('idempotencyKey must be 1..256 chars');
    }
    if (!/^[0-9a-f]{64}$/.test(input.requestFingerprint)) {
      throw new InvalidInputError('requestFingerprint must be 64-char lowercase hex');
    }
    if (input.endpoint.length < 1 || input.endpoint.length > 128) {
      throw new InvalidInputError('endpoint must be 1..128 chars');
    }
    if (!Number.isFinite(input.lockTtlSeconds) || input.lockTtlSeconds <= 0) {
      throw new InvalidInputError('lockTtlSeconds must be a positive finite number');
    }
    await this.assertTenantEnabled(input.tenantId);
    const expiry = new Date(Date.now() + input.lockTtlSeconds * 1000);
    try {
      const [inserted] = await this.db
        .insert(idempotencyRecords)
        .values({
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          endpoint: input.endpoint,
          outcome: 'in_progress',
          lockedBy: input.lockedBy,
          lockExpiresAt: expiry,
        })
        .onConflictDoNothing({ target: [idempotencyRecords.tenantId, idempotencyRecords.idempotencyKey] })
        .returning();
      if (inserted) {
        return { source: 'in_progress', record: toIdempotencyRecordRow(inserted) };
      }

      // Replay path: read the existing row. The UNIQUE index made the
      // INSERT a no-op, so a row must exist.
      const [existing] = await this.db
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.tenantId, input.tenantId),
            eq(idempotencyRecords.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new StorageError('transaction_aborted', 'idempotency conflict but no record found');
      }
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new IdempotencyReplayMismatchError({
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
        });
      }
      if (existing.outcome === 'in_progress') {
        // Active lock with a future expiry => refuse.
        if (existing.lockExpiresAt && existing.lockExpiresAt > new Date()) {
          throw new IdempotencyInProgressError({
            tenantId: input.tenantId,
            idempotencyKey: input.idempotencyKey,
            lockExpiresAt: existing.lockExpiresAt,
          });
        }
        // Stale lock: atomic reclaim. The WHERE clause pins the row to
        // outcome='in_progress' AND (lock_expires_at IS NULL OR
        // lock_expires_at <= now()); only one caller can win the UPDATE.
        const [claimed] = await this.db
          .update(idempotencyRecords)
          .set({
            lockedBy: input.lockedBy,
            lockExpiresAt: expiry,
            requestFingerprint: input.requestFingerprint,
            endpoint: input.endpoint,
          })
          .where(
            and(
              eq(idempotencyRecords.tenantId, input.tenantId),
              eq(idempotencyRecords.idempotencyKey, input.idempotencyKey),
              eq(idempotencyRecords.outcome, 'in_progress'),
              sql`(${idempotencyRecords.lockExpiresAt} IS NULL OR ${idempotencyRecords.lockExpiresAt} <= now())`,
            ),
          )
          .returning();
        if (!claimed) {
          throw new IdempotencyInProgressError({
            tenantId: input.tenantId,
            idempotencyKey: input.idempotencyKey,
          });
        }
        return { source: 'in_progress', record: toIdempotencyRecordRow(claimed) };
      }

      // Terminal outcome: succeeded or failed. The caller MUST short-circuit.
      const source: 'succeeded' | 'failed' = existing.outcome;
      return { source, record: toIdempotencyRecordRow(existing) };
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async finalizeIdempotency(input: FinalizeIdempotencyInput): Promise<IdempotencyRecordRow> {
    if (!Number.isInteger(input.responseStatus) || input.responseStatus < 100 || input.responseStatus > 599) {
      throw new InvalidInputError('responseStatus must be an integer in 100..599');
    }
    await this.assertTenantEnabled(input.tenantId);
    try {
      const [row] = await this.db
        .update(idempotencyRecords)
        .set({
          outcome: input.outcome,
          response: input.response,
          responseStatus: input.responseStatus,
          lockedBy: null,
          lockExpiresAt: null,
          finalizedAt: sql`now()`,
        })
        .where(
          and(
            eq(idempotencyRecords.tenantId, input.tenantId),
            eq(idempotencyRecords.idempotencyKey, input.idempotencyKey),
            eq(idempotencyRecords.outcome, 'in_progress'),
          ),
        )
        .returning();
      if (!row) throw new NotFoundError('idempotency_record', {
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
      });
      return toIdempotencyRecordRow(row);
    } catch (err) {
      throw classifyPgError(err);
    }
  }

  async releaseIdempotency(tenantId: string, idempotencyKey: string): Promise<void> {
    await this.db
      .update(idempotencyRecords)
      .set({ lockedBy: null, lockExpiresAt: null })
      .where(
        and(
          eq(idempotencyRecords.tenantId, tenantId),
          eq(idempotencyRecords.idempotencyKey, idempotencyKey),
          eq(idempotencyRecords.outcome, 'in_progress'),
        ),
      );
  }

  // -------------------------------------------------------------------------
  // Internal — bound to a Drizzle tx handle inside runInTransaction.
  // Exposed with a double-underscore prefix so the surface is greppable and
  // consumers know it is NOT a public API.
  // -------------------------------------------------------------------------

  /** @internal Returns the underlying Drizzle handle for transactional callbacks. */
  __db(): NodePgDatabase {
    return this.db;
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Construct a PostgresStorage from a connection string. The connection is
 * validated on first use; construction itself is non-blocking. Failures
 * surface as `transaction_aborted` StorageError at first query.
 */
export function createPostgresStorage(connectionString: string, applicationName?: string): PostgresStorage {
  if (applicationName !== undefined) {
    return new PostgresStorage({ connectionString, applicationName });
  }
  return new PostgresStorage({ connectionString });
}