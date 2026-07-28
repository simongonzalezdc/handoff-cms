-- =============================================================================
-- 0001_governance.sql
--
-- Initial governance-data schema for the @cms/storage package.
--
-- Scope:
--   This migration creates the GOVERNANCE persistence layer only.
--   It models: tenants, actors, region bindings, proposals, approvals,
--   revisions, publications, deploy receipts, audit events, and
--   idempotency records. Canonical CMS content/assets are intentionally
--   NOT modelled here — the host repository, database, object store, or
--   backing CMS remains canonical; this package persists only governed
--   deltas, references, diffs, and host receipts.
--
-- Idempotency / migration notes:
--   - This forward-only migration is applied by the self-host Compose
--     `migrations` service. Applied filenames are tracked in the
--     `cms_schema_migrations` table; the SQL and marker commit in one
--     transaction. Operators add a new ordered file for every schema change
--     and never rename or modify an applied migration.
--   - Rollback semantics are OUT OF SCOPE. Governance data is append-only
--     by design; dropping tables destroys audit lineage. Recovery is via
--     snapshot + restore or upstream replay, not via DOWN migration.
--   - `gen_random_uuid()` requires the `pgcrypto` extension on PostgreSQL
--     < 13; PG >= 13 includes it natively. The CREATE EXTENSION call is
--     wrapped in DO/EXCEPTION to remain portable across PG 13+ where
--     pgcrypto is no longer required for `gen_random_uuid()`.
--
-- Conventions:
--   - All timestamps are `timestamp with time zone` (timestamptz).
--   - JSON-shaped governance metadata is `jsonb` by design (open schema
--     for capabilities, regeneration contracts, audit envelopes, etc.).
--     Closed-shape relational fields live in typed columns.
--   - Every tenant-scoped row carries `tenant_id` and is indexed on it.
--     Foreign keys reference `tenants.id` with ON DELETE RESTRICT.
--   - Optimistic concurrency is enforced via a monotonic `version`
--     column (BIGINT NOT NULL DEFAULT 1); updates assert the expected
--     version and bump it under a single UPDATE.
--   - Append-only: `audit_events` refuses UPDATE/DELETE/TRUNCATE via BEFORE
--     triggers that raise SQLSTATE 'P0001' and emit the marker text
--     `cms_storage.audit_events is append-only`. Callers receive
--     `AppendOnlyViolationError` after the storage classifier matches both
--     the SQLSTATE and the marker. `idempotency_records` is NOT append-only
--     at the SQL layer; the storage transitions rows from in_progress to a
--     terminal outcome under the same transaction, and the schema-layer
--     CHECK constraints guard the in_progress -> terminal transition.
--   - Tenant guard: every tenant-scoped mutator in the storage layer issues
--     a SELECT on `tenants.disabled_at` before touching rows; disabled
--     tenants surface `TenantDisabledError` (code='tenant_disabled'). This
--     guard is enforced from TypeScript so the policy lives in one place;
--     the SQL layer does not (yet) embed it so an admin can re-enable a
--     tenant with a single UPDATE without rebuilding the migration.
--   - Frozen-core guard: `region_bindings` rows that reach `approved` or
--     `retired` refuse further frozen-core upserts in the storage layer.
--     Redirecting a canonical source requires retiring the existing binding
--     explicitly and creating a new row. The SQL layer does not enforce
--     this — the constraint is policy-driven and lives in TypeScript.
-- Schema namespace: `cms_storage` is reserved for this package. Downstream
-- packages may coexist in the same database under their own namespaces.
-- =============================================================================

SET client_min_messages = WARNING;

-- -----------------------------------------------------------------------------
-- Required extensions
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  -- pgcrypto hosts gen_random_uuid() on PG < 13; PG >= 13 ships it natively.
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  EXCEPTION WHEN OTHERS THEN
    -- PG 13+ in restricted environments may reject CREATE EXTENSION.
    -- gen_random_uuid() is still available without pgcrypto.
    NULL;
  END;
