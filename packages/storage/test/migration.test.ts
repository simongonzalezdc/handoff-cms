import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(new URL('../migrations/0001_governance.sql', import.meta.url));
const migration = readFileSync(migrationPath, 'utf8');

type TableDefinitions = ReadonlyMap<string, string>;
type IndexDefinitions = ReadonlyMap<string, { unique: boolean; table: string; columns: readonly string[] }>;

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*(?:\n|$)/g, '\n');
}

function normalizeSql(sql: string): string {
  return stripComments(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseTables(sql: string): TableDefinitions {
  const tables = new Map<string, string>();
  const pattern = /create\s+table\s+cms_storage\.([a-z_]+)\s*\(([\s\S]*?)\n\);/gi;
  for (const match of sql.matchAll(pattern)) {
    const [, name, body] = match;
    if (!name || body === undefined) throw new Error('malformed CREATE TABLE statement');
    if (tables.has(name)) throw new Error(`duplicate CREATE TABLE for cms_storage.${name}`);
    tables.set(name, normalizeSql(body));
  }
  return tables;
}

function parseIndexes(sql: string): IndexDefinitions {
  const indexes = new Map<string, { unique: boolean; table: string; columns: readonly string[] }>();
  const pattern = /create\s+(unique\s+)?index\s+([a-z_]+)\s+on\s+cms_storage\.([a-z_]+)\s*\(([^)]+)\)\s*;/gi;
  for (const match of stripComments(sql).matchAll(pattern)) {
    const [, unique, name, table, columnList] = match;
    if (!name || !table || !columnList) throw new Error('malformed CREATE INDEX statement');
    if (indexes.has(name)) throw new Error(`duplicate CREATE INDEX ${name}`);
    indexes.set(name, {
      unique: unique !== undefined,
      table,
      columns: columnList.split(',').map((column) => column.trim().toLowerCase()),
    });
  }
  return indexes;
}

function expectClause(body: string, clause: RegExp, message: string): void {
  expect(body, message).toMatch(clause);
}

function expectIndex(
  indexes: IndexDefinitions,
  name: string,
  table: string,
  columns: readonly string[],
  unique = false,
): void {
  expect(indexes.get(name), `migration must declare index ${name}`).toEqual({ unique, table, columns });
}

const tables = parseTables(migration);
const indexes = parseIndexes(migration);
const tableNames = [...tables.keys()];
const expectedTables = [
  'tenants',
  'actors',
  'region_bindings',
  'proposals',
  'approvals',
  'revisions',
  'publications',
  'deploy_receipts',
  'audit_events',
  'idempotency_records',
] as const;

function tableBody(name: (typeof expectedTables)[number]): string {
  const body = tables.get(name);
  if (body === undefined) throw new Error(`missing CREATE TABLE cms_storage.${name}`);
  return body;
}

describe('0001_governance.sql', () => {
  it('parses a complete, governance-only migration from the package-relative path', () => {
    expect(migrationPath.endsWith('/packages/storage/migrations/0001_governance.sql')).toBe(true);
    expect(tableNames).toEqual(expectedTables);
    expect(tableNames.some((name) => /^(?:content|contents|asset|assets|media|documents?|entries|pages|blobs|files)$/.test(name))).toBe(false);
    expect(normalizeSql(migration)).not.toMatch(/create table cms_storage\.(?:content|contents|asset|assets|media|documents?|entries|pages|blobs|files)\b/);
  });

  it('tenant-scopes every governance child and prevents cascading lineage deletion', () => {
    for (const table of expectedTables.slice(1)) {
      const body = tableBody(table);
      expectClause(body, /\btenant_id\s+uuid\s+not null\b/, `${table} must require tenant_id`);
      expectClause(
        body,
        new RegExp(`constraint ${table}_tenant_fk\\s+foreign key \\(tenant_id\\) references cms_storage\\.tenants \\(id\\) on delete restrict`),
        `${table} must restrict deletion through its tenant foreign key`,
      );
      const tenantIndex = [...indexes.values()].find(
        (index) => index.table === table && index.columns[0] === 'tenant_id',
      );
      expect(tenantIndex, `${table} needs an index led by tenant_id`).toBeDefined();
    }
  });

  it('makes idempotency tenant-local, atomic, and state constrained', () => {
    const body = tableBody('idempotency_records');
    expectIndex(
      indexes,
      'idempotency_records_tenant_key_uq',
      'idempotency_records',
      ['tenant_id', 'idempotency_key'],
      true,
    );
    expectClause(body, /request_fingerprint\s+varchar\(64\)\s+not null/, 'request fingerprint must be required');
    expectClause(body, /constraint idempotency_records_fingerprint_chk\s+check \(request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/, 'request fingerprints must be hashes');
    expectClause(body, /constraint idempotency_records_outcome_chk\s+check \(outcome in \('in_progress','succeeded','failed'\)\)/, 'outcomes must be closed');
    expectClause(body, /constraint idempotency_records_finalized_consistency_chk\s+check \(\(outcome in \('succeeded','failed'\)\) = \(finalized_at is not null\)\)/, 'terminal outcomes need finalization');
    expectClause(body, /constraint idempotency_records_response_consistency_chk\s+check \(\(outcome in \('succeeded','failed'\)\) = \(response is not null\)\)/, 'terminal outcomes need a recorded response');
    expectClause(body, /constraint idempotency_records_in_progress_lock_chk\s+check \(\(outcome = 'in_progress'\) = \(lock_expires_at is not null\)\)/, 'in-progress outcomes need a lock');
  });

  it('constrains optimistic and revision lineage versions', () => {
    for (const table of ['region_bindings', 'proposals', 'publications'] as const) {
      const body = tableBody(table);
      expectClause(body, /\bversion\s+bigint\s+not null\s+default 1\b/, `${table} needs an initial bigint version`);
      expectClause(
        body,
        new RegExp(`constraint ${table}_version_chk\\s+check \\(version >= 1\\)`),
        `${table} must reject unsafe versions`,
      );
    }

    const revisionBody = tableBody('revisions');
    expectClause(revisionBody, /\bversion\s+bigint\s+not null\b/, 'revision version must be required');
    expectClause(revisionBody, /constraint revisions_version_chk\s+check \(version >= 1\)/, 'revision versions must be positive');
    expectIndex(indexes, 'revisions_proposal_version_uq', 'revisions', ['proposal_id', 'version'], true);
  });

  it('pins the required restrictive governance relationships', () => {
    const relationships = [
      ['proposals', 'proposals_region_fk', 'region_binding_id', 'region_bindings'],
      ['proposals', 'proposals_proposed_by_fk', 'proposed_by_actor_id', 'actors'],
      ['approvals', 'approvals_proposal_fk', 'proposal_id', 'proposals'],
      ['approvals', 'approvals_approver_fk', 'approver_actor_id', 'actors'],
      ['revisions', 'revisions_proposal_fk', 'proposal_id', 'proposals'],
      ['revisions', 'revisions_region_fk', 'region_binding_id', 'region_bindings'],
      ['revisions', 'revisions_parent_fk', 'parent_revision_id', 'revisions'],
      ['publications', 'publications_proposal_fk', 'proposal_id', 'proposals'],
      ['publications', 'publications_canonical_revision_fk', 'canonical_revision_id', 'revisions'],
      ['deploy_receipts', 'deploy_receipts_publication_fk', 'publication_id', 'publications'],
      ['audit_events', 'audit_events_approval_fk', 'approval_id', 'approvals'],
    ] as const;

    for (const [table, constraint, column, target] of relationships) {
      expectClause(
        tableBody(table),
        new RegExp(`constraint ${constraint}\\s+foreign key \\(${column}\\) references cms_storage\\.${target} \\(id\\) on delete restrict`),
        `${constraint} must preserve governance lineage`,
      );
    }
  });

  it('uses timestamptz exclusively for timestamp columns', () => {
    const withoutComments = stripComments(migration);
    expect(withoutComments).not.toMatch(/\btimestamp(?:\s+without\s+time\s+zone)?\b(?!\s+with\s+time\s+zone)/i);

    const timestampColumns = [...withoutComments.matchAll(/^\s*[a-z_]+\s+timestamptz\b/gim)];
    expect(timestampColumns.length).toBeGreaterThan(0);
    const timestampColumnNames = [...withoutComments.matchAll(/^\s*([a-z_]+)\s+timestamptz\b/gim)]
      .flatMap((match) => match[1] === undefined ? [] : [match[1]]);
    for (const required of [
      'created_at',
      'updated_at',
      'disabled_at',
      'approved_at',
      'occurred_at',
      'persisted_at',
      'received_at',
      'completed_at',
      'finalized_at',
      'live_at',
      'validated_at',
      'canonical_written_at',
      'lock_expires_at',
    ]) {
      expect(timestampColumnNames, `${required} must use timestamptz wherever declared`).toContain(required);
    }
  });

  it('enforces append-only audit events with all mutation triggers', () => {
    const sql = normalizeSql(migration);
    expect(sql).toMatch(/create or replace function cms_storage\.reject_mutation\(\) returns trigger language plpgsql/);
    expect(sql).toMatch(/raise exception .* using errcode = 'p0001'/);

    for (const [trigger, operation, level] of [
      ['audit_events_no_update', 'update', 'each row'],
      ['audit_events_no_delete', 'delete', 'each row'],
      ['audit_events_no_truncate', 'truncate', 'each statement'],
    ] as const) {
      expect(sql).toMatch(
        new RegExp(`create trigger ${trigger} before ${operation} on cms_storage\\.audit_events for ${level} execute function cms_storage\\.reject_mutation\\(\\)`),
      );
    }

    expect(sql).not.toMatch(/create trigger [a-z_]+ (?:before|after) (?:update|delete|truncate) on cms_storage\.idempotency_records/);
  });

  it('keeps revisions structurally append-oriented and content-addressable', () => {
    const body = tableBody('revisions');
    expect(body).not.toMatch(/\bupdated_at\b/);
    expectClause(body, /\bdiff\s+jsonb\s+not null\b/, 'revision diff must be retained');
    expectClause(body, /\bdiff_hash\s+varchar\(64\)\s+not null\b/, 'revision diff hash must be retained');
    expectClause(body, /constraint revisions_diff_hash_chk\s+check \(diff_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/, 'revision diff hash must be constrained');
    expectClause(body, /constraint revisions_parent_fk\s+foreign key \(parent_revision_id\) references cms_storage\.revisions \(id\) on delete restrict/, 'revision parent lineage must be retained');
  });

  it('declares all required operational indexes with their ordered columns', () => {
    const required: ReadonlyArray<readonly [string, string, readonly string[], boolean?]> = [
      ['actors_tenant_kind_idx', 'actors', ['tenant_id', 'kind']],
      ['region_bindings_tenant_adapter_idx', 'region_bindings', ['tenant_id', 'adapter_id']],
      ['region_bindings_approval_state_idx', 'region_bindings', ['tenant_id', 'approval_state']],
      ['proposals_tenant_state_idx', 'proposals', ['tenant_id', 'state']],
      ['proposals_region_state_idx', 'proposals', ['region_binding_id', 'state']],
      ['approvals_tenant_proposal_idx', 'approvals', ['tenant_id', 'proposal_id']],
      ['revisions_tenant_region_idx', 'revisions', ['tenant_id', 'region_binding_id']],
      ['publications_tenant_status_idx', 'publications', ['tenant_id', 'status']],
      ['deploy_receipts_tenant_external_uq', 'deploy_receipts', ['tenant_id', 'adapter_id', 'external_deploy_id'], true],
      ['audit_events_tenant_occurred_idx', 'audit_events', ['tenant_id', 'occurred_at']],
      ['audit_events_tenant_actor_idx', 'audit_events', ['tenant_id', 'actor_id', 'occurred_at']],
      ['audit_events_tenant_proposal_idx', 'audit_events', ['tenant_id', 'proposal_id']],
      ['idempotency_records_outcome_idx', 'idempotency_records', ['tenant_id', 'outcome']],
    ];

    for (const [name, table, columns, unique = false] of required) {
      expectIndex(indexes, name, table, columns, unique);
    }
  });
});
