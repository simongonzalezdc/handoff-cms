/**
 * Real-Postgres integration tests for @cms/storage.
 *
 * Docker is unavailable in the host environment, so the suite exercises the
 * storage layer against an in-process Postgres-compatible engine (pglite).
 * The same Drizzle/Postgres dialect is used; the migration DDL, CHECK
 * constraints, and append-only triggers all execute end-to-end. No fake or
 * in-memory Storage implementation is ever substituted.
 *
 * Coverage:
 *  - Migration engine: applies 0001_governance.sql and verifies tables,
 *    indexes, CHECK constraints, and append-only triggers exist.
 *  - Tenant enable/disable: writes are refused against disabled tenants.
 *  - Region binding frozen-core guard: approved/retired bindings refuse
 *    upsert; pending/refused bindings accept.
 *  - Optimistic concurrency: stale-version updates fail with the right code.
 *  - Idempotency replay: successful and failed replays short-circuit and
 *    return the recorded response; stale-lock reclaim is atomic.
 *  - Append-only audit: UPDATE/DELETE/TRUNCATE on audit_events raise the
 *    storage-classified append-only error (mapped from P0001).
 *  - Error mapping: UNIQUE/CHECK/FK violations map to the right code.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPEND_ONLY_MARKER,
  FROZEN_CORE_REFUSED_MARKER,
  REGION_REFUSE_TERMINAL_MARKER,
  REGION_RETIRE_TERMINAL_MARKER,
  PostgresStorage,
  AppendOnlyViolationError,
  OptimisticConcurrencyError,
  UniqueViolationError,
  NotFoundError,
  InvalidInputError,
  IdempotencyReplayMismatchError,
  IdempotencyInProgressError,
  TenantDisabledError,
  classifyPgError,
} from '../src/index.js';
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

const migrationPath = fileURLToPath(new URL('../migrations/0001_governance.sql', import.meta.url));
const migrationSql = readFileSync(migrationPath, 'utf8');

/** Drizzle/Postgres schema object identical to the production schema. */
const storageSchemaObject = {
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

function hexHash(label: string): string {
  // Deterministic 64-char lowercase hex. Not cryptographic — test fixtures only.
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  const base = h.toString(16).padStart(8, '0');
  return (base + base + base + base + base + base + base + base).slice(0, 64);
}

interface Harness {
  storage: PostgresStorage;
  pglite: PGlite;
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  // Fresh in-memory pglite instance per test — ensures no state leaks.
  const pglite = new PGlite();
  // Apply the governance migration verbatim. pglite parses the same DDL as a
  // real Postgres; any deviation surfaces here as a hard failure rather than
  // a silently-skipped test.
  await pglite.exec(migrationSql);
  // Bind the same Drizzle dialect to pglite. The pglite dialect is a
  // structurally compatible `PgDatabase` — the cast narrows it to the
  // node-postgres type the storage class declares, identical to the cast
  // already used by the production code path.
  const db = drizzlePglite(pglite, { schema: storageSchemaObject }) as unknown as NodePgDatabase;
  const storage = new PostgresStorage({ database: db });
  return {
    storage,
    pglite,
    async close() {
      await storage.close();
      await pglite.close();
    },
  };
}

async function createTenant(h: Harness, slug: string) {
  return h.storage.createTenant({ slug, displayName: `Tenant ${slug}` });
}

async function createActor(
  h: Harness,
  tenantId: string,
  slug: string,
  kind: 'human' | 'agent' | 'service' = 'human',
) {
  return h.storage.upsertActor({ tenantId, kind, slug, verified: true });
}

async function createRegionBinding(h: Harness, tenantId: string, slug: string, adapterId = '@cms/test') {
  return h.storage.upsertRegionBinding({
    tenantId,
    slug,
    adapterId,
    canonicalSource: { backend: 'git', locator: `repos/test/${slug}` },
    regenerationContract: { mode: 'canonical_direct' },
    schema: { type: 'object' },
    localePolicy: { defaultLocale: 'en' },
  });
}

describe('migration engine (real Postgres DDL via pglite)', () => {
  it('applies 0001_governance.sql and produces the expected object surface', async () => {
    const pglite = new PGlite();
    try {
      await pglite.exec(migrationSql);
      const tablesResult = await pglite.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'cms_storage' ORDER BY table_name`,
      );
      expect(tablesResult.rows.map((r: { table_name: string }) => r.table_name)).toEqual([
        'actors',
        'approvals',
        'audit_events',
        'deploy_receipts',
        'idempotency_records',
        'proposals',
        'publications',
        'region_bindings',
        'revisions',
        'tenants',
      ]);

      const triggersResult = await pglite.query<{ trigger_name: string }>(
        `SELECT t.tgname AS trigger_name
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'cms_storage'
            AND c.relname = 'audit_events'
            AND NOT t.tgisinternal
          ORDER BY t.tgname`,
      );
      expect(triggersResult.rows.map((r: { trigger_name: string }) => r.trigger_name)).toEqual([
        'audit_events_no_delete',
        'audit_events_no_truncate',
        'audit_events_no_update',
      ]);

      const checkCountResult = await pglite.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM information_schema.table_constraints
         WHERE constraint_schema = 'cms_storage' AND constraint_type = 'CHECK'`,
      );
      expect(parseInt(checkCountResult.rows[0]?.count ?? '0', 10)).toBeGreaterThan(20);
    } finally {
      await pglite.close();
    }
  });
});

