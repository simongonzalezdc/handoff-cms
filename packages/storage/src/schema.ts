/**
 * Drizzle schema for the @cms/storage governance persistence layer.
 *
 * Scope:
 *   This module models GOVERNANCE DATA ONLY. The CMS owns:
 *     - tenants, actors, region bindings, proposals, approvals, revisions,
 *       publications, deploy receipts, audit events, and idempotency records.
 *   It does NOT model canonical CMS content/assets. The host repository,
 *   database, object store, or backing CMS remains canonical; this package
 *   only persists governed deltas, before/after references, diffs, and the
 *   metadata required to enforce propose/approve/publish/audit/rollback.
 *
 * Conventions:
 *   - All timestamps are stored as `timestamp with time zone` (timestamptz)
 *     and surfaced to TypeScript as `Date`.
 *   - JSON-shaped governance metadata is stored as `jsonb` deliberately:
 *     (a) when the schema is open by design (e.g. capability declarations,
 *     media field declarations, regeneration contracts), or (b) when an
 *     external audit/canonical hash pins the payload (e.g. audit event
 *     envelopes, revision diff blobs). Closed-shape relational fields live
 *     in typed columns.
 *   - Every tenant-scoped row carries `tenant_id` and is indexed on it.
 *     Foreign keys reference `tenants.id` with ON DELETE RESTRICT.
 *   - Optimistic concurrency is enforced via a monotonic `version` column
 *     (BIGINT NOT NULL DEFAULT 1) on mutable tables; updates assert the
 *     expected version and bump it under a single UPDATE.
 *   - Append-only: `audit_events` carries schema-enforced immutability via
 *     BEFORE UPDATE/DELETE/TRUNCATE triggers (see migration). `idempotency_records`
 *     transitions from in_progress to a terminal outcome under the same
 *     transaction that produced the response, so it is NOT append-only at the
 *     SQL layer; its in_progress -> terminal transition is enforced by the
 *     CHECK constraints on this table.
 *   - Idempotency: `(tenant_id, idempotency_key)` is UNIQUE. Replays return
 *     the recorded response, never re-execute the side effect.
 *
 * Schema namespace: `cms_storage` is reserved for this package. Downstream
 * packages may coexist in the same database under their own namespaces.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,

  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/** Reserved Postgres schema namespace for this package. */
export const storageSchema = pgSchema('cms_storage');

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

/**
 * A tenant is an isolated governance boundary. Every tenant-scoped row
 * references `tenants.id`. Tenants are soft-deactivated via `disabled_at`
 * rather than deleted so audit lineage remains reconstructible.
 */
export const tenants = storageSchema.table(
  'tenants',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** Stable lowercase slug used in URIs, audit envelopes, and OAuth audiences. */
    slug: varchar('slug', { length: 64 }).notNull(),
    /** Human-readable display name (en/es peer-locale key, resolved upstream). */
    displayName: text('display_name').notNull(),
    /** Free-form key=value metadata (region defaults, branding, etc.). */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Tenant creation time. Never updated. */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
    /** Soft-disable timestamp; rows remain readable but writes are refused. */
    disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('tenants_slug_uq').on(table.slug),
    check('tenants_slug_chk', sql`${table.slug} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`),
    check('tenants_display_name_chk', sql`length(${table.displayName}) BETWEEN 1 AND 256`),
    check('tenants_metadata_object_chk', sql`jsonb_typeof(${table.metadata}) = 'object'`),
  ],
);

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export type ActorKind = 'human' | 'agent' | 'service';

/**
 * An actor is a principal that originated a governance action.
 *
 *  - `human`: a person authenticating via OIDC; may delegate to an agent
 *    via a short-lived delegated-user session.
 *  - `agent`: an automated agent (e.g. MCP, CLI script). Never holds
 *    approval scope; approval is always attributed to a human.
 *  - `service`: a tenant-scoped service identity (client-credentials).
 *    Never holds approval scope.
 *
 * Approval scope is NOT modeled on `actors` — it is a runtime policy-engine
 * decision. This table records identity and provenance only.
 */
