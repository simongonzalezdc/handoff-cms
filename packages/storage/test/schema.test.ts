import { describe, expect, it } from 'vitest';
import { getTableConfig, type AnyPgTable } from 'drizzle-orm/pg-core';
import {
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
} from '../src/schema.js';

const tables = [
  tenants,
  actors,
  regionBindings,
  proposals,
  approvals,
  revisions,
  publications,
  deployReceipts,
  auditEvents,
  idempotencyRecords,
] as const;

const tenantScopedTables = tables.filter((table) => getTableConfig(table).name !== 'tenants');

function config(table: AnyPgTable) {
  return getTableConfig(table);
}

function indexColumns(table: AnyPgTable, name: string): readonly string[] {
  const tableConfig = config(table);
  const found = tableConfig.indexes.find((candidate) => candidate.config.name === name);
  expect(found, `${tableConfig.name} must declare index ${name}`).toBeDefined();
  return found!.config.columns.map((column) => {
    expect('name' in column && typeof column.name === 'string', `${name} must use named columns`).toBe(true);
    return (column as { name: string }).name;
  });
}

function foreignKey(table: AnyPgTable, name: string) {
  const tableConfig = config(table);
  const found = tableConfig.foreignKeys.find((candidate) => candidate.getName() === name);
  expect(found, `${tableConfig.name} must declare foreign key ${name}`).toBeDefined();
  return found!;
}

function expectForeignKey(
  table: AnyPgTable,
  name: string,
  localColumns: readonly string[],
  foreignTable: string,
  foreignColumns: readonly string[],
): void {
  const key = foreignKey(table, name);
  const reference = key.reference();
  expect(reference.columns.map((column) => column.name)).toEqual(localColumns);
  expect(config(reference.foreignTable).name).toBe(foreignTable);
  expect(reference.foreignColumns.map((column) => column.name)).toEqual(foreignColumns);
  expect(key.onDelete).toBe('restrict');
}