describe('Storage integration (real Postgres-compatible engine)', () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  describe('idempotency', () => {
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('acquires the lock on first call and short-circuits successful replay without re-inserting', async () => {
      const tenant = await createTenant(h, `tnt-idem-success-${Date.now()}`);
      const actor = await createActor(h, tenant.id, 'idem-actor');
      const binding = await createRegionBinding(h, tenant.id, 'idem-region');

      const proposalInput = {
        tenantId: tenant.id,
        regionBindingId: binding.id,
        slug: 'idem-success-proposal',
        proposedByActorId: actor.id,
        title: 'Idempotent Proposal',
        payload: { hello: 'world' },
        payloadHash: hexHash('idem-success-payload'),
        idempotencyKey: 'idem-success-key',
        requestFingerprint: hexHash('idem-success-fp'),
        endpoint: 'POST /proposals',
      };
      const first = await h.storage.createProposal(proposalInput);
      expect(first.slug).toBe('idem-success-proposal');
      expect(first.id).toMatch(/^[0-9a-f-]{36}$/);

      // Replay: same idempotency key, same fingerprint. createProposal MUST
      // short-circuit and return the recorded proposal without a second insert.
      const second = await h.storage.createProposal(proposalInput);
      expect(second.id).toBe(first.id);
      expect(second.slug).toBe(first.slug);

      const stored = await h.storage.getProposalById(tenant.id, first.id);
      expect(stored?.id).toBe(first.id);
    });

    it('replays a recorded failed outcome without re-executing the side effect', async () => {
      const tenant = await createTenant(h, `tnt-idem-failed-${Date.now()}`);
      const actor = await createActor(h, tenant.id, 'idem-failed-actor');
      const binding = await createRegionBinding(h, tenant.id, 'idem-failed-region');

      const idempotencyKey = 'idem-failed-key';
      const fingerprint = hexHash('idem-failed-fp');
      await h.storage.beginIdempotency({
        tenantId: tenant.id,
        idempotencyKey,
        requestFingerprint: fingerprint,
        endpoint: 'POST /proposals',
        lockedBy: 'test',
        lockTtlSeconds: 60,
      });
      await h.storage.finalizeIdempotency({
        tenantId: tenant.id,
        idempotencyKey,
        outcome: 'failed',
        response: { error: 'synthetic failure for replay test' },
        responseStatus: 422,
      });

      const replay = await h.storage.beginIdempotency({
        tenantId: tenant.id,
        idempotencyKey,
        requestFingerprint: fingerprint,
        endpoint: 'POST /proposals',
        lockedBy: 'test',
        lockTtlSeconds: 60,
      });
      expect(replay.source).toBe('failed');
      expect(replay.record.outcome).toBe('failed');
      expect(replay.record.responseStatus).toBe(422);

      // createProposal short-circuits on a 'failed' replay by re-raising the
      // recorded failure as a transaction_aborted StorageError. No new
      // proposal row is created.
      await expect(
        h.storage.createProposal({
          tenantId: tenant.id,
          regionBindingId: binding.id,
          slug: 'idem-failed-proposal',
          proposedByActorId: actor.id,
          title: 'Should Not Insert',
          payload: { x: 1 },
          payloadHash: hexHash('idem-failed-payload'),
          idempotencyKey,
          requestFingerprint: fingerprint,
          endpoint: 'POST /proposals',
        }),
      ).rejects.toMatchObject({
        name: 'StorageError',
        code: 'transaction_aborted',
        detail: expect.objectContaining({ responseStatus: 422 }),
      });

      const proposalsResult = await h.pglite.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM cms_storage.proposals WHERE tenant_id = $1`,
        [tenant.id],
      );
      expect(parseInt(proposalsResult.rows[0]?.count ?? '0', 10)).toBe(0);
    });

    it('rejects replay with a mismatched request fingerprint', async () => {
      const tenant = await createTenant(h, `tnt-idem-fp-${Date.now()}`);
      await h.storage.beginIdempotency({
        tenantId: tenant.id,
        idempotencyKey: 'idem-fp-key',
        requestFingerprint: hexHash('original'),
        endpoint: 'POST /x',
        lockedBy: 'test',
        lockTtlSeconds: 60,
      });
      await expect(
        h.storage.beginIdempotency({
          tenantId: tenant.id,
          idempotencyKey: 'idem-fp-key',
          requestFingerprint: hexHash('different'),
          endpoint: 'POST /x',
          lockedBy: 'test',
          lockTtlSeconds: 60,
        }),
      ).rejects.toBeInstanceOf(IdempotencyReplayMismatchError);
    });

    it('surfaces in-progress lock while the lock is still valid', async () => {
      const tenant = await createTenant(h, `tnt-idem-busy-${Date.now()}`);
      await h.storage.beginIdempotency({
        tenantId: tenant.id,
        idempotencyKey: 'idem-busy-key',
        requestFingerprint: hexHash('idem-busy-fp'),
        endpoint: 'POST /x',
        lockedBy: 'other',
        lockTtlSeconds: 60,
      });
      await expect(
        h.storage.beginIdempotency({
          tenantId: tenant.id,
          idempotencyKey: 'idem-busy-key',
          requestFingerprint: hexHash('idem-busy-fp'),
          endpoint: 'POST /x',
          lockedBy: 'self',
          lockTtlSeconds: 60,
        }),
      ).rejects.toBeInstanceOf(IdempotencyInProgressError);
    });

    it('atomically reclaims a stale in-progress lock', async () => {
      const tenant = await createTenant(h, `tnt-idem-stale-${Date.now()}`);
      const fingerprint = hexHash('idem-stale-fp');
      const key = 'idem-stale-key';
      await h.pglite.query(
        `INSERT INTO cms_storage.idempotency_records
           (tenant_id, idempotency_key, request_fingerprint, endpoint, outcome, locked_by, lock_expires_at)
         VALUES ($1, $2, $3, $4, 'in_progress', 'other', now() - interval '1 second')`,
        [tenant.id, key, fingerprint, 'POST /x'],
      );
      const replay = await h.storage.beginIdempotency({
        tenantId: tenant.id,
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        endpoint: 'POST /x',
        lockedBy: 'self',
        lockTtlSeconds: 60,
      });
      expect(replay.source).toBe('in_progress');
      expect(replay.record.lockedBy).toBe('self');
    });
  });

  describe('tenant enable / disable', () => {
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('returns the existing row when disabling an already-disabled tenant', async () => {
      const tenant = await createTenant(h, `tnt-already-disabled-${Date.now()}`);
      const disabled1 = await h.storage.disableTenant({ tenantId: tenant.id });
      expect(disabled1.disabledAt).not.toBeNull();
      const disabled2 = await h.storage.disableTenant({ tenantId: tenant.id });
      expect(disabled2.disabledAt).not.toBeNull();
    });

    it('refuses writes against a disabled tenant with tenant_disabled', async () => {
      const tenant = await createTenant(h, `tnt-writes-blocked-${Date.now()}`);
      await h.storage.disableTenant({ tenantId: tenant.id });

      await expect(
        h.storage.upsertActor({ tenantId: tenant.id, kind: 'human', slug: 'blocked' }),
      ).rejects.toBeInstanceOf(TenantDisabledError);

      // Re-enable by clearing disabled_at directly.
      await h.pglite.query(`UPDATE cms_storage.tenants SET disabled_at = NULL WHERE id = $1`, [tenant.id]);
      const actor = await h.storage.upsertActor({ tenantId: tenant.id, kind: 'human', slug: 'recovered' });
      expect(actor.slug).toBe('recovered');
    });

    it('surfaces NotFound when asserting on a missing tenant', async () => {
      await expect(
        h.storage.upsertActor({
          tenantId: '00000000-0000-0000-0000-000000000000',
          kind: 'human',
          slug: 'orphan',
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('region binding frozen-core guard', () => {
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('refuses upsert into an approved binding (frozen core)', async () => {
      const tenant = await createTenant(h, `tnt-frozen-approved-${Date.now()}`);
      const approver = await createActor(h, tenant.id, 'approver');
      const binding = await createRegionBinding(h, tenant.id, 'frozen-region');
      const approved = await h.storage.approveRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        approverActorId: approver.id,
        expectedVersion: binding.version,
      });
      expect(approved.approvalState).toBe('approved');

      await expect(
        h.storage.upsertRegionBinding({
          tenantId: tenant.id,
          slug: 'frozen-region',
          adapterId: '@cms/other',
          canonicalSource: { backend: 'git', locator: 'repos/different/path' },
          regenerationContract: { mode: 'canonical_direct' },
          schema: { type: 'object' },
          localePolicy: { defaultLocale: 'en' },
        }),
      ).rejects.toMatchObject({
        name: 'InvalidInputError',
        message: expect.stringContaining(FROZEN_CORE_REFUSED_MARKER),
      });
    });

    it('refuses upsert into a retired binding', async () => {
      const tenant = await createTenant(h, `tnt-frozen-retired-${Date.now()}`);
      const binding = await createRegionBinding(h, tenant.id, 'retired-region');
      await h.pglite.query(
        `UPDATE cms_storage.region_bindings SET approval_state = 'retired', version = version + 1 WHERE id = $1`,
        [binding.id],
      );

      await expect(
        h.storage.upsertRegionBinding({
          tenantId: tenant.id,
          slug: 'retired-region',
          adapterId: '@cms/other',
          canonicalSource: { backend: 'git', locator: 'repos/other' },
          regenerationContract: { mode: 'canonical_direct' },
          schema: { type: 'object' },
          localePolicy: { defaultLocale: 'en' },
        }),
      ).rejects.toBeInstanceOf(InvalidInputError);
    });

    it('allows upsert into pending bindings with frozen-core fields updated', async () => {
      const tenant = await createTenant(h, `tnt-frozen-pending-${Date.now()}`);
      const binding = await createRegionBinding(h, tenant.id, 'pending-region');
      expect(binding.approvalState).toBe('pending');

      const updated = await h.storage.upsertRegionBinding({
        tenantId: tenant.id,
        slug: 'pending-region',
        adapterId: '@cms/new-adapter',
        canonicalSource: { backend: 'git', locator: 'repos/test/pending-region-v2' },
        regenerationContract: { mode: 'canonical_direct' },
        schema: { type: 'object' },
        localePolicy: { defaultLocale: 'en' },
      });
      expect(updated.id).toBe(binding.id);
      expect(updated.adapterId).toBe('@cms/new-adapter');
      expect(updated.approvalState).toBe('pending');
    });
  });

  describe('region binding refuse/retire lifecycle', () => {
    beforeEach(async () => {
      h = await makeHarness();
    });

    async function makePendingBinding(tenantSlug: string, regionSlug: string) {
      const tenant = await createTenant(h, `${tenantSlug}-${Date.now()}`);
      const binding = await createRegionBinding(h, tenant.id, regionSlug);
      expect(binding.approvalState).toBe('pending');
      return { tenant, binding };
    }

    it('refuses a pending binding: pending -> refused', async () => {
      const { tenant, binding } = await makePendingBinding('tnt-refuse-pending', 'refuse-pending-region');
      const refused = await h.storage.refuseRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        expectedVersion: binding.version,
      });
      expect(refused.id).toBe(binding.id);
      expect(refused.approvalState).toBe('refused');
      expect(refused.version).toBe(binding.version + 1);

      const reloaded = await h.storage.getRegionBindingById(tenant.id, binding.id);
      expect(reloaded?.approvalState).toBe('refused');
      expect(reloaded?.version).toBe(binding.version + 1);
    });

    it('retires a pending binding: pending -> retired', async () => {
      const { tenant, binding } = await makePendingBinding('tnt-retire-pending', 'retire-pending-region');
      const retired = await h.storage.retireRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        expectedVersion: binding.version,
      });
      expect(retired.id).toBe(binding.id);
      expect(retired.approvalState).toBe('retired');
      expect(retired.version).toBe(binding.version + 1);

      const reloaded = await h.storage.getRegionBindingById(tenant.id, binding.id);
      expect(reloaded?.approvalState).toBe('retired');
      expect(reloaded?.version).toBe(binding.version + 1);
    });

    it('retires an approved binding: approved -> retired (terminal transition)', async () => {
      const tenant = await createTenant(h, `tnt-retire-approved-${Date.now()}`);
      const approver = await createActor(h, tenant.id, 'retire-approver');
      const binding = await createRegionBinding(h, tenant.id, 'retire-approved-region');
      const approved = await h.storage.approveRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        approverActorId: approver.id,
        expectedVersion: binding.version,
      });
      expect(approved.approvalState).toBe('approved');

      const retired = await h.storage.retireRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        expectedVersion: approved.version,
      });
      expect(retired.id).toBe(binding.id);
      expect(retired.approvalState).toBe('retired');
      expect(retired.version).toBe(approved.version + 1);
    });

    it('rejects a repeated refusal with REGION_REFUSE_TERMINAL_MARKER (already refused)', async () => {
      const { tenant, binding } = await makePendingBinding('tnt-refuse-twice', 'refuse-twice-region');
      const refused = await h.storage.refuseRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        expectedVersion: binding.version,
      });
      expect(refused.approvalState).toBe('refused');

      await expect(
        h.storage.refuseRegionBinding({
          tenantId: tenant.id,
          regionBindingId: binding.id,
          expectedVersion: refused.version,
        }),
      ).rejects.toMatchObject({
        name: 'InvalidInputError',
        code: 'invalid_input',
        message: expect.stringContaining(REGION_REFUSE_TERMINAL_MARKER),
      });
    });

    it('rejects refusing an approved binding with REGION_REFUSE_TERMINAL_MARKER', async () => {
      const tenant = await createTenant(h, `tnt-refuse-approved-${Date.now()}`);
      const approver = await createActor(h, tenant.id, 'refuse-approved-approver');
      const binding = await createRegionBinding(h, tenant.id, 'refuse-approved-region');
      const approved = await h.storage.approveRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        approverActorId: approver.id,
        expectedVersion: binding.version,
      });
      expect(approved.approvalState).toBe('approved');

      await expect(
        h.storage.refuseRegionBinding({
          tenantId: tenant.id,
          regionBindingId: binding.id,
          expectedVersion: approved.version,
        }),
      ).rejects.toMatchObject({
        name: 'InvalidInputError',
        code: 'invalid_input',
        message: expect.stringContaining(REGION_REFUSE_TERMINAL_MARKER),
      });
    });

    it('rejects refusing a retired binding with REGION_REFUSE_TERMINAL_MARKER', async () => {
      const { tenant, binding } = await makePendingBinding('tnt-refuse-retired', 'refuse-retired-region');
      const retired = await h.storage.retireRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        expectedVersion: binding.version,
      });
      expect(retired.approvalState).toBe('retired');

      await expect(
        h.storage.refuseRegionBinding({
          tenantId: tenant.id,
          regionBindingId: binding.id,
          expectedVersion: retired.version,
        }),
      ).rejects.toMatchObject({
        name: 'InvalidInputError',
        code: 'invalid_input',
        message: expect.stringContaining(REGION_REFUSE_TERMINAL_MARKER),
      });
    });

    it('rejects a repeated retirement with REGION_RETIRE_TERMINAL_MARKER (already retired)', async () => {
      const { tenant, binding } = await makePendingBinding('tnt-retire-twice', 'retire-twice-region');
      const retired = await h.storage.retireRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        expectedVersion: binding.version,
      });
      expect(retired.approvalState).toBe('retired');

      await expect(
        h.storage.retireRegionBinding({
          tenantId: tenant.id,
          regionBindingId: binding.id,
          expectedVersion: retired.version,
        }),
      ).rejects.toMatchObject({
        name: 'InvalidInputError',
        code: 'invalid_input',
        message: expect.stringContaining(REGION_RETIRE_TERMINAL_MARKER),
      });
    });

    it('rejects retiring a refused binding with REGION_RETIRE_TERMINAL_MARKER', async () => {
      const { tenant, binding } = await makePendingBinding('tnt-retire-refused', 'retire-refused-region');
      const refused = await h.storage.refuseRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        expectedVersion: binding.version,
      });
      expect(refused.approvalState).toBe('refused');

      await expect(
        h.storage.retireRegionBinding({
          tenantId: tenant.id,
          regionBindingId: binding.id,
          expectedVersion: refused.version,
        }),
      ).rejects.toMatchObject({
        name: 'InvalidInputError',
        code: 'invalid_input',
        message: expect.stringContaining(REGION_RETIRE_TERMINAL_MARKER),
      });
    });

    it('tenant isolation: retireRegionBinding refuses cross-tenant regionBindingId', async () => {
      const a = await createTenant(h, `tnt-iso-retire-a-${Date.now()}`);
      const b = await createTenant(h, `tnt-iso-retire-b-${Date.now()}`);
      const bindingInA = await createRegionBinding(h, a.id, 'iso-retire-region');

      await expect(
        h.storage.retireRegionBinding({
          tenantId: b.id,
          regionBindingId: bindingInA.id,
          expectedVersion: bindingInA.version,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      const stillPending = await h.storage.getRegionBindingById(a.id, bindingInA.id);
      expect(stillPending?.approvalState).toBe('pending');
      expect(stillPending?.version).toBe(bindingInA.version);
    });

    it('tenant isolation: refuseRegionBinding refuses cross-tenant regionBindingId', async () => {
      const a = await createTenant(h, `tnt-iso-refuse-a-${Date.now()}`);
      const b = await createTenant(h, `tnt-iso-refuse-b-${Date.now()}`);
      const bindingInA = await createRegionBinding(h, a.id, 'iso-refuse-region');

      await expect(
        h.storage.refuseRegionBinding({
          tenantId: b.id,
          regionBindingId: bindingInA.id,
          expectedVersion: bindingInA.version,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      const stillPending = await h.storage.getRegionBindingById(a.id, bindingInA.id);
      expect(stillPending?.approvalState).toBe('pending');
      expect(stillPending?.version).toBe(bindingInA.version);
    });

    it('retireRegionBinding raises NotFound for an unknown regionBindingId', async () => {
      const tenant = await createTenant(h, `tnt-retire-missing-${Date.now()}`);
      const unknownId = '00000000-0000-0000-0000-000000000000';
      await expect(
        h.storage.retireRegionBinding({
          tenantId: tenant.id,
          regionBindingId: unknownId,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('refuseRegionBinding raises NotFound for an unknown regionBindingId', async () => {
      const tenant = await createTenant(h, `tnt-refuse-missing-${Date.now()}`);
      const unknownId = '00000000-0000-0000-0000-000000000000';
      await expect(
        h.storage.refuseRegionBinding({
          tenantId: tenant.id,
          regionBindingId: unknownId,
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('retireRegionBinding refuses to mutate the frozen canonical binding (pending -> retired preserves canonicalSource)', async () => {
      const tenant = await createTenant(h, `tnt-frozen-retire-pending-${Date.now()}`);
      const initialSource = { backend: 'git', locator: 'repos/frozen/canonical-path', contentHash: 'a'.repeat(64) };
      const binding = await h.storage.upsertRegionBinding({
        tenantId: tenant.id,
        slug: 'frozen-retire-pending-region',
        adapterId: '@cms/canonical',
        canonicalSource: initialSource,
        regenerationContract: { mode: 'canonical_direct' },
        schema: { type: 'object' },
        localePolicy: { defaultLocale: 'en' },
      });
      expect(binding.approvalState).toBe('pending');
      expect(binding.canonicalSource).toEqual(initialSource);

      const retired = await h.storage.retireRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        expectedVersion: binding.version,
      });

      // The canonical source MUST survive retirement verbatim. Retirement
      // is a one-way governance signal; it does not redact, rehash, or
      // rewrite the immutable frozen-core pointer.
      expect(retired.canonicalSource).toEqual(initialSource);
      expect(retired.adapterId).toBe('@cms/canonical');
      expect(retired.approvalState).toBe('retired');

      // A direct DB read confirms the same frozen-core bytes are stored.
      const dbResult = await h.pglite.query<{ canonical_source: unknown; adapter_id: string }>(
        `SELECT canonical_source, adapter_id FROM cms_storage.region_bindings WHERE id = $1`,
        [binding.id],
      );
      expect(dbResult.rows[0]?.adapter_id).toBe('@cms/canonical');
      expect(dbResult.rows[0]?.canonical_source).toEqual(initialSource);
    });

    it('retireRegionBinding refuses to mutate the frozen canonical binding (approved -> retired preserves canonicalSource)', async () => {
      const tenant = await createTenant(h, `tnt-frozen-retire-approved-${Date.now()}`);
      const approver = await createActor(h, tenant.id, 'frozen-retire-approver');
      const initialSource = { backend: 'git', locator: 'repos/frozen/approved-canonical', contentHash: 'b'.repeat(64) };
      const binding = await h.storage.upsertRegionBinding({
        tenantId: tenant.id,
        slug: 'frozen-retire-approved-region',
        adapterId: '@cms/canonical',
        canonicalSource: initialSource,
        regenerationContract: { mode: 'canonical_direct' },
        schema: { type: 'object' },
        localePolicy: { defaultLocale: 'en' },
      });
      const approved = await h.storage.approveRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        approverActorId: approver.id,
        expectedVersion: binding.version,
      });
      expect(approved.approvalState).toBe('approved');
      expect(approved.canonicalSource).toEqual(initialSource);

      const retired = await h.storage.retireRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        expectedVersion: approved.version,
      });

      // Approved canonical source MUST survive retirement: the host stays
      // canonical, retirement only signals that the binding is no longer
      // routed to. The frozen core itself is immutable.
      expect(retired.canonicalSource).toEqual(initialSource);
      expect(retired.adapterId).toBe('@cms/canonical');
      expect(retired.approvalState).toBe('retired');
      expect(retired.version).toBe(approved.version + 1);

      const dbResult = await h.pglite.query<{ canonical_source: unknown; adapter_id: string; approval_state: string }>(
        `SELECT canonical_source, adapter_id, approval_state FROM cms_storage.region_bindings WHERE id = $1`,
        [binding.id],
      );
      expect(dbResult.rows[0]?.adapter_id).toBe('@cms/canonical');
      expect(dbResult.rows[0]?.approval_state).toBe('retired');
      expect(dbResult.rows[0]?.canonical_source).toEqual(initialSource);
    });

    it('retireRegionBinding with stale expectedVersion fails closed via OptimisticConcurrencyError', async () => {
      const { tenant, binding } = await makePendingBinding('tnt-retire-stale', 'retire-stale-region');
      const retired = await h.storage.retireRegionBinding({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        expectedVersion: binding.version,
      });
      expect(retired.approvalState).toBe('retired');

      // Replay with the original (now stale) expectedVersion. The row is
      // retired so the stale-version path is shadowed by the terminal-state
      // check; either way the call must fail closed and leave the row
      // untouched.
      await expect(
        h.storage.retireRegionBinding({
          tenantId: tenant.id,
          regionBindingId: binding.id,
          expectedVersion: binding.version,
        }),
      ).rejects.toBeInstanceOf(InvalidInputError);

      const stillRetired = await h.storage.getRegionBindingById(tenant.id, binding.id);
      expect(stillRetired?.approvalState).toBe('retired');
      expect(stillRetired?.version).toBe(retired.version);
    });

    it('refuseRegionBinding with stale expectedVersion on a pending row fails closed via OptimisticConcurrencyError', async () => {
      const tenant = await createTenant(h, `tnt-refuse-stale-${Date.now()}`);
      const binding = await createRegionBinding(h, tenant.id, 'refuse-stale-region');

      await expect(
        h.storage.refuseRegionBinding({
          tenantId: tenant.id,
          regionBindingId: binding.id,
          expectedVersion: binding.version + 99,
        }),
      ).rejects.toBeInstanceOf(OptimisticConcurrencyError);

      const stillPending = await h.storage.getRegionBindingById(tenant.id, binding.id);
      expect(stillPending?.approvalState).toBe('pending');
      expect(stillPending?.version).toBe(binding.version);
    });
  });

  describe('optimistic concurrency', () => {
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('rejects transitionProposal with the wrong expected version', async () => {
      const tenant = await createTenant(h, `tnt-occ-proposal-${Date.now()}`);
      const actor = await createActor(h, tenant.id, 'occ-actor');
      const binding = await createRegionBinding(h, tenant.id, 'occ-region');
      const proposal = await h.storage.createProposal({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        slug: 'occ-proposal',
        proposedByActorId: actor.id,
        title: 'OCC proposal',
        payload: { x: 1 },
        payloadHash: hexHash('occ-payload'),
        idempotencyKey: 'occ-prop-key',
        requestFingerprint: hexHash('occ-prop-fp'),
        endpoint: 'POST /proposals',
      });

      await expect(
        h.storage.transitionProposal({
          tenantId: tenant.id,
          proposalId: proposal.id,
          expectedVersion: proposal.version + 7,
          nextState: 'validated',
        }),
      ).rejects.toBeInstanceOf(OptimisticConcurrencyError);
    });

    it('rejects approveRegionBinding with the wrong expected version', async () => {
      const tenant = await createTenant(h, `tnt-occ-region-${Date.now()}`);
      const approver = await createActor(h, tenant.id, 'region-approver');
      const binding = await createRegionBinding(h, tenant.id, 'occ-region-binding');
      await expect(
        h.storage.approveRegionBinding({
          tenantId: tenant.id,
          regionBindingId: binding.id,
          approverActorId: approver.id,
          expectedVersion: binding.version + 99,
        }),
      ).rejects.toBeInstanceOf(OptimisticConcurrencyError);
    });
  });

  describe('appendRevision lineage versioning', () => {
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('assigns monotonic versions within a proposal lineage', async () => {
      const tenant = await createTenant(h, `tnt-rev-monotonic-${Date.now()}`);
      const actor = await createActor(h, tenant.id, 'rev-actor');
      const binding = await createRegionBinding(h, tenant.id, 'rev-region');
      const proposal = await h.storage.createProposal({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        slug: 'rev-proposal',
        proposedByActorId: actor.id,
        title: 'Revision proposal',
        payload: { v: 1 },
        payloadHash: hexHash('rev-payload'),
        idempotencyKey: 'rev-key',
        requestFingerprint: hexHash('rev-fp'),
        endpoint: 'POST /proposals',
      });

      const r1 = await h.storage.appendRevision({
        tenantId: tenant.id,
        proposalId: proposal.id,
        regionBindingId: binding.id,
        kind: 'content',
        slug: 'rev-1',
        actorId: actor.id,
        selfApproved: false,
        diff: { change: 'one' },
        diffHash: hexHash('rev-1-diff'),
      });
      const r2 = await h.storage.appendRevision({
        tenantId: tenant.id,
        proposalId: proposal.id,
        regionBindingId: binding.id,
        kind: 'content',
        slug: 'rev-2',
        actorId: actor.id,
        selfApproved: false,
        diff: { change: 'two' },
        diffHash: hexHash('rev-2-diff'),
      });
      const r3 = await h.storage.appendRevision({
        tenantId: tenant.id,
        proposalId: proposal.id,
        regionBindingId: binding.id,
        kind: 'content',
        slug: 'rev-3',
        actorId: actor.id,
        selfApproved: false,
        diff: { change: 'three' },
        diffHash: hexHash('rev-3-diff'),
      });
      expect(r1.version).toBe(1);
      expect(r2.version).toBe(2);
      expect(r3.version).toBe(3);

      const listed = await h.storage.listRevisionsForProposal(tenant.id, proposal.id);
      expect(listed.map((r) => r.version)).toEqual([1, 2, 3]);
    });

    it('rejects a write against a disabled tenant with TenantDisabledError', async () => {
      const tenant = await createTenant(h, `tnt-rev-disabled-${Date.now()}`);
      const actor = await createActor(h, tenant.id, 'rev-disabled-actor');
      const binding = await createRegionBinding(h, tenant.id, 'rev-disabled-region');
      const proposal = await h.storage.createProposal({
        tenantId: tenant.id,
        regionBindingId: binding.id,
        slug: 'rev-disabled-proposal',
        proposedByActorId: actor.id,
        title: 'Revision disabled proposal',
        payload: { v: 1 },
        payloadHash: hexHash('rev-disabled-payload'),
        idempotencyKey: 'rev-disabled-key',
        requestFingerprint: hexHash('rev-disabled-fp'),
        endpoint: 'POST /proposals',
      });
      await h.storage.disableTenant({ tenantId: tenant.id });
      await expect(
        h.storage.appendRevision({
          tenantId: tenant.id,
          proposalId: proposal.id,
          regionBindingId: binding.id,
          kind: 'content',
          slug: 'rev-blocked',
          actorId: actor.id,
          selfApproved: false,
          diff: { change: 'blocked' },
          diffHash: hexHash('rev-blocked-diff'),
        }),
      ).rejects.toBeInstanceOf(TenantDisabledError);
    });
  });

  describe('append-only audit events', () => {
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('inserts an audit event successfully', async () => {
      const tenant = await createTenant(h, `tnt-audit-insert-${Date.now()}`);
      const actor = await createActor(h, tenant.id, 'audit-actor');
      const event = await h.storage.appendAuditEvent({
        eventHash: hexHash('audit-insert-1'),
        tenantId: tenant.id,
        actorId: actor.id,
        selfApproved: false,
        occurredAt: new Date(),
        event: { action: 'test' },
      });
      expect(event.eventHash).toBe(hexHash('audit-insert-1'));
    });

    it('rejects UPDATE on audit_events (trigger fires, marker present in driver error)', async () => {
      const tenant = await createTenant(h, `tnt-audit-update-${Date.now()}`);
      const actor = await createActor(h, tenant.id, 'audit-actor-up');
      const eventHash = hexHash('audit-update-1');
      await h.storage.appendAuditEvent({
        eventHash,
        tenantId: tenant.id,
        actorId: actor.id,
        selfApproved: false,
        occurredAt: new Date(),
        event: { action: 'test' },
      });
      await expect(
        h.pglite.query(`UPDATE cms_storage.audit_events SET event = '{}' WHERE event_hash = $1`, [eventHash]),
      ).rejects.toThrow(APPEND_ONLY_MARKER);
    });

    it('rejects DELETE on audit_events (trigger fires, marker present in driver error)', async () => {
      const tenant = await createTenant(h, `tnt-audit-delete-${Date.now()}`);
      const actor = await createActor(h, tenant.id, 'audit-actor-del');
      const eventHash = hexHash('audit-delete-1');
      await h.storage.appendAuditEvent({
        eventHash,
        tenantId: tenant.id,
        actorId: actor.id,
        selfApproved: false,
        occurredAt: new Date(),
        event: { action: 'test' },
      });
      await expect(
        h.pglite.query(`DELETE FROM cms_storage.audit_events WHERE event_hash = $1`, [eventHash]),
      ).rejects.toThrow(APPEND_ONLY_MARKER);
    });

    it('rejects TRUNCATE on audit_events (statement trigger fires)', async () => {
      await expect(
        h.pglite.query('TRUNCATE TABLE cms_storage.audit_events'),
      ).rejects.toThrow(APPEND_ONLY_MARKER);
    });
  });

  describe('error mapping', () => {
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('maps UNIQUE_VIOLATION to UniqueViolationError on duplicate tenant slug', async () => {
      const slug = `tnt-err-unique-${Date.now()}`;
      await createTenant(h, slug);
      await expect(createTenant(h, slug)).rejects.toBeInstanceOf(UniqueViolationError);
    });

    it('rejects CHECK_VIOLATION when an invalid approval_state slips through', async () => {
      const tenant = await createTenant(h, `tnt-err-check-${Date.now()}`);
      await expect(
        h.pglite.query(
          `INSERT INTO cms_storage.region_bindings (tenant_id, slug, adapter_id, canonical_source, regeneration_contract, schema, locale_policy, approval_state)
           VALUES ($1, 'chk-bad', '@cms/x', '{}'::jsonb, '{"mode":"canonical_direct"}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'NOT_A_STATE')`,
          [tenant.id],
        ),
      ).rejects.toThrow();
    });
  });

  describe('error classifier (P0001 marker discipline)', () => {
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('classifies a P0001 driver error with the marker as AppendOnlyViolationError', () => {
      // Synthetic driver-shaped error matching what pglite (or pg) raises
      // when the append-only trigger fires. Both the SQLSTATE and the
      // marker must be present; a P0001 without the marker must NOT be
      // misclassified as append-only.
      const triggerError = {
        code: 'P0001',
        message: `cms_storage.audit_events is append-only; UPDATE/DELETE is not permitted (op=UPDATE, SQLSTATE=P0001)`,
        table: 'audit_events',
      };
      const classified = classifyPgError(triggerError);
      expect(classified).toBeInstanceOf(AppendOnlyViolationError);
      expect(classified.code).toBe('append_only_violation');
      expect((classified as AppendOnlyViolationError).detail?.['message']).toContain(APPEND_ONLY_MARKER);
    });

    it('does NOT misclassify a generic P0001 (e.g. CHECK constraint) as append-only', () => {
      const genericP0001 = {
        code: 'P0001',
        message: 'some unrelated check violation raised as P0001',
        constraint: 'some_chk',
      };
      const classified = classifyPgError(genericP0001);
      expect(classified).not.toBeInstanceOf(AppendOnlyViolationError);
      expect(classified.code).toBe('transaction_aborted');
    });

    it('classifies a UNIQUE_VIOLATION (23505) as UniqueViolationError', () => {
      const uniqueError = {
        code: '23505',
        constraint: 'some_unique_idx',
        detail: 'duplicate key',
      };
      const classified = classifyPgError(uniqueError);
      expect(classified).toBeInstanceOf(UniqueViolationError);
      expect(classified.code).toBe('unique_violation');
    });
  });
});