export const actors = storageSchema.table(
  'actors',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    kind: varchar('kind', { length: 16 }).notNull().$type<ActorKind>(),
    /** Stable per-tenant actor slug (OIDC subject, MCP client id, etc.). */
    slug: varchar('slug', { length: 128 }).notNull(),
    /** Optional human display name. Forbidden for service identities. */
    displayName: text('display_name'),
    /** OIDC issuer URL when kind='human'; service id when kind='service'. */
    issuer: text('issuer'),
    /** Optional public key reference (kid) for verifying signed requests. */
    publicKeyKid: varchar('public_key_kid', { length: 128 }),
    /** Capabilities declared at provisioning time (jsonb); runtime policy is authoritative. */
    declaredCapabilities: jsonb('declared_capabilities').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** True once OIDC subject has been verified at least once. */
    verified: boolean('verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
    disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('actors_tenant_slug_uq').on(table.tenantId, table.slug),
    index('actors_tenant_kind_idx').on(table.tenantId, table.kind),
    foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: 'actors_tenant_fk' }).onDelete('restrict'),
    check('actors_slug_chk', sql`${table.slug} ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'`),
    check('actors_kind_chk', sql`${table.kind} IN ('human','agent','service')`),
    check('actors_service_no_display_name_chk', sql`${table.kind} <> 'service' OR ${table.displayName} IS NULL`),
    check('actors_metadata_object_chk', sql`jsonb_typeof(${table.declaredCapabilities}) = 'object'`),
  ],
);

// ---------------------------------------------------------------------------
// Region bindings
// ---------------------------------------------------------------------------

export type RegenerationContractMode =
  /** Direct write to the canonical source file/object. */
  | 'canonical_direct'
  /** Conservative symlink/alias materialization — verify target resolution, repo confinement, non-cycle, and target integrity at activation and at reconciliation. */
  | 'alias_symlink'
  /** Generation pipeline materializes derived artifacts from canonical (e.g. render step). */
  | 'derived_generate'
  /** No automatic materialization; operator runs an external pipeline. */
  | 'external_pipeline';

/**
 * RegionBinding is the frozen invariant-bearing core for mapping a host
 * editable region to its canonical source. Region approval refuses any
 * binding whose canonical source is ambiguous (no `regeneration_contract`
 * and no explicit canonical declaration).
 *
 * Stored shape (frozen invariant-bearing core):
 *   - `canonicalSource`: the canonical backend identifier (git ref + path,
 *     S3 bucket+key, Shopify product id, etc.). The CMS writes here only.
 *   - `derivedArtifacts[]`: served/derived paths that must NOT be written
 *     directly. For `alias_symlink` mode, the served path is a symlink that
 *     resolves to `canonicalSource`.
 *   - `regenerationContract.mode`: see RegenerationContractMode.
 *
 * `fieldCapabilities` is a host-specific extension/capability field
 * (provisional, 1.0-beta/RC). It captures per-field gating such as
 * `read_only | coordinator_gated | free_edit` (Stripe-coupled fields default
 * to read_only/coordinator_gated).
 */