describe('exported Drizzle governance schema', () => {
  it('contains exactly the governance tables in the reserved namespace', () => {
    expect(tables.map((table) => config(table).name)).toEqual([
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
    ]);
    expect(tables.every((table) => config(table).schema === 'cms_storage')).toBe(true);
  });

  it('tenant-scopes every governance child with a required tenant foreign key and leading tenant index', () => {
    for (const table of tenantScopedTables) {
      const tableConfig = config(table);
      const tenantColumn = tableConfig.columns.find((column) => column.name === 'tenant_id');
      expect(tenantColumn, `${tableConfig.name} must carry tenant_id`).toBeDefined();
      expect(tenantColumn!.notNull, `${tableConfig.name}.tenant_id must be required`).toBe(true);

      const tenantKey = tableConfig.foreignKeys.find((candidate) => {
        const reference = candidate.reference();
        return reference.columns.length === 1 && reference.columns[0]?.name === 'tenant_id';
      });
      expect(tenantKey, `${tableConfig.name}.tenant_id must be a foreign key`).toBeDefined();
      expect(config(tenantKey!.reference().foreignTable).name).toBe('tenants');
      expect(tenantKey!.reference().foreignColumns.map((column) => column.name)).toEqual(['id']);
      expect(tenantKey!.onDelete).toBe('restrict');

      const tenantLeadingIndex = tableConfig.indexes.find((candidate) => {
        const firstColumn = candidate.config.columns[0];
        return firstColumn !== undefined && 'name' in firstColumn && firstColumn.name === 'tenant_id';
      });
      expect(tenantLeadingIndex, `${tableConfig.name} needs a tenant-leading index`).toBeDefined();
    }
  });

  it('enforces unique tenant-local idempotency keys', () => {
    const tableConfig = config(idempotencyRecords);
    expect(indexColumns(idempotencyRecords, 'idempotency_records_tenant_key_uq')).toEqual([
      'tenant_id',
      'idempotency_key',
    ]);
    expect(
      tableConfig.indexes.find((candidate) => candidate.config.name === 'idempotency_records_tenant_key_uq')
        ?.config.unique,
    ).toBe(true);
    expect(tableConfig.columns.find((column) => column.name === 'idempotency_key')?.notNull).toBe(true);
    expect(tableConfig.checks.map((candidate) => candidate.name)).toEqual(expect.arrayContaining([
      'idempotency_records_fingerprint_chk',
      'idempotency_records_outcome_chk',
      'idempotency_records_finalized_consistency_chk',
      'idempotency_records_response_consistency_chk',
      'idempotency_records_in_progress_lock_chk',
    ]));
  });

  it('uses constrained optimistic versions on every mutable versioned table', () => {
    for (const [table, checkName] of [
      [regionBindings, 'region_bindings_version_chk'],
      [proposals, 'proposals_version_chk'],
      [publications, 'publications_version_chk'],
    ] as const) {
      const tableConfig = config(table);
      const version = tableConfig.columns.find((column) => column.name === 'version');
      expect(version?.getSQLType(), `${tableConfig.name}.version must be bigint`).toBe('bigint');
      expect(version?.notNull, `${tableConfig.name}.version must be required`).toBe(true);
      expect(version?.hasDefault, `${tableConfig.name}.version must default`).toBe(true);
      expect(tableConfig.checks.some((candidate) => candidate.name === checkName)).toBe(true);
    }

    const revisionVersion = config(revisions).columns.find((column) => column.name === 'version');
    expect(revisionVersion?.getSQLType()).toBe('bigint');
    expect(revisionVersion?.notNull).toBe(true);
    expect(config(revisions).checks.some((candidate) => candidate.name === 'revisions_version_chk')).toBe(true);
    expect(indexColumns(revisions, 'revisions_proposal_version_uq')).toEqual(['proposal_id', 'version']);
    expect(config(revisions).indexes.find((candidate) => candidate.config.name === 'revisions_proposal_version_uq')?.config.unique).toBe(true);
  });

  it('keeps the governance lineage foreign-key graph explicit and restrictive', () => {
    expectForeignKey(proposals, 'proposals_region_fk', ['region_binding_id'], 'region_bindings', ['id']);
    expectForeignKey(proposals, 'proposals_proposed_by_fk', ['proposed_by_actor_id'], 'actors', ['id']);
    expectForeignKey(approvals, 'approvals_proposal_fk', ['proposal_id'], 'proposals', ['id']);
    expectForeignKey(approvals, 'approvals_approver_fk', ['approver_actor_id'], 'actors', ['id']);
    expectForeignKey(revisions, 'revisions_proposal_fk', ['proposal_id'], 'proposals', ['id']);
    expectForeignKey(revisions, 'revisions_region_fk', ['region_binding_id'], 'region_bindings', ['id']);
    expectForeignKey(revisions, 'revisions_parent_fk', ['parent_revision_id'], 'revisions', ['id']);
    expectForeignKey(publications, 'publications_proposal_fk', ['proposal_id'], 'proposals', ['id']);
    expectForeignKey(publications, 'publications_canonical_revision_fk', ['canonical_revision_id'], 'revisions', ['id']);
    expectForeignKey(deployReceipts, 'deploy_receipts_publication_fk', ['publication_id'], 'publications', ['id']);
    expectForeignKey(auditEvents, 'audit_events_approval_fk', ['approval_id'], 'approvals', ['id']);
  });

  it('models every date-valued column as timestamp with time zone', () => {
    const timestamps = tables.flatMap((table) => config(table).columns.filter((column) => column.dataType === 'date'));
    expect(timestamps.length).toBeGreaterThan(0);
    expect(timestamps.map((column) => column.getSQLType())).toEqual(
      Array.from({ length: timestamps.length }, () => 'timestamp with time zone'),
    );
  });

  it('exposes the required tenant-safe operational indexes', () => {
    const required = new Map<AnyPgTable, Record<string, readonly string[]>>([
      [actors, { actors_tenant_kind_idx: ['tenant_id', 'kind'] }],
      [regionBindings, {
        region_bindings_tenant_adapter_idx: ['tenant_id', 'adapter_id'],
        region_bindings_approval_state_idx: ['tenant_id', 'approval_state'],
      }],
      [proposals, {
        proposals_tenant_state_idx: ['tenant_id', 'state'],
        proposals_proposed_by_idx: ['tenant_id', 'proposed_by_actor_id'],
      }],
      [approvals, { approvals_tenant_proposal_idx: ['tenant_id', 'proposal_id'] }],
      [revisions, { revisions_tenant_region_idx: ['tenant_id', 'region_binding_id'] }],
      [publications, { publications_tenant_status_idx: ['tenant_id', 'status'] }],
      [deployReceipts, { deploy_receipts_status_idx: ['tenant_id', 'status'] }],
      [auditEvents, {
        audit_events_tenant_occurred_idx: ['tenant_id', 'occurred_at'],
        audit_events_tenant_actor_idx: ['tenant_id', 'actor_id', 'occurred_at'],
        audit_events_tenant_proposal_idx: ['tenant_id', 'proposal_id'],
      }],
      [idempotencyRecords, { idempotency_records_outcome_idx: ['tenant_id', 'outcome'] }],
    ]);

    for (const [table, indexes] of required) {
      for (const [name, columns] of Object.entries(indexes)) {
        expect(indexColumns(table, name)).toEqual(columns);
      }
    }
  });

  it('represents revisions and audit events as immutable records without update cursors', () => {
    expect(config(revisions).columns.map((column) => column.name)).not.toContain('updated_at');
    expect(config(auditEvents).columns.map((column) => column.name)).not.toContain('updated_at');
    expect(config(auditEvents).columns.find((column) => column.name === 'event_hash')?.primary).toBe(true);
    expect(config(revisions).columns.find((column) => column.name === 'diff_hash')?.notNull).toBe(true);
  });
});