END
$$;

-- -----------------------------------------------------------------------------
-- Schema namespace
-- -----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS cms_storage;
SET search_path TO cms_storage, public;

-- -----------------------------------------------------------------------------
-- Tenants
-- -----------------------------------------------------------------------------

CREATE TABLE cms_storage.tenants (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          varchar(64) NOT NULL,
  display_name  text        NOT NULL,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,
  CONSTRAINT tenants_slug_chk
    CHECK (slug ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT tenants_display_name_chk
    CHECK (length(display_name) BETWEEN 1 AND 256),
  CONSTRAINT tenants_metadata_object_chk
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX tenants_slug_uq
  ON cms_storage.tenants (slug);

-- -----------------------------------------------------------------------------
-- Actors
-- -----------------------------------------------------------------------------

CREATE TABLE cms_storage.actors (
  id                     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid         NOT NULL,
  kind                   varchar(16)  NOT NULL,
  slug                   varchar(128) NOT NULL,
  display_name           text,
  issuer                 text,
  public_key_kid         varchar(128),
  declared_capabilities  jsonb        NOT NULL DEFAULT '{}'::jsonb,
  verified               boolean      NOT NULL DEFAULT false,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  disabled_at            timestamptz,
  CONSTRAINT actors_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES cms_storage.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT actors_slug_chk
    CHECK (slug ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  CONSTRAINT actors_kind_chk
    CHECK (kind IN ('human','agent','service')),
  CONSTRAINT actors_service_no_display_name_chk
    CHECK (kind <> 'service' OR display_name IS NULL),
  CONSTRAINT actors_metadata_object_chk
    CHECK (jsonb_typeof(declared_capabilities) = 'object')
);

CREATE UNIQUE INDEX actors_tenant_slug_uq
  ON cms_storage.actors (tenant_id, slug);

CREATE INDEX actors_tenant_kind_idx
  ON cms_storage.actors (tenant_id, kind);

-- -----------------------------------------------------------------------------
-- Region bindings
-- -----------------------------------------------------------------------------

CREATE TABLE cms_storage.region_bindings (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid         NOT NULL,
  slug                     varchar(128) NOT NULL,
  adapter_id               varchar(128) NOT NULL,
  canonical_source         jsonb        NOT NULL,
  derived_artifacts        jsonb        NOT NULL DEFAULT '[]'::jsonb,
  regeneration_contract    jsonb        NOT NULL,
  schema                   jsonb        NOT NULL,
  locale_policy            jsonb        NOT NULL,
  media_fields             jsonb        NOT NULL DEFAULT '[]'::jsonb,
  field_capabilities       jsonb        NOT NULL DEFAULT '{}'::jsonb,
  approval_state           varchar(32)  NOT NULL DEFAULT 'pending',
  version                  bigint       NOT NULL DEFAULT 1,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),
  approved_at              timestamptz,
  approved_by_actor_id     uuid,
  CONSTRAINT region_bindings_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES cms_storage.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT region_bindings_approved_by_fk
    FOREIGN KEY (approved_by_actor_id) REFERENCES cms_storage.actors (id) ON DELETE RESTRICT,
  CONSTRAINT region_bindings_slug_chk
    CHECK (slug ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  CONSTRAINT region_bindings_version_chk
    CHECK (version >= 1),
  CONSTRAINT region_bindings_approval_state_chk
    CHECK (approval_state IN ('pending','approved','retired','refused')),
  CONSTRAINT region_bindings_canonical_source_object_chk
    CHECK (jsonb_typeof(canonical_source) = 'object'),
  CONSTRAINT region_bindings_derived_artifacts_array_chk
    CHECK (jsonb_typeof(derived_artifacts) = 'array'),
  CONSTRAINT region_bindings_regen_contract_object_chk
    CHECK (jsonb_typeof(regeneration_contract) = 'object'),
  CONSTRAINT region_bindings_regen_mode_chk
    CHECK ((regeneration_contract->>'mode') IN ('canonical_direct','alias_symlink','derived_generate','external_pipeline')),
  CONSTRAINT region_bindings_schema_object_chk
    CHECK (jsonb_typeof(schema) = 'object'),
  CONSTRAINT region_bindings_locale_policy_object_chk
    CHECK (jsonb_typeof(locale_policy) = 'object'),
  CONSTRAINT region_bindings_media_fields_array_chk
    CHECK (jsonb_typeof(media_fields) = 'array'),
  CONSTRAINT region_bindings_field_capabilities_object_chk
    CHECK (jsonb_typeof(field_capabilities) = 'object'),
  CONSTRAINT region_bindings_approved_consistency_chk
    CHECK (
      (approval_state = 'approved' AND approved_at IS NOT NULL)
      OR (approval_state IN ('pending','refused') AND approved_at IS NULL)
      OR approval_state = 'retired'
    )
);

CREATE UNIQUE INDEX region_bindings_tenant_slug_uq
  ON cms_storage.region_bindings (tenant_id, slug);

CREATE INDEX region_bindings_tenant_adapter_idx
  ON cms_storage.region_bindings (tenant_id, adapter_id);

CREATE INDEX region_bindings_approval_state_idx
  ON cms_storage.region_bindings (tenant_id, approval_state);

-- -----------------------------------------------------------------------------
-- Proposals
-- -----------------------------------------------------------------------------

CREATE TABLE cms_storage.proposals (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid         NOT NULL,
  region_binding_id        uuid         NOT NULL,
  slug                     varchar(128) NOT NULL,
  proposed_by_actor_id     uuid         NOT NULL,
  delegated_human_actor_id uuid,
  title                    text         NOT NULL,
  payload                  jsonb        NOT NULL,
  payload_hash             varchar(64)  NOT NULL,
  state                    varchar(32)  NOT NULL DEFAULT 'draft',
  version                  bigint       NOT NULL DEFAULT 1,
  validated_at             timestamptz,
  approved_at              timestamptz,
  canonical_written_at     timestamptz,
  live_at                  timestamptz,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT proposals_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES cms_storage.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT proposals_region_fk
    FOREIGN KEY (region_binding_id) REFERENCES cms_storage.region_bindings (id) ON DELETE RESTRICT,
  CONSTRAINT proposals_proposed_by_fk
    FOREIGN KEY (proposed_by_actor_id) REFERENCES cms_storage.actors (id) ON DELETE RESTRICT,
  CONSTRAINT proposals_delegated_human_fk
    FOREIGN KEY (delegated_human_actor_id) REFERENCES cms_storage.actors (id) ON DELETE RESTRICT,
  CONSTRAINT proposals_slug_chk
    CHECK (slug ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  CONSTRAINT proposals_title_chk
    CHECK (length(title) BETWEEN 1 AND 256),
  CONSTRAINT proposals_payload_hash_chk
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT proposals_state_chk
    CHECK (state IN ('draft','proposed','validated','previewing','approved','applying','canonical_written','propagating','live','reconciled','apply_failed','deploy_pending','deploy_failed','reconcile_pending','rolled_back','refused')),
  CONSTRAINT proposals_version_chk
    CHECK (version >= 1),
  CONSTRAINT proposals_payload_object_chk
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT proposals_approved_consistency_chk
    CHECK ((state IN ('approved','applying','canonical_written','propagating','live','reconciled')) = (approved_at IS NOT NULL)),
  CONSTRAINT proposals_canonical_written_consistency_chk
    CHECK ((state IN ('canonical_written','propagating','live','reconciled','apply_failed','deploy_pending','deploy_failed','reconcile_pending','rolled_back')) = (canonical_written_at IS NOT NULL))
);

CREATE UNIQUE INDEX proposals_tenant_slug_uq
  ON cms_storage.proposals (tenant_id, slug);

CREATE INDEX proposals_tenant_state_idx
  ON cms_storage.proposals (tenant_id, state);

CREATE INDEX proposals_region_state_idx
  ON cms_storage.proposals (region_binding_id, state);

CREATE INDEX proposals_proposed_by_idx
  ON cms_storage.proposals (tenant_id, proposed_by_actor_id);

CREATE INDEX proposals_delegated_human_idx
  ON cms_storage.proposals (tenant_id, delegated_human_actor_id);

-- -----------------------------------------------------------------------------
-- Approvals
-- -----------------------------------------------------------------------------

CREATE TABLE cms_storage.approvals (
  id                          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid         NOT NULL,
  proposal_id                 uuid         NOT NULL,
  approver_actor_id           uuid         NOT NULL,
  delegated_human_actor_id    uuid,
  self_approved               boolean      NOT NULL DEFAULT false,
  role                        varchar(64)  NOT NULL,
  content_type                varchar(128) NOT NULL,
  environment                 varchar(64)  NOT NULL,
  note                        text,
  target_state                varchar(32)  NOT NULL,
  rollback_target_proposal_id uuid,
  created_at                  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT approvals_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES cms_storage.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT approvals_proposal_fk
    FOREIGN KEY (proposal_id) REFERENCES cms_storage.proposals (id) ON DELETE RESTRICT,
  CONSTRAINT approvals_approver_fk
    FOREIGN KEY (approver_actor_id) REFERENCES cms_storage.actors (id) ON DELETE RESTRICT,
  CONSTRAINT approvals_delegated_human_fk
    FOREIGN KEY (delegated_human_actor_id) REFERENCES cms_storage.actors (id) ON DELETE RESTRICT,
  CONSTRAINT approvals_rollback_target_fk
    FOREIGN KEY (rollback_target_proposal_id) REFERENCES cms_storage.proposals (id) ON DELETE RESTRICT,
  CONSTRAINT approvals_role_chk
    CHECK (length(role) BETWEEN 1 AND 64),
  CONSTRAINT approvals_content_type_chk
    CHECK (content_type ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  CONSTRAINT approvals_environment_chk
    CHECK (environment ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT approvals_target_state_chk
    CHECK (target_state IN ('approved','rolled_back')),
  CONSTRAINT approvals_note_len_chk
    CHECK (note IS NULL OR length(note) <= 1024),
  CONSTRAINT approvals_self_no_delegated_human_chk
    CHECK (self_approved = false OR delegated_human_actor_id IS NULL)
);

CREATE INDEX approvals_tenant_proposal_idx
  ON cms_storage.approvals (tenant_id, proposal_id);

CREATE INDEX approvals_approver_idx
  ON cms_storage.approvals (tenant_id, approver_actor_id);

CREATE INDEX approvals_target_state_idx
  ON cms_storage.approvals (tenant_id, target_state);

-- -----------------------------------------------------------------------------
-- Revisions
-- -----------------------------------------------------------------------------

CREATE TABLE cms_storage.revisions (
  id                          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid         NOT NULL,
  proposal_id                 uuid         NOT NULL,
  region_binding_id           uuid         NOT NULL,
  kind                        varchar(32)  NOT NULL,
  version                     bigint       NOT NULL,
  slug                        varchar(128) NOT NULL,
  parent_revision_id          uuid,
  before_ref                  text,
  after_ref                   text,
  before_hash                 varchar(64),
  after_hash                  varchar(64),
  actor_id                    uuid         NOT NULL,
  approver_actor_id           uuid,
  self_approved               boolean      NOT NULL DEFAULT false,
  rollback_target_revision_id uuid,
  diff                        jsonb        NOT NULL,
  diff_hash                   varchar(64)  NOT NULL,
  created_at                  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT revisions_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES cms_storage.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT revisions_proposal_fk
    FOREIGN KEY (proposal_id) REFERENCES cms_storage.proposals (id) ON DELETE RESTRICT,
  CONSTRAINT revisions_region_fk
    FOREIGN KEY (region_binding_id) REFERENCES cms_storage.region_bindings (id) ON DELETE RESTRICT,
  CONSTRAINT revisions_parent_fk
    FOREIGN KEY (parent_revision_id) REFERENCES cms_storage.revisions (id) ON DELETE RESTRICT,
  CONSTRAINT revisions_actor_fk
    FOREIGN KEY (actor_id) REFERENCES cms_storage.actors (id) ON DELETE RESTRICT,
  CONSTRAINT revisions_approver_fk
    FOREIGN KEY (approver_actor_id) REFERENCES cms_storage.actors (id) ON DELETE RESTRICT,
  CONSTRAINT revisions_rollback_target_fk
    FOREIGN KEY (rollback_target_revision_id) REFERENCES cms_storage.revisions (id) ON DELETE RESTRICT,
  CONSTRAINT revisions_kind_chk
    CHECK (kind IN ('content','asset','collection','policy')),
  CONSTRAINT revisions_version_chk
    CHECK (version >= 1),
  CONSTRAINT revisions_slug_chk
    CHECK (slug ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  CONSTRAINT revisions_diff_hash_chk
    CHECK (diff_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT revisions_before_hash_fmt_chk
    CHECK (before_hash IS NULL OR before_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT revisions_after_hash_fmt_chk
    CHECK (after_hash IS NULL OR after_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT revisions_approver_consistency_chk
    CHECK ((approver_actor_id IS NULL) = ((self_approved = false) AND (rollback_target_revision_id IS NULL)) OR approver_actor_id IS NOT NULL),
  CONSTRAINT revisions_diff_object_chk
    CHECK (jsonb_typeof(diff) = 'object')
);

CREATE UNIQUE INDEX revisions_tenant_slug_uq
  ON cms_storage.revisions (tenant_id, slug);

CREATE UNIQUE INDEX revisions_proposal_version_uq
  ON cms_storage.revisions (proposal_id, version);

CREATE INDEX revisions_tenant_region_idx
  ON cms_storage.revisions (tenant_id, region_binding_id);

CREATE INDEX revisions_actor_idx
  ON cms_storage.revisions (tenant_id, actor_id);

CREATE INDEX revisions_rollback_target_idx
  ON cms_storage.revisions (tenant_id, rollback_target_revision_id);

-- -----------------------------------------------------------------------------
-- Publications
-- -----------------------------------------------------------------------------

CREATE TABLE cms_storage.publications (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL,
  proposal_id            uuid        NOT NULL,
  canonical_revision_id  uuid        NOT NULL,
  status                 varchar(32) NOT NULL DEFAULT 'canonical_written',
  canonical_written_at   timestamptz NOT NULL DEFAULT now(),
  live_at                timestamptz,
  failure_reason         text,
  version                bigint      NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publications_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES cms_storage.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT publications_proposal_fk
    FOREIGN KEY (proposal_id) REFERENCES cms_storage.proposals (id) ON DELETE RESTRICT,
  CONSTRAINT publications_canonical_revision_fk
    FOREIGN KEY (canonical_revision_id) REFERENCES cms_storage.revisions (id) ON DELETE RESTRICT,
  CONSTRAINT publications_status_chk
    CHECK (status IN ('canonical_written','propagating','live','failed')),
  CONSTRAINT publications_version_chk
    CHECK (version >= 1),
  CONSTRAINT publications_live_consistency_chk
    CHECK ((status = 'live') = (live_at IS NOT NULL)),
  CONSTRAINT publications_failure_consistency_chk
    CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT publications_failure_reason_len_chk
    CHECK (failure_reason IS NULL OR length(failure_reason) <= 4096)
);

CREATE INDEX publications_tenant_proposal_idx
  ON cms_storage.publications (tenant_id, proposal_id);

CREATE INDEX publications_tenant_status_idx
  ON cms_storage.publications (tenant_id, status);

CREATE INDEX publications_canonical_written_idx
  ON cms_storage.publications (tenant_id, canonical_written_at);

-- -----------------------------------------------------------------------------
-- Deploy receipts
-- -----------------------------------------------------------------------------

CREATE TABLE cms_storage.deploy_receipts (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid         NOT NULL,
  publication_id      uuid         NOT NULL,
  adapter_id          varchar(128) NOT NULL,
  external_deploy_id  varchar(256) NOT NULL,
  status              varchar(32)  NOT NULL DEFAULT 'pending',
  payload             jsonb        NOT NULL DEFAULT '{}'::jsonb,
  live_url            text,
  received_at         timestamptz  NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  CONSTRAINT deploy_receipts_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES cms_storage.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT deploy_receipts_publication_fk
    FOREIGN KEY (publication_id) REFERENCES cms_storage.publications (id) ON DELETE RESTRICT,
  CONSTRAINT deploy_receipts_status_chk
    CHECK (status IN ('pending','succeeded','failed','rolled_back')),
  CONSTRAINT deploy_receipts_adapter_id_chk
    CHECK (adapter_id ~ '^[a-z0-9@/][a-z0-9@/_.-]{0,127}$'),
  CONSTRAINT deploy_receipts_external_id_chk
    CHECK (length(external_deploy_id) BETWEEN 1 AND 256),
  CONSTRAINT deploy_receipts_completed_consistency_chk
    CHECK ((status IN ('succeeded','failed','rolled_back')) = (completed_at IS NOT NULL)),
  CONSTRAINT deploy_receipts_payload_object_chk
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX deploy_receipts_tenant_external_uq
  ON cms_storage.deploy_receipts (tenant_id, adapter_id, external_deploy_id);

CREATE INDEX deploy_receipts_publication_idx
  ON cms_storage.deploy_receipts (publication_id);

CREATE INDEX deploy_receipts_status_idx
  ON cms_storage.deploy_receipts (tenant_id, status);

-- -----------------------------------------------------------------------------
-- Audit events (append-only)
-- -----------------------------------------------------------------------------

CREATE TABLE cms_storage.audit_events (
  event_hash               varchar(64) PRIMARY KEY,
  tenant_id                uuid        NOT NULL,
  actor_id                 uuid        NOT NULL,
  delegated_human_actor_id uuid,
  proposal_id              uuid,
  approval_id              uuid,
  occurred_at              timestamptz NOT NULL,
  schema_version           integer     NOT NULL DEFAULT 1,
  self_approved            boolean     NOT NULL DEFAULT false,
  event                    jsonb       NOT NULL,
  persisted_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES cms_storage.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_actor_fk
    FOREIGN KEY (actor_id) REFERENCES cms_storage.actors (id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_delegated_human_fk
    FOREIGN KEY (delegated_human_actor_id) REFERENCES cms_storage.actors (id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_proposal_fk
    FOREIGN KEY (proposal_id) REFERENCES cms_storage.proposals (id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_approval_fk
    FOREIGN KEY (approval_id) REFERENCES cms_storage.approvals (id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_hash_chk
    CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_events_schema_version_chk
    CHECK (schema_version BETWEEN 1 AND 65535),
  CONSTRAINT audit_events_event_object_chk
    CHECK (jsonb_typeof(event) = 'object'),
  CONSTRAINT audit_events_self_no_delegated_human_chk
    CHECK (self_approved = false OR delegated_human_actor_id IS NULL)
);

CREATE INDEX audit_events_tenant_occurred_idx
  ON cms_storage.audit_events (tenant_id, occurred_at);

CREATE INDEX audit_events_tenant_actor_idx
  ON cms_storage.audit_events (tenant_id, actor_id, occurred_at);

CREATE INDEX audit_events_tenant_proposal_idx
  ON cms_storage.audit_events (tenant_id, proposal_id);

CREATE INDEX audit_events_tenant_approval_idx
  ON cms_storage.audit_events (tenant_id, approval_id);

CREATE INDEX audit_events_persisted_idx
  ON cms_storage.audit_events (persisted_at);

-- -----------------------------------------------------------------------------
-- Idempotency records (append-only)
-- -----------------------------------------------------------------------------

CREATE TABLE cms_storage.idempotency_records (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid         NOT NULL,
  idempotency_key     varchar(256) NOT NULL,
  request_fingerprint varchar(64)  NOT NULL,
  endpoint            varchar(128) NOT NULL,
  outcome             varchar(32)  NOT NULL DEFAULT 'in_progress',
  response            jsonb,
  response_status     integer,
  locked_by           varchar(128),
  lock_expires_at     timestamptz,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  finalized_at        timestamptz,
  CONSTRAINT idempotency_records_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES cms_storage.tenants (id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_records_key_chk
    CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  CONSTRAINT idempotency_records_fingerprint_chk
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_records_outcome_chk
    CHECK (outcome IN ('in_progress','succeeded','failed')),
  CONSTRAINT idempotency_records_status_chk
    CHECK (response_status IS NULL OR (response_status BETWEEN 100 AND 599)),
  CONSTRAINT idempotency_records_finalized_consistency_chk
    CHECK ((outcome IN ('succeeded','failed')) = (finalized_at IS NOT NULL)),
  CONSTRAINT idempotency_records_response_consistency_chk
    CHECK ((outcome IN ('succeeded','failed')) = (response IS NOT NULL)),
  CONSTRAINT idempotency_records_in_progress_lock_chk
    CHECK ((outcome = 'in_progress') = (lock_expires_at IS NOT NULL)),
  CONSTRAINT idempotency_records_response_object_or_null_chk
    CHECK (response IS NULL OR jsonb_typeof(response) = 'object')
);

CREATE UNIQUE INDEX idempotency_records_tenant_key_uq
  ON cms_storage.idempotency_records (tenant_id, idempotency_key);

CREATE INDEX idempotency_records_outcome_idx
  ON cms_storage.idempotency_records (tenant_id, outcome);

CREATE INDEX idempotency_records_lock_expiry_idx
  ON cms_storage.idempotency_records (lock_expires_at);

-- -----------------------------------------------------------------------------
-- Append-only enforcement
-- -----------------------------------------------------------------------------
--
-- audit_events is strictly append-only. BEFORE UPDATE/DELETE/TRUNCATE
-- triggers raise SQLSTATE 'P0001' so any mutation aborts the transaction.
-- The storage layer maps SQLSTATE 'P0001' to `AppendOnlyViolationError`.
-- idempotency_records is NOT append-only; see the note below.

CREATE OR REPLACE FUNCTION cms_storage.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'cms_storage.% is append-only; UPDATE/DELETE is not permitted (op=%, SQLSTATE=P0001)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON cms_storage.audit_events
  FOR EACH ROW EXECUTE FUNCTION cms_storage.reject_mutation();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON cms_storage.audit_events
  FOR EACH ROW EXECUTE FUNCTION cms_storage.reject_mutation();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON cms_storage.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION cms_storage.reject_mutation();

-- Note: idempotency_records is NOT append-only at the SQL layer. The
-- storage MUST transition rows from in_progress to a terminal outcome
-- (succeeded/failed) under the same transaction that produced the response;
-- UPDATE/DELETE blocking here would break idempotent finalize. The
-- schema-layer CHECK constraints already enforce the in_progress -> terminal
-- transition semantics and prevent any UPDATE that is not a legal state
-- change. Only audit_events (above) is strictly append-only.

-- -----------------------------------------------------------------------------
-- Search-path restoration
-- -----------------------------------------------------------------------------

RESET search_path;