export const regionBindings = storageSchema.table(
  'region_bindings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    /** Stable per-tenant region slug (e.g. `home.hero`, `products.catalog`). */
    slug: varchar('slug', { length: 128 }).notNull(),
    /** Adapter identifier owning this region (e.g. `@cms/adapters/cerafica`). */
    adapterId: varchar('adapter_id', { length: 128 }).notNull(),
    /** Frozen core: canonical source identifier (git ref+path, S3 bucket+key, Shopify id, etc.). */
    canonicalSource: jsonb('canonical_source').$type<{
      /** Adapter-specific opaque backend descriptor. */
      backend: string;
      /** Adapter-specific path/locator. */
      locator: string;
      /** Optional content-addressable hash captured at approval time. */
      contentHash?: string;
      [k: string]: unknown;
    }>().notNull(),
    /** Frozen core: served/derived paths that must NOT be written directly. */
    derivedArtifacts: jsonb('derived_artifacts').$type<readonly unknown[]>().notNull().default(sql`'[]'::jsonb`),
    /** Frozen core: how canonical writes are materialized/verified. */
    regenerationContract: jsonb('regeneration_contract').$type<{
      mode: RegenerationContractMode;
      /** Mode-specific parameters (e.g. alias_symlink target, repo root). */
      params?: Record<string, unknown>;
    }>().notNull(),
    /** Frozen core: declarative schema for fields exposed to the authoring UI. */
    schema: jsonb('schema').$type<Record<string, unknown>>().notNull(),
    /** Frozen core: locale policy (peer locales, fallback, required locales). */
    localePolicy: jsonb('locale_policy').$type<Record<string, unknown>>().notNull(),
    /** Frozen core: media field declarations (purpose, formats, dims, alt locales). */
    mediaFields: jsonb('media_fields').$type<readonly unknown[]>().notNull().default(sql`'[]'::jsonb`),
    /** Provisional (1.0-beta/RC): per-field capability gating. */
    fieldCapabilities: jsonb('field_capabilities').$type<Record<string, 'read_only' | 'coordinator_gated' | 'free_edit'>>().notNull().default(sql`'{}'::jsonb`),
    /** Approval state of this binding. Refused while not 'approved'. */
    approvalState: varchar('approval_state', { length: 32 }).notNull().default('pending'),
    /** Optimistic concurrency: bumped on every accepted update. */
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    approvedByActorId: uuid('approved_by_actor_id'),
  },
  (table) => [
    uniqueIndex('region_bindings_tenant_slug_uq').on(table.tenantId, table.slug),
    index('region_bindings_tenant_adapter_idx').on(table.tenantId, table.adapterId),
    index('region_bindings_approval_state_idx').on(table.tenantId, table.approvalState),
    foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: 'region_bindings_tenant_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.approvedByActorId], foreignColumns: [actors.id], name: 'region_bindings_approved_by_fk' }).onDelete('restrict'),
    check('region_bindings_slug_chk', sql`${table.slug} ~ '^[a-z0-9][a-z0-9._-]{0,127}$'`),
    check('region_bindings_version_chk', sql`${table.version} >= 1`),
    check('region_bindings_approval_state_chk', sql`${table.approvalState} IN ('pending','approved','retired','refused')`),
    check('region_bindings_canonical_source_object_chk', sql`jsonb_typeof(${table.canonicalSource}) = 'object'`),
    check('region_bindings_derived_artifacts_array_chk', sql`jsonb_typeof(${table.derivedArtifacts}) = 'array'`),
    check('region_bindings_regen_contract_object_chk', sql`jsonb_typeof(${table.regenerationContract}) = 'object'`),
    check('region_bindings_regen_mode_chk', sql`(${table.regenerationContract}->>'mode') IN ('canonical_direct','alias_symlink','derived_generate','external_pipeline')`),
    check('region_bindings_schema_object_chk', sql`jsonb_typeof(${table.schema}) = 'object'`),
    check('region_bindings_locale_policy_object_chk', sql`jsonb_typeof(${table.localePolicy}) = 'object'`),
    check('region_bindings_media_fields_array_chk', sql`jsonb_typeof(${table.mediaFields}) = 'array'`),
    check('region_bindings_field_capabilities_object_chk', sql`jsonb_typeof(${table.fieldCapabilities}) = 'object'`),
    check('region_bindings_approved_consistency_chk', sql`((${table.approvalState} = 'approved' AND ${table.approvedAt} IS NOT NULL) OR (${table.approvalState} IN ('pending','refused') AND ${table.approvedAt} IS NULL) OR ${table.approvalState} = 'retired')`),
  ],
);

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ProposalState =
  | 'draft'
  | 'proposed'
  | 'validated'
  | 'previewing'
  | 'approved'
  | 'applying'
  | 'canonical_written'
  | 'propagating'
  | 'live'
  | 'reconciled'
  | 'apply_failed'
  | 'deploy_pending'
  | 'deploy_failed'
  | 'reconcile_pending'
  | 'rolled_back'
  | 'refused';

/**
 * A Proposal represents a candidate governed change. It is created by an
 * actor (often an agent), validated by the policy engine, and approved by a
 * human before it may transition to `approved` and beyond.
 *
 * The proposal carries:
 *   - structured diff/patch payload (jsonb, hash-pinned),
 *   - the state-machine cursor,
 *   - the optimistic-concurrency `version`,
 *   - idempotency key (per write attempt, unique within a tenant).
 */
