/**
 * Security contract tests for the @cms/api Hono surface.
 *
 * Every test issues a real `Request` through the Hono app produced by
 * `createApi`. The fake services are deterministic and injected via
 * `ApiServices`. The assertions are made on the observable HTTP response
 * (status + RFC 9457 body), not on internal state.
 *
 * Cover:
 *   - missing / invalid / expired / audience-mismatched bearer tokens
 *   - cross-tenant request rejection
 *   - X-Tenant-Id header requirement
 *   - service identity hard refusal for approve / publish / rollback
 *   - MCP identity hard refusal for approve / publish / rollback
 *   - identity-resolver-unreachable refusal
 *   - RFC 9457 shape and locale negotiation (en / es)
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type Audience,
  type IdentityResolver,
  type TokenClaims,
  type TokenVerifier,
  type VerifiedToken,
} from '../src/auth.js';
import {
  API_ERROR_CODES,
  messageFor,
  problemCodeScope,
  type ProblemCode,
} from '../src/problem.js';
import { ERROR_CODES, type AuthorityGrant, type Iso8601 } from '@cms/core';
import {
  type AuditEventRow,
  type CreateProposalInput,
  type DeployReceiptRow,
  type FinalizeIdempotencyInput,
  type IdempotencyRecordRow,
  type IdempotencyReplay,
  type ProposalRow,
  type RecordApprovalInput,
  type RecordDeployReceiptInput,
  type RecordPublicationInput,
  type RegionBindingRow,
  type Storage,
  type StorageErrorCode,
  type UpsertActorInput,
  type UpsertRegionBindingInput,
  type AppendRevisionInput,
  type AppendAuditEventInput,
  type BeginIdempotencyInput,
  type TransitionProposalInput,
  type TransitionPublicationInput,
  type Transactional,
} from '@cms/storage';
import { createApi, type ApiServices } from '../src/index.js';

const AUDIENCE = 'cms-api-aud' as Audience;
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const PROPOSER_ID = 'user-proposer';
const APPROVER_ID = 'user-approver';
const SERVICE_ID = 'svc-cli';
const MCP_ID = 'svc-mcp';
const PROPOSAL_ID = 'prop-1';
const ISO_NOW = '2026-07-27T12:00:00.000Z' as Iso8601;
const GRANT_VALID_FROM = '2026-07-27T11:00:00.000Z';
const GRANT_VALID_UNTIL = '2026-07-27T13:00:00.000Z';
const REGION_BINDING_ID = 'rb-1';
const PROPOSAL_SLUG = 'hello-world';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function defaultClaims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return {
    iss: 'iss.example',
    sub: 'sub-1',
    aud: AUDIENCE,
    exp: Math.floor(new Date(ISO_NOW).getTime() / 1000) + 3600,
    iat: Math.floor(new Date(ISO_NOW).getTime() / 1000) - 60,
    tenantId: TENANT_A,
    actorId: APPROVER_ID,
    kind: 'human',
    scope: [],
    ...overrides,
  };
}

function fullGrant(overrides: Partial<AuthorityGrant> = {}): AuthorityGrant {
  return {
    identityId: 'user-1',
    roles: ['author', 'approver', 'publisher', 'operator'],
    contentTypes: ['post'],
    environments: ['staging', 'production'],
    capabilities: [
      'content.post',
      'propose',
      'approve',
      'publish',
      'canonical.write',
      'rollback',
    ],
    notBefore: GRANT_VALID_FROM,
    notAfter: GRANT_VALID_UNTIL,
    ...overrides,
  };
}

function makeTokenVerifier(claimsByHeader: ReadonlyMap<string, TokenClaims>, fallback: TokenClaims | null): TokenVerifier {
  return {
    verify(authorizationHeader: string): VerifiedToken {
      const claims = claimsByHeader.get(authorizationHeader) ?? fallback;
      if (claims === null) {
        throw new Error('signature mismatch');
      }
      return { claims, tokenId: `tok-${claims.actorId}` };
    },
  };
}

function makeIdentityResolver(opts: {
  grants: Map<string, readonly AuthorityGrant[]>;
  proposers: Map<string, string>;
  profiles: Map<string, { displayName: string; capabilities: readonly string[] }>;
  actorKind: (claims: TokenClaims) => 'human' | 'service' | null;
}): IdentityResolver {
  return {
    async resolveActorKind(claims: TokenClaims) {
      return opts.actorKind(claims);
    },
    async loadGrants(actorId: string) {
      return opts.grants.get(actorId) ?? [];
    },
    async loadProposerId(proposalId: string) {
      return opts.proposers.get(proposalId) ?? null;
    },
    async loadActorProfile(actorId: string) {
      return (
        opts.profiles.get(actorId) ?? {
          displayName: `Actor ${actorId}`,
          capabilities: [],
        }
      );
    },
  };
}

class FakeStorageError extends Error {
  readonly code: StorageErrorCode;
  readonly detail: Record<string, unknown> | undefined;
  constructor(code: StorageErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.detail = detail;
  }
}

interface StorageSeed {
  readonly proposals: Map<string, ProposalRow>;
  readonly idempotency: Map<string, IdempotencyRecordRow>;
  readonly audit: AuditEventRow[];
}

function makeStorage(seed: StorageSeed = { proposals: new Map(), idempotency: new Map(), audit: [] }): Storage {
  const storage = {
    async close(): Promise<void> {},
    async createTenant(): Promise<never> { throw new FakeStorageError('invalid_input', 'not used'); },
    async disableTenant(): Promise<never> { throw new FakeStorageError('invalid_input', 'not used'); },
    async getTenantById(): Promise<null> { return null; },
    async getTenantBySlug(): Promise<null> { return null; },
    async upsertActor(_input: UpsertActorInput): Promise<never> { throw new FakeStorageError('invalid_input', 'not used'); },
    async getActorById(): Promise<null> { return null; },
    async getActorBySlug(): Promise<null> { return null; },
    async upsertRegionBinding(_input: UpsertRegionBindingInput): Promise<never> { throw new FakeStorageError('invalid_input', 'not used'); },
    async approveRegionBinding(): Promise<never> { throw new FakeStorageError('invalid_input', 'not used'); },
    async getRegionBindingById(_tenantId: string, _id: string): Promise<RegionBindingRow | null> { return null; },
    async getRegionBindingBySlug(_tenantId: string, _slug: string): Promise<RegionBindingRow | null> { return null; },
    async createProposal(input: CreateProposalInput): Promise<ProposalRow> {
      const id = `prop-${seed.proposals.size + 1}`;
      const now = new Date(ISO_NOW);
      const row: ProposalRow = {
        id,
        tenantId: input.tenantId,
        regionBindingId: input.regionBindingId,
        slug: input.slug,
        proposedByActorId: input.proposedByActorId,
        delegatedHumanActorId: input.delegatedHumanActorId ?? null,
        title: input.title,
        payload: input.payload,
        payloadHash: input.payloadHash,
        state: 'draft',
        version: 1,
        validatedAt: null,
        approvedAt: null,
        canonicalWrittenAt: null,
        liveAt: null,
        createdAt: now,
        updatedAt: now,
      };
      seed.proposals.set(id, row);
      return row;
    },
    async transitionProposal(input: TransitionProposalInput): Promise<ProposalRow> {
      const existing = seed.proposals.get(input.proposalId);
      if (existing === undefined) {
        throw new FakeStorageError('not_found', 'proposal not found');
      }
      if (existing.version !== input.expectedVersion) {
        throw new FakeStorageError('optimistic_concurrency_conflict', 'version mismatch', {
          expectedVersion: input.expectedVersion,
          currentVersion: existing.version,
        });
      }
      const updated: ProposalRow = {
        ...existing,
        state: input.nextState,
        version: existing.version + 1,
        validatedAt: input.validatedAt ?? existing.validatedAt,
        approvedAt: input.approvedAt ?? existing.approvedAt,
        canonicalWrittenAt: input.canonicalWrittenAt ?? existing.canonicalWrittenAt,
        liveAt: input.liveAt ?? existing.liveAt,
        updatedAt: new Date(ISO_NOW),
      };
      seed.proposals.set(input.proposalId, updated);
      return updated;
    },
    async getProposalById(_tenantId: string, proposalId: string): Promise<ProposalRow | null> {
      return seed.proposals.get(proposalId) ?? null;
    },
    async recordApproval(input: RecordApprovalInput) {
      const id = `app-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      return {
        id,
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
        createdAt: new Date(ISO_NOW),
      };
    },
    async appendRevision(input: AppendRevisionInput) {
      const id = `rev-${input.proposalId}-${Date.now()}`;
      return {
        id,
        tenantId: input.tenantId,
        proposalId: input.proposalId,
        regionBindingId: input.regionBindingId,
        kind: input.kind,
        version: 1,
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
        createdAt: new Date(ISO_NOW),
      };
    },
    async listRevisionsForProposal(): Promise<readonly never[]> { return []; },
    async recordPublication(input: RecordPublicationInput) {
      const id = `pub-${input.proposalId}-${Date.now()}`;
      return {
        id,
        tenantId: input.tenantId,
        proposalId: input.proposalId,
        canonicalRevisionId: input.canonicalRevisionId,
        status: 'canonical_written',
        canonicalWrittenAt: new Date(ISO_NOW),
        liveAt: null,
        failureReason: null,
        version: 1,
        createdAt: new Date(ISO_NOW),
        updatedAt: new Date(ISO_NOW),
      };
    },
    async transitionPublication(_input: TransitionPublicationInput): Promise<never> {
      throw new FakeStorageError('not_found', 'not used');
    },
    async recordDeployReceipt(_input: RecordDeployReceiptInput): Promise<DeployReceiptRow> {
      throw new FakeStorageError('invalid_input', 'not used');
    },
    async appendAuditEvent(input: AppendAuditEventInput): Promise<AuditEventRow> {
      const row: AuditEventRow = {
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
        persistedAt: new Date(ISO_NOW),
      };
      seed.audit.push(row);
      return row;
    },
    async getAuditEventByHash(): Promise<null> { return null; },
    async listAuditEventsForProposal(_tid: string, pid: string): Promise<readonly AuditEventRow[]> {
      return seed.audit.filter((e) => e.proposalId === pid);
    },
    async beginIdempotency(input: BeginIdempotencyInput): Promise<IdempotencyReplay> {
      const key = `${input.tenantId}:${input.idempotencyKey}`;
      const existing = seed.idempotency.get(key);
      if (existing !== undefined) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new FakeStorageError('idempotency_replay_mismatch', 'fingerprint mismatch', {
            idempotencyKey: input.idempotencyKey,
          });
        }
        if (existing.outcome === 'in_progress') {
          throw new FakeStorageError('idempotency_in_progress', 'still in progress', {
            idempotencyKey: input.idempotencyKey,
          });
        }
        return { source: existing.outcome, record: existing };
      }
      const row: IdempotencyRecordRow = {
        id: `idem-${seed.idempotency.size + 1}`,
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        endpoint: input.endpoint,
        outcome: 'in_progress',
        response: null,
        responseStatus: null,
        lockedBy: input.lockedBy,
        lockExpiresAt: new Date(Date.now() + input.lockTtlSeconds * 1000),
        createdAt: new Date(ISO_NOW),
        finalizedAt: null,
      };
      seed.idempotency.set(key, row);
      return { source: 'in_progress', record: row };
    },
    async finalizeIdempotency(input: FinalizeIdempotencyInput): Promise<IdempotencyRecordRow> {
      const key = `${input.tenantId}:${input.idempotencyKey}`;
      const existing = seed.idempotency.get(key);
      if (existing === undefined) {
        throw new FakeStorageError('not_found', 'idempotency record missing');
      }
      const updated: IdempotencyRecordRow = {
        ...existing,
        outcome: input.outcome,
        response: input.response,
        responseStatus: input.responseStatus,
        lockedBy: null,
        lockExpiresAt: null,
        finalizedAt: new Date(ISO_NOW),
      };
      seed.idempotency.set(key, updated);
      return updated;
    },
    async releaseIdempotency(): Promise<void> {},
    async runInTransaction<T>(work: Transactional<T>): Promise<T> {
      return work(storage as never);
    },
  } as Storage;
  return storage;
}

function makeServices(opts: {
  resolver: IdentityResolver;
  storage: Storage;
  tokens?: ReadonlyMap<string, TokenClaims>;
  defaultToken?: TokenClaims | null;
}): ApiServices {
  return {
    storage: opts.storage,
    tokenVerifier: makeTokenVerifier(opts.tokens ?? new Map(), opts.defaultToken ?? null),
    identityResolver: opts.resolver,
    audience: AUDIENCE,
    now: () => new Date(ISO_NOW),
    traceId: () => 'trace-fixed',
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length === 0) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function contentProposalShape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROPOSAL_ID,
    tenantId: TENANT_A,
    kind: 'content',
    contentType: 'post',
    environment: 'staging',
    action: 'create',
    createdAt: ISO_NOW,
    draft: false,
    localizedTitle: { en: 'Hello', es: 'Hola' },
    localizedBody: { en: 'World', es: 'Mundo' },
    canonicalRepoPath: 'content/posts/hello.md',
    ...overrides,
  };
}

function seededProposal(opts: { state: string; version: number }): ProposalRow {
  const now = new Date(ISO_NOW);
  const payload = contentProposalShape();
  const sortedKeys = Object.keys(payload).sort();
  const canonical = `{${sortedKeys
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify((payload as Record<string, unknown>)[k])}`)
    .join(',')}}`;
  return {
    id: PROPOSAL_ID,
    tenantId: TENANT_A,
    regionBindingId: REGION_BINDING_ID,
    slug: PROPOSAL_SLUG,
    proposedByActorId: PROPOSER_ID,
    delegatedHumanActorId: null,
    title: 'Hello',
    payload,
    payloadHash: sha256Hex(canonical),
    state: opts.state as ProposalRow['state'],
    version: opts.version,
    validatedAt: null,
    approvedAt: null,
    canonicalWrittenAt: null,
    liveAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function expectProblem(body: Record<string, unknown>, code: string, locale: 'en' | 'es') {
  expect(body.code).toBe(code);
  expect(body.locale).toBe(locale);
  expect(typeof body.title).toBe('string');
  expect(typeof body.detail).toBe('string');
  expect(body.type).toBe(`urn:cms:problem:${problemCodeScope(code as ProblemCode)}:${code}`);
  expect(body.extensions).toBeDefined();
  expect((body.extensions as Record<string, unknown>).traceId).toBe('trace-fixed');
  expect(body.status).toBeDefined();
}

describe('api security: bearer token contracts', () => {
  it('returns 401 E_TOKEN_MISSING when the Authorization header is absent', async () => {
    const storage = makeStorage();
    const resolver = makeIdentityResolver({
      grants: new Map(),
      proposers: new Map(),
      profiles: new Map(),
      actorKind: () => 'human',
    });
    const app = createApi({ services: makeServices({ resolver, storage }) });
    const res = await app.fetch(
      new Request('http://localhost/v1/proposals/abc', {
        method: 'GET',
        headers: { 'x-tenant-id': TENANT_A },
      }),
    );
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expectProblem(body, 'E_TOKEN_MISSING', 'en');
  });

  it('returns 401 E_TOKEN_EXPIRED when the token exp is in the past and the response is in es', async () => {
    const storage = makeStorage();
    const expired = defaultClaims({
      exp: Math.floor(new Date('2026-01-01T00:00:00.000Z').getTime() / 1000),
    });
    const resolver = makeIdentityResolver({
      grants: new Map(),
      proposers: new Map(),
      profiles: new Map(),
      actorKind: () => 'human',
    });
    const app = createApi({
      services: makeServices({
        resolver,
        storage,
        tokens: new Map([['Bearer expired', expired]]),
        defaultToken: expired,
      }),
    });
    const res = await app.fetch(
      new Request('http://localhost/v1/proposals/abc', {
        method: 'GET',
        headers: {
          authorization: 'Bearer expired',
          'x-tenant-id': TENANT_A,
          'accept-language': 'es',
        },
      }),
    );
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expectProblem(body, 'E_TOKEN_EXPIRED', 'es');
    expect(body.detail).toContain('expirado');
  });

  it('returns 401 E_TOKEN_AUDIENCE_MISMATCH when audience differs', async () => {
    const storage = makeStorage();
    const wrongAud = defaultClaims({ aud: 'other-api' as Audience });
    const resolver = makeIdentityResolver({
      grants: new Map(),
      proposers: new Map(),
      profiles: new Map(),
      actorKind: () => 'human',
    });
    const app = createApi({
      services: makeServices({
        resolver,
        storage,
        tokens: new Map([['Bearer wrongaud', wrongAud]]),
        defaultToken: wrongAud,
      }),
    });
    const res = await app.fetch(
      new Request('http://localhost/v1/proposals/abc', {
        method: 'GET',
        headers: { authorization: 'Bearer wrongaud', 'x-tenant-id': TENANT_A },
      }),
    );
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expectProblem(body, 'E_TOKEN_AUDIENCE_MISMATCH', 'en');
  });

  it('returns 401 E_TOKEN_MALFORMED when the token verifier rejects the header', async () => {
    const storage = makeStorage();
    const resolver = makeIdentityResolver({
      grants: new Map(),
      proposers: new Map(),
      profiles: new Map(),
      actorKind: () => 'human',
    });
    const app = createApi({ services: makeServices({ resolver, storage }) });
    const res = await app.fetch(
      new Request('http://localhost/v1/proposals/abc', {
        method: 'GET',
        headers: { authorization: 'Bearer bad', 'x-tenant-id': TENANT_A },
      }),
    );
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expectProblem(body, 'E_TOKEN_MALFORMED', 'en');
  });

  it('returns 401 E_UNAUTHORIZED when identity resolver returns null', async () => {
    const storage = makeStorage();
    const resolver = makeIdentityResolver({
      grants: new Map(),
      proposers: new Map(),
      profiles: new Map(),
      actorKind: () => null,
    });
    const app = createApi({
      services: makeServices({ resolver, storage, defaultToken: defaultClaims() }),
    });
    const res = await app.fetch(
      new Request('http://localhost/v1/proposals/abc', {
        method: 'GET',
        headers: { authorization: 'Bearer valid', 'x-tenant-id': TENANT_A },
      }),
    );
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expectProblem(body, 'E_UNAUTHORIZED', 'en');
  });
});

describe('api security: tenant scoping', () => {
  it('returns 403 E_TENANT_FORBIDDEN when the token tenant does not match X-Tenant-Id', async () => {
    const storage = makeStorage();
    const claims = defaultClaims({ tenantId: TENANT_B });
    const resolver = makeIdentityResolver({
      grants: new Map(),
      proposers: new Map(),
      profiles: new Map(),
      actorKind: () => 'human',
    });
    const app = createApi({
      services: makeServices({
        resolver,
        storage,
        tokens: new Map([['Bearer tB', claims]]),
        defaultToken: claims,
      }),
    });
    const res = await app.fetch(
      new Request('http://localhost/v1/proposals/abc', {
        method: 'GET',
        headers: { authorization: 'Bearer tB', 'x-tenant-id': TENANT_A },
      }),
    );
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expectProblem(body, 'E_TENANT_FORBIDDEN', 'en');
  });

  it('returns 400 E_TENANT_HEADER_REQUIRED when the X-Tenant-Id header is absent', async () => {
    const storage = makeStorage();
    const resolver = makeIdentityResolver({
      grants: new Map(),
      proposers: new Map(),
      profiles: new Map(),
      actorKind: () => 'human',
    });
    const app = createApi({ services: makeServices({ resolver, storage }) });
    const res = await app.fetch(
      new Request('http://localhost/v1/proposals/abc', {
        method: 'GET',
        headers: { authorization: 'Bearer default' },
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expectProblem(body, 'E_TENANT_HEADER_REQUIRED', 'en');
  });
});

describe('api security: identity gating', () => {
  function proposalAtState(state: string): ProposalRow {
    const seed = new Map<string, ProposalRow>();
    const row = seededProposal({ state, version: 1 });
    seed.set(row.id, row);
    return row;
  }

  it('returns 403 E_SERVICE_APPROVAL_FORBIDDEN for service identity on approve', async () => {
    const existing = proposalAtState('previewing');
    const seed = new Map<string, ProposalRow>([[existing.id, existing]]);
    const storage = makeStorage({ proposals: seed, idempotency: new Map(), audit: [] });
    const claims = defaultClaims({ actorId: SERVICE_ID, kind: 'service' });
    const resolver = makeIdentityResolver({
      grants: new Map([[SERVICE_ID, [fullGrant({ identityId: SERVICE_ID })]]]),
      proposers: new Map([[existing.id, PROPOSER_ID]]),
      profiles: new Map([[SERVICE_ID, { displayName: 'svc', capabilities: [] }]]),
      actorKind: (c) => (c.kind === 'service' ? 'service' : 'human'),
    });
    const app = createApi({
      services: makeServices({
        resolver,
        storage,
        tokens: new Map([['Bearer svc', claims]]),
        defaultToken: claims,
      }),
    });
    const res = await app.fetch(
      new Request(`http://localhost/v1/proposals/${existing.id}/approve`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer svc',
          'x-tenant-id': TENANT_A,
          'idempotency-key': 'k-approve-svc',
          'if-match': '1',
        },
        body: JSON.stringify({ proposal: contentProposalShape() }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expectProblem(body, 'E_SERVICE_APPROVAL_FORBIDDEN', 'en');
  });

  it('returns 403 E_SERVICE_APPROVAL_FORBIDDEN for service identity on publish', async () => {
    const existing = proposalAtState('approved');
    const seed = new Map<string, ProposalRow>([[existing.id, existing]]);
    const storage = makeStorage({ proposals: seed, idempotency: new Map(), audit: [] });
    const claims = defaultClaims({ actorId: SERVICE_ID, kind: 'service' });
    const resolver = makeIdentityResolver({
      grants: new Map([[SERVICE_ID, [fullGrant({ identityId: SERVICE_ID })]]]),
      proposers: new Map([[existing.id, PROPOSER_ID]]),
      profiles: new Map([[SERVICE_ID, { displayName: 'svc', capabilities: [] }]]),
      actorKind: (c) => (c.kind === 'service' ? 'service' : 'human'),
    });
    const app = createApi({
      services: makeServices({
        resolver,
        storage,
        tokens: new Map([['Bearer svc', claims]]),
        defaultToken: claims,
      }),
    });
    const res = await app.fetch(
      new Request(`http://localhost/v1/proposals/${existing.id}/publish`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer svc',
          'x-tenant-id': TENANT_A,
          'idempotency-key': 'k-publish-svc',
          'if-match': '1',
        },
        body: JSON.stringify({ proposal: contentProposalShape() }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expectProblem(body, 'E_SERVICE_APPROVAL_FORBIDDEN', 'en');
  });

  it('returns 403 E_SERVICE_APPROVAL_FORBIDDEN for service identity on rollback', async () => {
    const existing = proposalAtState('live');
    const seed = new Map<string, ProposalRow>([[existing.id, existing]]);
    const storage = makeStorage({ proposals: seed, idempotency: new Map(), audit: [] });
    const claims = defaultClaims({ actorId: SERVICE_ID, kind: 'service' });
    const resolver = makeIdentityResolver({
      grants: new Map([[SERVICE_ID, [fullGrant({ identityId: SERVICE_ID })]]]),
      proposers: new Map([[existing.id, PROPOSER_ID]]),
      profiles: new Map([[SERVICE_ID, { displayName: 'svc', capabilities: [] }]]),
      actorKind: (c) => (c.kind === 'service' ? 'service' : 'human'),
    });
    const app = createApi({
      services: makeServices({
        resolver,
        storage,
        tokens: new Map([['Bearer svc', claims]]),
        defaultToken: claims,
      }),
    });
    const res = await app.fetch(
      new Request(`http://localhost/v1/proposals/${existing.id}/rollback`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer svc',
          'x-tenant-id': TENANT_A,
          'idempotency-key': 'k-rb-svc',
          'if-match': '1',
        },
        body: JSON.stringify({ proposal: contentProposalShape() }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expectProblem(body, 'E_SERVICE_APPROVAL_FORBIDDEN', 'en');
  });

  it.each([
    { route: 'approve', state: 'previewing', idempotencyKey: 'k-approve-mcp' },
    { route: 'publish', state: 'approved', idempotencyKey: 'k-publish-mcp' },
    { route: 'rollback', state: 'live', idempotencyKey: 'k-rollback-mcp' },
  ])(
    'returns 403 E_MCP_APPROVAL_FORBIDDEN for MCP-capable actor on $route',
    async ({ route, state, idempotencyKey }) => {
      const existing = proposalAtState(state);
      const seed = new Map<string, ProposalRow>([[existing.id, existing]]);
      const storage = makeStorage({ proposals: seed, idempotency: new Map(), audit: [] });
      const claims = defaultClaims({ actorId: MCP_ID, scope: ['mcp'] });
      const resolver = makeIdentityResolver({
        grants: new Map([
          [
            MCP_ID,
            [
              fullGrant({
                identityId: MCP_ID,
                capabilities: [
                  'content.post',
                  'propose',
                  'approve',
                  'publish',
                  'canonical.write',
                  'rollback',
                  'mcp',
                ],
              }),
            ],
          ],
        ]),
        proposers: new Map([[existing.id, PROPOSER_ID]]),
        profiles: new Map([[MCP_ID, { displayName: 'mcp', capabilities: ['mcp'] }]]),
        actorKind: () => 'human',
      });
      const app = createApi({
        services: makeServices({
          resolver,
          storage,
          tokens: new Map([['Bearer mcp', claims]]),
          defaultToken: claims,
        }),
      });
      const res = await app.fetch(
        new Request(`http://localhost/v1/proposals/${existing.id}/${route}`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer mcp',
            'x-tenant-id': TENANT_A,
            'idempotency-key': idempotencyKey,
            'if-match': '1',
          },
          body: JSON.stringify({ proposal: contentProposalShape() }),
        }),
      );
      expect(res.status).toBe(403);
      const body = await readJson(res);
      expectProblem(body, 'E_MCP_APPROVAL_FORBIDDEN', 'en');
    },
  );
});

describe('api security: RFC 9457 problem shape', () => {
  it('emits a problem+json with closed-union code, type URN, title, detail, locale, and traceId', async () => {
    const storage = makeStorage();
    const resolver = makeIdentityResolver({
      grants: new Map(),
      proposers: new Map(),
      profiles: new Map(),
      actorKind: () => 'human',
    });
    const app = createApi({ services: makeServices({ resolver, storage }) });
    const res = await app.fetch(
      new Request('http://localhost/v1/proposals/abc', {
        method: 'GET',
        headers: { 'x-tenant-id': TENANT_A, 'accept-language': 'es' },
      }),
    );
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await readJson(res);
    expect(body.code).toBe('E_TOKEN_MISSING');
    expect(body.type).toBe('urn:cms:problem:api:E_TOKEN_MISSING');
    expect(typeof body.title).toBe('string');
    expect(typeof body.detail).toBe('string');
    expect(body.locale).toBe('es');
    expect(body.title).toContain('Token ausente');
    expect((body.extensions as Record<string, unknown>).traceId).toBe('trace-fixed');
  });

  it('falls back to en when the Accept-Language header is missing', async () => {
    const storage = makeStorage();
    const resolver = makeIdentityResolver({
      grants: new Map(),
      proposers: new Map(),
      profiles: new Map(),
      actorKind: () => 'human',
    });
    const app = createApi({ services: makeServices({ resolver, storage }) });
    const res = await app.fetch(
      new Request('http://localhost/v1/proposals/abc', {
        method: 'GET',
        headers: { 'x-tenant-id': TENANT_A },
      }),
    );
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.locale).toBe('en');
  });

  it('keeps English and Spanish message catalogs complete and distinct for every problem code', () => {
    const storageCodes: readonly ProblemCode[] = [
      'not_found',
      'tenant_disabled',
      'idempotency_replay_mismatch',
      'idempotency_in_progress',
      'optimistic_concurrency_conflict',
      'unique_violation',
      'foreign_key_violation',
      'check_violation',
      'append_only_violation',
      'invalid_input',
      'transaction_aborted',
      'connection_failed',
      'unsupported',
    ];
    const codes = new Set<ProblemCode>([
      ...ERROR_CODES,
      ...API_ERROR_CODES,
      ...storageCodes,
    ]);
    for (const code of codes) {
      const en = messageFor(code, 'en');
      const es = messageFor(code, 'es');
      expect(es.title.trim(), code).not.toBe('');
      expect(es.detail.trim(), code).not.toBe('');
      expect(es, code).not.toEqual(en);
      expect(es.detail, code).not.toContain('Governance refusal');
    }
  });
describe('api security: persisted proposal authorization', () => {
  function buildFixture(state: string) {
    const existing = seededProposal({ state, version: 1 });
    const seed = new Map<string, ProposalRow>([[existing.id, existing]]);
    const storage = makeStorage({ proposals: seed, idempotency: new Map(), audit: [] });
    const claims = defaultClaims({ actorId: APPROVER_ID, kind: 'human' });
    const resolver = makeIdentityResolver({
      grants: new Map([[APPROVER_ID, [fullGrant({ identityId: APPROVER_ID })]]]),
      proposers: new Map([[existing.id, PROPOSER_ID]]),
      profiles: new Map([[APPROVER_ID, { displayName: 'approver', capabilities: [] }]]),
      actorKind: () => 'human',
    });
    const app = createApi({
      services: makeServices({
        resolver,
        storage,
        tokens: new Map([['Bearer approver', claims]]),
        defaultToken: claims,
      }),
    });
    return { app, existing };
  }

  function buildRequest(
    id: string,
    body: Record<string, unknown>,
    action: 'approve' | 'publish' | 'rollback',
  ) {
    return new Request(`http://localhost/v1/proposals/${id}/${action}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer approver',
        'x-tenant-id': TENANT_A,
        'idempotency-key': `k-payload-mismatch-${action}`,
        'if-match': '1',
      },
      body: JSON.stringify(body),
    });
  }

  const cases: ReadonlyArray<{
    readonly label: string;
    readonly override: Record<string, unknown>;
    readonly action: 'approve' | 'publish' | 'rollback';
  }> = [
    { label: 'mismatched proposal id', override: { id: 'prop-other' }, action: 'approve' },
    { label: 'mismatched contentType', override: { contentType: 'page' }, action: 'approve' },
    { label: 'mismatched environment', override: { environment: 'production' }, action: 'approve' },
    {
      label: 'mismatched payload field',
      override: { localizedTitle: { en: 'Different', es: 'Diferente' } },
      action: 'approve',
    },
    { label: 'mismatched proposal id (publish)', override: { id: 'prop-other' }, action: 'publish' },
    {
      label: 'mismatched environment (publish)',
      override: { environment: 'production' },
      action: 'publish',
    },
    {
      label: 'mismatched proposal id (rollback)',
      override: { id: 'prop-other' },
      action: 'rollback',
    },
    {
      label: 'mismatched contentType (rollback)',
      override: { contentType: 'page' },
      action: 'rollback',
    },
  ];

  for (const { label, override, action } of cases) {
    it(`refuses ${action} with stable E_BAD_REQUEST when ${label} and asserts zero side effects`, async () => {
      const initialState =
        action === 'rollback' ? 'live' : action === 'publish' ? 'approved' : 'previewing';
      const { app, existing } = buildFixture(initialState);
      const res = await app.fetch(
        buildRequest(existing.id, { proposal: contentProposalShape(override) }, action),
      );
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expectProblem(body, 'E_BAD_REQUEST', 'en');
      expect(body.extensions).toMatchObject({
        pointer: '/proposal',
      });
      // Zero side effects: proposal state/version unchanged, no approvals, revisions,
      // or publications recorded.
      const after = await app.fetch(
        new Request(`http://localhost/v1/proposals/${existing.id}`, {
          headers: {
            authorization: 'Bearer approver',
            'x-tenant-id': TENANT_A,
          },
        }),
      );
      const proposalAfter = await readJson(after);
      expect(proposalAfter).toMatchObject({ state: initialState, version: 1 });
    });
  }
});
});