export const proposals = storageSchema.table(
  'proposals',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    regionBindingId: uuid('region_binding_id').notNull(),
    /** Stable per-tenant proposal slug (audit-visible). */
    slug: varchar('slug', { length: 128 }).notNull(),
    /** Originating actor (must be human or agent; service identities cannot originate proposals that require approval). */
    proposedByActorId: uuid('proposed_by_actor_id').notNull(),
    /** Optional human principal who delegated to the originating agent (present iff proposedByActorId is an agent). */
    delegatedHumanActorId: uuid('delegated_human_actor_id'),
    /** Short, human-readable title (en/es peer-locale key, resolved upstream). */
    title: text('title').notNull(),
    /** Structured patch payload (opaque to storage). Hash-pinned via `payload_hash`. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Content-addressable hash of the canonicalized payload (sha256 hex, 64 chars). */
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    /** Current state-machine cursor. */
    state: varchar('state', { length: 32 }).notNull().default('draft'),
    /** Optimistic concurrency cursor. Bumped on every accepted update. */
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    /** When the proposal was last validated by the policy engine. */
    validatedAt: timestamp('validated_at', { withTimezone: true, mode: 'date' }),
    /** When the proposal entered `approved`. */
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    /** When canonical_written was recorded (the irreversibility point for the SoT). */
    canonicalWrittenAt: timestamp('canonical_written_at', { withTimezone: true, mode: 'date' }),
    /** When live-propagated receipt arrived (publish beat end). */
    liveAt: timestamp('live_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex('proposals_tenant_slug_uq').on(table.tenantId, table.slug),
    index('proposals_tenant_state_idx').on(table.tenantId, table.state),
    index('proposals_region_state_idx').on(table.regionBindingId, table.state),
    index('proposals_proposed_by_idx').on(table.tenantId, table.proposedByActorId),
    index('proposals_delegated_human_idx').on(table.tenantId, table.delegatedHumanActorId),
    foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: 'proposals_tenant_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.regionBindingId], foreignColumns: [regionBindings.id], name: 'proposals_region_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.proposedByActorId], foreignColumns: [actors.id], name: 'proposals_proposed_by_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.delegatedHumanActorId], foreignColumns: [actors.id], name: 'proposals_delegated_human_fk' }).onDelete('restrict'),
    check('proposals_slug_chk', sql`${table.slug} ~ '^[a-z0-9][a-z0-9._-]{0,127}$'`),
    check('proposals_title_chk', sql`length(${table.title}) BETWEEN 1 AND 256`),
    check('proposals_payload_hash_chk', sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check('proposals_state_chk', sql`${table.state} IN ('draft','proposed','validated','previewing','approved','applying','canonical_written','propagating','live','reconciled','apply_failed','deploy_pending','deploy_failed','reconcile_pending','rolled_back','refused')`),
    check('proposals_version_chk', sql`${table.version} >= 1`),
    check('proposals_payload_object_chk', sql`jsonb_typeof(${table.payload}) = 'object'`),
    check('proposals_approved_consistency_chk', sql`(${table.state} IN ('approved','applying','canonical_written','propagating','live','reconciled')) = (${table.approvedAt} IS NOT NULL)`),
    check('proposals_canonical_written_consistency_chk', sql`(${table.state} IN ('canonical_written','propagating','live','reconciled','apply_failed','deploy_pending','deploy_failed','reconcile_pending','rolled_back')) = (${table.canonicalWrittenAt} IS NOT NULL)`),
  ],
);

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * An Approval is an attributable human authorization event for a proposal.
 * Every apply/publish/rollback transition requires an attributable human
 * approver. Self-approval is recorded via `self_approved=true` and is only
 * legal when policy permits it for the role/content-type/environment.
 *
 * Approval scope is a runtime policy-engine decision; this table records the
 * attested outcome of that decision and the human principal who authorized it.
 */
export const approvals = storageSchema.table(
  'approvals',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    proposalId: uuid('proposal_id').notNull(),
    /** Human principal who authorized this transition. Never a service/MCP identity. */
    approverActorId: uuid('approver_actor_id').notNull(),
    /** Optional human who delegated to the approver (present iff approver is an agent). */
    delegatedHumanActorId: uuid('delegated_human_actor_id'),
    /** True iff the approver is also the proposal's originator (self-approval). */
    selfApproved: boolean('self_approved').notNull().default(false),
    /** Role/claim under which the approval was granted (e.g. 'owner', 'editor'). */
    role: varchar('role', { length: 64 }).notNull(),
    /** Content type slug the approval applies to (region slug). */
    contentType: varchar('content_type', { length: 128 }).notNull(),
    /** Environment slug the approval applies to (e.g. 'production', 'staging'). */
    environment: varchar('environment', { length: 64 }).notNull(),
    /** Optional human-readable note (max 1 KiB). */
    note: text('note'),
    /** Approved transition target state. */
    targetState: varchar('target_state', { length: 32 }).notNull(),
    /** Rollback target captured at approval time (used by one-action rollback). */
    rollbackTargetProposalId: uuid('rollback_target_proposal_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
  },
  (table) => [
    index('approvals_tenant_proposal_idx').on(table.tenantId, table.proposalId),
    index('approvals_approver_idx').on(table.tenantId, table.approverActorId),
    index('approvals_target_state_idx').on(table.tenantId, table.targetState),
    foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: 'approvals_tenant_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.proposalId], foreignColumns: [proposals.id], name: 'approvals_proposal_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.approverActorId], foreignColumns: [actors.id], name: 'approvals_approver_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.delegatedHumanActorId], foreignColumns: [actors.id], name: 'approvals_delegated_human_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.rollbackTargetProposalId], foreignColumns: [proposals.id], name: 'approvals_rollback_target_fk' }).onDelete('restrict'),
    check('approvals_role_chk', sql`length(${table.role}) BETWEEN 1 AND 64`),
    check('approvals_content_type_chk', sql`${table.contentType} ~ '^[a-z0-9][a-z0-9._-]{0,127}$'`),
    check('approvals_environment_chk', sql`${table.environment} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`),
    check('approvals_target_state_chk', sql`${table.targetState} IN ('approved','rolled_back')`),
    check('approvals_note_len_chk', sql`${table.note} IS NULL OR length(${table.note}) <= 1024`),
    check('approvals_self_no_delegated_human_chk', sql`${table.selfApproved} = false OR ${table.delegatedHumanActorId} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

export type RevisionKind = 'content' | 'asset' | 'collection' | 'policy';

/**
 * A Revision is an immutable, content-addressable record of a change.
 * It carries:
 *   - before/after references (opaque to storage),
 *   - actor (originator) and approver identities,
 *   - the captured rollback target (the revision to roll back to),
 *   - a `self_approved` flag mirroring the originating approval.
 *
 * Revisions are append-only by convention; rows are never updated. The
 * `version` column records the monotonic ordering within a proposal lineage.
 */
export const revisions = storageSchema.table(
  'revisions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    proposalId: uuid('proposal_id').notNull(),
    /** Region binding this revision belongs to (denormalized for query speed). */
    regionBindingId: uuid('region_binding_id').notNull(),
    /** What kind of revision this is. */
    kind: varchar('kind', { length: 32 }).notNull().$type<RevisionKind>(),
    /** Monotonic version within the proposal lineage. */
    version: bigint('version', { mode: 'number' }).notNull(),
    /** Stable per-tenant revision slug. */
    slug: varchar('slug', { length: 128 }).notNull(),
    /** Reference to the prior revision (NULL for the genesis revision of a proposal). */
    parentRevisionId: uuid('parent_revision_id'),
    /** Opaque reference to the host-side "before" artifact (e.g. git sha, object key). */
    beforeRef: text('before_ref'),
    /** Opaque reference to the host-side "after" artifact. */
    afterRef: text('after_ref'),
    /** sha256 hex of the canonicalized before artifact (when content-addressable). */
    beforeHash: varchar('before_hash', { length: 64 }),
    /** sha256 hex of the canonicalized after artifact. */
    afterHash: varchar('after_hash', { length: 64 }),
    /** Originator actor. */
    actorId: uuid('actor_id').notNull(),
    /** Approver actor (NULL until approved). */
    approverActorId: uuid('approver_actor_id'),
    /** Self-approval flag carried from the originating approval. */
    selfApproved: boolean('self_approved').notNull().default(false),
    /** Original revision this revision may be rolled back TO (captured at approval). */
    rollbackTargetRevisionId: uuid('rollback_target_revision_id'),
    /** jsonb: structured diff (opaque to storage; canonicalized hash pins identity). */
    diff: jsonb('diff').$type<Record<string, unknown>>().notNull(),
    /** sha256 hex of the canonicalized diff (sha256 hex, 64 chars). */
    diffHash: varchar('diff_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex('revisions_tenant_slug_uq').on(table.tenantId, table.slug),
    uniqueIndex('revisions_proposal_version_uq').on(table.proposalId, table.version),
    index('revisions_tenant_region_idx').on(table.tenantId, table.regionBindingId),
    index('revisions_actor_idx').on(table.tenantId, table.actorId),
    index('revisions_rollback_target_idx').on(table.tenantId, table.rollbackTargetRevisionId),
    foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: 'revisions_tenant_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.proposalId], foreignColumns: [proposals.id], name: 'revisions_proposal_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.regionBindingId], foreignColumns: [regionBindings.id], name: 'revisions_region_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.parentRevisionId], foreignColumns: [table.id], name: 'revisions_parent_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.actorId], foreignColumns: [actors.id], name: 'revisions_actor_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.approverActorId], foreignColumns: [actors.id], name: 'revisions_approver_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.rollbackTargetRevisionId], foreignColumns: [table.id], name: 'revisions_rollback_target_fk' }).onDelete('restrict'),
    check('revisions_kind_chk', sql`${table.kind} IN ('content','asset','collection','policy')`),
    check('revisions_version_chk', sql`${table.version} >= 1`),
    check('revisions_slug_chk', sql`${table.slug} ~ '^[a-z0-9][a-z0-9._-]{0,127}$'`),
    check('revisions_diff_hash_chk', sql`${table.diffHash} ~ '^[0-9a-f]{64}$'`),
    check('revisions_before_hash_fmt_chk', sql`${table.beforeHash} IS NULL OR ${table.beforeHash} ~ '^[0-9a-f]{64}$'`),
    check('revisions_after_hash_fmt_chk', sql`${table.afterHash} IS NULL OR ${table.afterHash} ~ '^[0-9a-f]{64}$'`),
    check('revisions_approver_consistency_chk', sql`(${table.approverActorId} IS NULL) = (${table.selfApproved} = false AND ${table.rollbackTargetRevisionId} IS NULL) OR ${table.approverActorId} IS NOT NULL`),
    check('revisions_diff_object_chk', sql`jsonb_typeof(${table.diff}) = 'object'`),
  ],
);

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

export type PublicationStatus = 'canonical_written' | 'propagating' | 'live' | 'failed';

/**
 * A Publication captures a single publish transition with host-side result.
 * `canonical_written` is the irreversibility point for the source-of-truth;
 * `live` is the live-propagated-receipt that closes the publish beat.
 * Deploy race safety: in-flight deploys do not block the one-action
 * rollback step; rollback records a NEW publication targeting `canonical_written`.
 */
export const publications = storageSchema.table(
  'publications',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    proposalId: uuid('proposal_id').notNull(),
    /** Revision that this publication wrote to canonical. */
    canonicalRevisionId: uuid('canonical_revision_id').notNull(),
    /** Publication status. */
    status: varchar('status', { length: 32 }).notNull().default('canonical_written').$type<PublicationStatus>(),
    /** When canonical was written. The irreversibility point. */
    canonicalWrittenAt: timestamp('canonical_written_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
    /** When the live receipt arrived. NULL until propagated. */
    liveAt: timestamp('live_at', { withTimezone: true, mode: 'date' }),
    /** Failure detail if status='failed'. */
    failureReason: text('failure_reason'),
    /** Optimistic concurrency cursor. */
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
  },
  (table) => [
    index('publications_tenant_proposal_idx').on(table.tenantId, table.proposalId),
    index('publications_tenant_status_idx').on(table.tenantId, table.status),
    index('publications_canonical_written_idx').on(table.tenantId, table.canonicalWrittenAt),
    foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: 'publications_tenant_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.proposalId], foreignColumns: [proposals.id], name: 'publications_proposal_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.canonicalRevisionId], foreignColumns: [revisions.id], name: 'publications_canonical_revision_fk' }).onDelete('restrict'),
    check('publications_status_chk', sql`${table.status} IN ('canonical_written','propagating','live','failed')`),
    check('publications_version_chk', sql`${table.version} >= 1`),
    check('publications_live_consistency_chk', sql`(${table.status} = 'live') = (${table.liveAt} IS NOT NULL)`),
    check('publications_failure_consistency_chk', sql`(${table.status} = 'failed') = (${table.failureReason} IS NOT NULL)`),
    check('publications_failure_reason_len_chk', sql`${table.failureReason} IS NULL OR length(${table.failureReason}) <= 4096`),
  ],
);

// ---------------------------------------------------------------------------
// Deploy receipts
// ---------------------------------------------------------------------------

export type DeployStatus = 'pending' | 'succeeded' | 'failed' | 'rolled_back';

/**
 * DeployReceipt captures the host-side propagation result. The CMS uses
 * `DeployCapability` (a host-specific extension/capability field, provisional
 * at 1.0-beta/RC) to discover whether a deployment is webhook- or poll-based.
 * Receipts arrive asynchronously and are reconciled against publications via
 * `canonicalRevisionId`.
 */
export const deployReceipts = storageSchema.table(
  'deploy_receipts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    publicationId: uuid('publication_id').notNull(),
    /** Adapter that produced the receipt. */
    adapterId: varchar('adapter_id', { length: 128 }).notNull(),
    /** External deploy identifier (build id, sha, run id, etc.). */
    externalDeployId: varchar('external_deploy_id', { length: 256 }).notNull(),
    /** Status reported by the host. */
    status: varchar('status', { length: 32 }).notNull().default('pending').$type<DeployStatus>(),
    /** Adapter-specific opaque payload (jsonb). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Live URL once known. */
    liveUrl: text('live_url'),
    /** When the receipt was recorded by the CMS. */
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
    /** When the host reported the deploy completed. NULL until success/failure. */
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('deploy_receipts_tenant_external_uq').on(table.tenantId, table.adapterId, table.externalDeployId),
    index('deploy_receipts_publication_idx').on(table.publicationId),
    index('deploy_receipts_status_idx').on(table.tenantId, table.status),
    foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: 'deploy_receipts_tenant_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.publicationId], foreignColumns: [publications.id], name: 'deploy_receipts_publication_fk' }).onDelete('restrict'),
    check('deploy_receipts_status_chk', sql`${table.status} IN ('pending','succeeded','failed','rolled_back')`),
    check('deploy_receipts_adapter_id_chk', sql`${table.adapterId} ~ '^[a-z0-9@/][a-z0-9@/_.-]{0,127}$'`),
    check('deploy_receipts_external_id_chk', sql`length(${table.externalDeployId}) BETWEEN 1 AND 256`),
    check('deploy_receipts_completed_consistency_chk', sql`(${table.status} IN ('succeeded','failed','rolled_back')) = (${table.completedAt} IS NOT NULL)`),
    check('deploy_receipts_payload_object_chk', sql`jsonb_typeof(${table.payload}) = 'object'`),
  ],
);

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

/**
 * AuditEvent is an immutable, append-only record of a governance action.
 *
 *  - The full canonical envelope (signed via @cms/audit) is stored as jsonb
 *    and pinned by `event_hash` (sha256 hex of canonical bytes).
 *  - Rows are append-only: BEFORE UPDATE/DELETE triggers raise an exception
 *    (see migration `0001_governance.sql`).
 *  - Optional indexes support common query patterns (per-tenant timeline,
 *    per-proposal lineage, per-actor history, per-rollback-target lookup).
 *
 * The canonical envelope (`event` jsonb) carries `tenant`, `actor`,
 * `delegatedHuman`, `proposal`, `approval`, `hostResult`, `deployResult`,
 * and `rollbackLineage`. This table stores the envelope verbatim and
 * indexes the high-cardinality fields for queries.
 */
export const auditEvents = storageSchema.table(
  'audit_events',
  {
    /** sha256 hex of the canonical envelope bytes. Primary key (content-addressable). */
    eventHash: varchar('event_hash', { length: 64 }).primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    /** Originating actor id (denormalized from envelope). */
    actorId: uuid('actor_id').notNull(),
    /** Optional delegated human id (NULL when actor is human or self-approved). */
    delegatedHumanActorId: uuid('delegated_human_actor_id'),
    /** Proposal id (denormalized; references a row in proposals). */
    proposalId: uuid('proposal_id'),
    /** Approval id (denormalized; references a row in approvals). */
    approvalId: uuid('approval_id'),
    /** When the action occurred (from envelope). */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Schema version of the envelope (always 1 today). */
    schemaVersion: integer('schema_version').notNull().default(1),
    /** Whether the action was self-approved (denormalized from envelope). */
    selfApproved: boolean('self_approved').notNull().default(false),
    /** Canonical envelope payload (jsonb). Hash-pinned via `event_hash`. */
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    /** When the CMS persisted this event. Never equals occurredAt exactly (clock skew). */
    persistedAt: timestamp('persisted_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
  },
  (table) => [
    index('audit_events_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('audit_events_tenant_actor_idx').on(table.tenantId, table.actorId, table.occurredAt),
    index('audit_events_tenant_proposal_idx').on(table.tenantId, table.proposalId),
    index('audit_events_tenant_approval_idx').on(table.tenantId, table.approvalId),
    index('audit_events_persisted_idx').on(table.persistedAt),
    foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: 'audit_events_tenant_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.actorId], foreignColumns: [actors.id], name: 'audit_events_actor_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.delegatedHumanActorId], foreignColumns: [actors.id], name: 'audit_events_delegated_human_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.proposalId], foreignColumns: [proposals.id], name: 'audit_events_proposal_fk' }).onDelete('restrict'),
    foreignKey({ columns: [table.approvalId], foreignColumns: [approvals.id], name: 'audit_events_approval_fk' }).onDelete('restrict'),
    check('audit_events_hash_chk', sql`${table.eventHash} ~ '^[0-9a-f]{64}$'`),
    check('audit_events_schema_version_chk', sql`${table.schemaVersion} BETWEEN 1 AND 65535`),
    check('audit_events_event_object_chk', sql`jsonb_typeof(${table.event}) = 'object'`),
    check('audit_events_self_no_delegated_human_chk', sql`${table.selfApproved} = false OR ${table.delegatedHumanActorId} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Idempotency records
// ---------------------------------------------------------------------------

export type IdempotencyOutcome = 'in_progress' | 'succeeded' | 'failed';

/**
 * IdempotencyRecord pins a (tenant, idempotency_key) tuple to the result of a
 * write attempt. Replays return the recorded response and never re-execute
 * the side effect. Rows are immutable; a unique constraint on
 * (tenant_id, idempotency_key) makes the lookup atomic.
 *
 * The `request_fingerprint` (sha256 hex of the canonicalized request body)
 * detects body mismatches under the same idempotency key — replays with a
 * different body fail loudly rather than silently re-applying.
 */
export const idempotencyRecords = storageSchema.table(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    /** Caller-supplied idempotency key (UUID/slug). */
    idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull(),
    /** sha256 hex of the canonicalized request body (sha256 hex, 64 chars). */
    requestFingerprint: varchar('request_fingerprint', { length: 64 }).notNull(),
    /** API endpoint identifier the idempotency key is scoped to. */
    endpoint: varchar('endpoint', { length: 128 }).notNull(),
    /** Status of the recorded attempt. */
    outcome: varchar('outcome', { length: 32 }).notNull().default('in_progress').$type<IdempotencyOutcome>(),
    /** Recorded response (jsonb, opaque to storage). NULL while in_progress. */
    response: jsonb('response').$type<Record<string, unknown> | null>(),
    /** HTTP status code captured with the response. NULL while in_progress. */
    responseStatus: integer('response_status'),
    /** Lock holder when outcome='in_progress'. NULL once resolved. */
    lockedBy: varchar('locked_by', { length: 128 }),
    /** Lock expiry (advisory lock refresh window). */
    lockExpiresAt: timestamp('lock_expires_at', { withTimezone: true, mode: 'date' }),
    /** First seen timestamp. Never updated. */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().default(sql`now()`),
    /** Finalized timestamp. NULL while in_progress. */
    finalizedAt: timestamp('finalized_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('idempotency_records_tenant_key_uq').on(table.tenantId, table.idempotencyKey),
    index('idempotency_records_outcome_idx').on(table.tenantId, table.outcome),
    index('idempotency_records_lock_expiry_idx').on(table.lockExpiresAt),
    foreignKey({ columns: [table.tenantId], foreignColumns: [tenants.id], name: 'idempotency_records_tenant_fk' }).onDelete('restrict'),
    check('idempotency_records_key_chk', sql`length(${table.idempotencyKey}) BETWEEN 1 AND 256`),
    check('idempotency_records_fingerprint_chk', sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('idempotency_records_outcome_chk', sql`${table.outcome} IN ('in_progress','succeeded','failed')`),
    check('idempotency_records_status_chk', sql`${table.responseStatus} IS NULL OR (${table.responseStatus} BETWEEN 100 AND 599)`),
    check('idempotency_records_finalized_consistency_chk', sql`(${table.outcome} IN ('succeeded','failed')) = (${table.finalizedAt} IS NOT NULL)`),
    check('idempotency_records_response_consistency_chk', sql`(${table.outcome} = 'succeeded') = (${table.response} IS NOT NULL)`),
    check('idempotency_records_in_progress_lock_chk', sql`(${table.outcome} = 'in_progress') = (${table.lockExpiresAt} IS NOT NULL)`),
    check('idempotency_records_response_object_or_null_chk', sql`${table.response} IS NULL OR jsonb_typeof(${table.response}) = 'object'`),
  ],
);