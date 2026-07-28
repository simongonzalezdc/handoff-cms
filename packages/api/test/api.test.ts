import { describe, expect, it } from 'vitest';
import type { AuthorityGrant } from '@cms/core';
import {
  IdempotencyReplayMismatchError,
  IdempotencyInProgressError,
  OptimisticConcurrencyError,
  type AppendAuditEventInput,
  type BeginIdempotencyInput,
  type FinalizeIdempotencyInput,
  type IdempotencyRecordRow,
  type ProposalRow,
  type Storage,
  type TransitionProposalInput,
} from '@cms/storage';
import {
  createApi,
  type ApiServices,
  type Audience,
  type IdentityResolver,
  type TokenClaims,
} from '../src/index.js';

import { createHash } from 'node:crypto';

const fixedNow = new Date('2026-07-27T12:00:00.000Z');
const audience = 'https://cms.example.test' as Audience;

// Mirror of payloadHashOf in src/index.ts. Used so seeded proposal rows carry
// a payloadHash that the persisted-proposal authorization helper will accept
// when tests re-send the same proposal shape in the request body.
function payloadHashOf(payload: Record<string, unknown>): string {
  const sorted = Object.keys(payload).sort();
  const canonical = `{${sorted
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify((payload as Record<string, unknown>)[k])}`)
    .join(',')}}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}


function proposalShape(id = 'proposal-wire-1') {
  return {
    id,
    tenantId: 'tenant-1',
    contentType: 'post',
    environment: 'staging',
    action: 'update',
    createdAt: fixedNow.toISOString(),
    draft: false,
    kind: 'content',
    revisionId: 'revision-1',
    localizedTitle: { en: 'Title', es: 'Título' },
    localizedBody: { en: 'Body', es: 'Cuerpo' },
    canonicalRepoPath: 'content/post.json',
  };
}

function tokenClaims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  const seconds = Math.floor(fixedNow.getTime() / 1000);
  return {
    iss: 'https://issuer.example.test',
    sub: 'human-1',
    aud: audience,
    exp: seconds + 300,
    iat: seconds - 30,
    tenantId: 'tenant-1',
    actorId: 'human-1',
    kind: 'human',
    scope: [],
    ...overrides,
  };
}

function grant(identityId: string, capabilities: readonly string[]): AuthorityGrant {
  return {
    identityId,
    roles: ['author', 'approver', 'publisher', 'operator'],
    contentTypes: ['post'],
    environments: ['staging'],
    capabilities,
    notBefore: '2026-07-27T11:00:00.000Z',
    notAfter: '2026-07-27T13:00:00.000Z',
  };
}

interface FakeState {
  proposal: ProposalRow | null;
  proposerId: string | null;
  createCalls: number;
  auditEvents: AppendAuditEventInput[];
  approvals: Array<Record<string, unknown>>;
  deployStatuses: string[];
  inProgressIdempotencyKeys: Set<string>;
  failNextTransition: boolean;
  revisions: Array<Record<string, unknown>>;
  publications: Array<Record<string, unknown>>;
}

function fakeStorage(state: FakeState): Storage {
  const idempotency = new Map<string, IdempotencyRecordRow>();
  let publicationVersion = 1;
  const storage = {
    async beginIdempotency(input: BeginIdempotencyInput) {
      const scopedKey = `${input.tenantId}:${input.idempotencyKey}`;
      if (state.inProgressIdempotencyKeys.has(scopedKey)) {
        throw new IdempotencyInProgressError({ idempotencyKey: input.idempotencyKey });
      }
      const prior = idempotency.get(scopedKey);
      if (prior) {
        if (prior.requestFingerprint !== input.requestFingerprint || prior.endpoint !== input.endpoint) {
          throw new IdempotencyReplayMismatchError({ idempotencyKey: input.idempotencyKey });
        }
        if (prior.outcome === 'in_progress') {
          throw new IdempotencyInProgressError({ idempotencyKey: input.idempotencyKey });
        }
        return { source: prior.outcome, record: prior };
      }
      const record: IdempotencyRecordRow = {
        id: `idem-${input.idempotencyKey}`,
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        endpoint: input.endpoint,
        outcome: 'in_progress',
        response: null,
        responseStatus: null,
        lockedBy: input.lockedBy,
        lockExpiresAt: new Date(fixedNow.getTime() + input.lockTtlSeconds * 1000),
        createdAt: fixedNow,
        finalizedAt: null,
      };
      idempotency.set(scopedKey, record);
      return { source: 'in_progress' as const, record };
    },
    async finalizeIdempotency(input: FinalizeIdempotencyInput) {
      const scopedKey = `${input.tenantId}:${input.idempotencyKey}`;
      const prior = idempotency.get(scopedKey)!;
      const record: IdempotencyRecordRow = {
        ...prior,
        outcome: input.outcome,
        response: input.response,
        responseStatus: input.responseStatus,
        lockedBy: null,
        lockExpiresAt: null,
        finalizedAt: fixedNow,
      };
      idempotency.set(scopedKey, record);
      return record;
    },
    async createProposal(input: Record<string, unknown>) {
      state.createCalls += 1;
      state.proposerId = String(input.proposedByActorId);
      state.proposal = {
        id: 'proposal-1',
        tenantId: String(input.tenantId),
        regionBindingId: String(input.regionBindingId),
        slug: String(input.slug),
        proposedByActorId: String(input.proposedByActorId),
        delegatedHumanActorId: null,
        title: String(input.title),
        payload: input.payload as Record<string, unknown>,
        payloadHash: String(input.payloadHash),
        state: 'draft',
        version: 1,
        validatedAt: null,
        approvedAt: null,
        canonicalWrittenAt: null,
        liveAt: null,
        createdAt: fixedNow,
        updatedAt: fixedNow,
      };
      return state.proposal;
    },
    async transitionProposal(input: TransitionProposalInput) {
      if (!state.proposal) throw new Error('proposal missing');
      if (state.failNextTransition) {
        state.failNextTransition = false;
        throw new OptimisticConcurrencyError('proposal', input.expectedVersion);
      }
      if (state.proposal.version !== input.expectedVersion) throw new Error('unexpected test version');
      state.proposal = {
        ...state.proposal,
        state: input.nextState,
        version: state.proposal.version + 1,
        approvedAt: input.approvedAt ?? state.proposal.approvedAt,
        canonicalWrittenAt: input.canonicalWrittenAt ?? state.proposal.canonicalWrittenAt,
        liveAt: input.liveAt ?? state.proposal.liveAt,
        updatedAt: fixedNow,
      };
      return state.proposal;
    },
    async getProposalById(tenantId: string, proposalId: string) {
      return state.proposal?.tenantId === tenantId && state.proposal.id === proposalId
        ? state.proposal
        : null;
    },
    async recordApproval(input: Record<string, unknown>) {
      state.approvals.push(input);
      return {
        id: 'approval-1',
        tenantId: String(input.tenantId),
        proposalId: String(input.proposalId),
        approverActorId: String(input.approverActorId),
        delegatedHumanActorId: (input.delegatedHumanActorId as string | undefined) ?? null,
        selfApproved: Boolean(input.selfApproved),
        role: String(input.role),
        contentType: String(input.contentType),
        environment: String(input.environment),
        note: (input.note as string | undefined) ?? null,
        targetState: 'approved' as const,
        rollbackTargetProposalId: null,
        createdAt: fixedNow,
      };
    },
    async appendRevision(input: Record<string, unknown>) {
      const row = {
        id: 'revision-1',
        ...input,
        version: 1,
        parentRevisionId: null,
        beforeRef: null,
        afterRef: null,
        beforeHash: null,
        afterHash: null,
        approverActorId: null,
        rollbackTargetRevisionId: null,
        createdAt: fixedNow,
      };
      state.revisions.push(row);
      return row;
    },
    async recordPublication(input: Record<string, unknown>) {
      state.publications.push(input);
      return {
        id: 'publication-1',
        tenantId: String(input.tenantId),
        proposalId: String(input.proposalId),
        canonicalRevisionId: String(input.canonicalRevisionId),
        status: 'canonical_written' as const,
        canonicalWrittenAt: fixedNow,
        liveAt: null,
        failureReason: null,
        version: 1,
        createdAt: fixedNow,
        updatedAt: fixedNow,
      };
    },
    async recordDeployReceipt(input: Record<string, unknown>) {
      state.deployStatuses.push(String(input.status));
      return {
        id: `deploy-${state.deployStatuses.length}`,
        tenantId: String(input.tenantId),
        publicationId: String(input.publicationId),
        adapterId: String(input.adapterId),
        externalDeployId: String(input.externalDeployId),
        status: String(input.status) as 'pending' | 'succeeded' | 'failed' | 'rolled_back',
        payload: (input.payload as Record<string, unknown> | undefined) ?? {},
        liveUrl: (input.liveUrl as string | undefined) ?? null,
        receivedAt: fixedNow,
        completedAt: (input.completedAt as Date | undefined) ?? null,
      };
    },
    async transitionPublication(input: Record<string, unknown>) {
      if (Number(input.expectedVersion) !== publicationVersion) {
        throw new Error('unexpected publication version');
      }
      publicationVersion += 1;
      return {
        id: String(input.publicationId),
        tenantId: String(input.tenantId),
        proposalId: 'proposal-1',
        canonicalRevisionId: 'revision-1',
        status: String(input.nextStatus),
        canonicalWrittenAt: fixedNow,
        liveAt: (input.liveAt as Date | undefined) ?? null,
        failureReason: (input.failureReason as string | undefined) ?? null,
        version: publicationVersion,
        createdAt: fixedNow,
        updatedAt: fixedNow,
      };
    },
    async runInTransaction<T>(work: (transaction: Storage) => Promise<T>) {
      const snapshot = {
        proposal: state.proposal,
        proposerId: state.proposerId,
        createCalls: state.createCalls,
        auditEvents: [...state.auditEvents],
        approvals: [...state.approvals],
        deployStatuses: [...state.deployStatuses],
        revisions: [...state.revisions],
        publications: [...state.publications],
        idempotency: new Map(idempotency),
        publicationVersion,
      };
      try {
        return await work(storage as unknown as Storage);
      } catch (error) {
        state.proposal = snapshot.proposal;
        state.proposerId = snapshot.proposerId;
        state.createCalls = snapshot.createCalls;
        state.auditEvents = snapshot.auditEvents;
        state.approvals = snapshot.approvals;
        state.deployStatuses = snapshot.deployStatuses;
        state.revisions = snapshot.revisions;
        state.publications = snapshot.publications;
        idempotency.clear();
        for (const [key, value] of snapshot.idempotency) idempotency.set(key, value);
        publicationVersion = snapshot.publicationVersion;
        throw error;
      }
    },
    async appendAuditEvent(input: AppendAuditEventInput) {
      state.auditEvents.push(input);
      return { ...input, proposalId: input.proposalId ?? null, approvalId: input.approvalId ?? null, delegatedHumanActorId: input.delegatedHumanActorId ?? null, persistedAt: fixedNow };
    },
  };
  return storage as unknown as Storage;
}

function services(options: {
  claims?: TokenClaims;
  state?: Partial<FakeState>;
  grants?: readonly AuthorityGrant[];
} = {}): { services: ApiServices; state: FakeState } {
  const state: FakeState = {
    proposal: null,
    proposerId: null,
    createCalls: 0,
    auditEvents: [],
    approvals: [],
    deployStatuses: [],
    inProgressIdempotencyKeys: new Set(),
    failNextTransition: false,
    revisions: [],
    publications: [],
    ...options.state,
  };
  const claims = options.claims ?? tokenClaims();
  const identityResolver: IdentityResolver = {
    async resolveActorKind() {
      return claims.kind === 'service' ? 'service' : 'human';
    },
    async loadGrants() {
      return options.grants ?? [];
    },
    async loadProposerId() {
      return state.proposerId;
    },
    async loadActorProfile() {
      return { displayName: 'Client editor', capabilities: [] };
    },
  };
  return {
    state,
    services: {
      storage: fakeStorage(state),
      audience,
      now: () => fixedNow,
      traceId: () => 'trace-1',
      identityResolver,
      tokenVerifier: {
        verify() {
          return { claims, tokenId: 'token-1' };
        },
      },
    },
  };
}

function request(path: string, options: {
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: number;
  locale?: 'en' | 'es';
} = {}) {
  const headers = new Headers({
    authorization: 'Bearer test',
    'x-tenant-id': 'tenant-1',
    'accept-language': options.locale ?? 'en',
  });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
  if (options.ifMatch !== undefined) headers.set('if-match', `"${options.ifMatch}"`);
  return new Request(`https://cms.example.test${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function proposedRow(state: ProposalRow['state'] = 'previewing'): ProposalRow {
  const payload = proposalShape('proposal-1');
  return {
    id: 'proposal-1', tenantId: 'tenant-1', regionBindingId: 'region-1', slug: 'proposal',
    proposedByActorId: 'human-1', delegatedHumanActorId: null, title: 'Proposal',
    payload, payloadHash: payloadHashOf(payload), state, version: 4,
    validatedAt: fixedNow, approvedAt: null, canonicalWrittenAt: state === 'live' ? fixedNow : null,
    liveAt: state === 'live' ? fixedNow : null, createdAt: fixedNow, updatedAt: fixedNow,
  };
}

describe('Hono authority API', () => {
  it('returns localized RFC 9457 problems with stable codes', async () => {
    const fixture = services();
    const response = await createApi({ services: fixture.services }).fetch(
      new Request('https://cms.example.test/v1/proposals/proposal-1', {
        headers: { 'x-tenant-id': 'tenant-1', 'accept-language': 'es' },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const problem = await response.json();
    expect(problem).toMatchObject({ code: 'E_TOKEN_MISSING', locale: 'es', status: 401 });
    expect(problem.type).toBe('urn:cms:problem:api:E_TOKEN_MISSING');
  });

  it('requires idempotency keys on writes', async () => {
    const fixture = services({ grants: [grant('human-1', ['content.post', 'propose'])] });
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/proposals', { body: { proposal: proposalShape(), regionBindingId: 'region-1', slug: 'proposal', title: 'Proposal' } }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'E_IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('creates an explicit proposed transition and replays the same idempotent response', async () => {
    const fixture = services({ grants: [grant('human-1', ['content.post', 'propose'])] });
    const app = createApi({ services: fixture.services });
    const body = { proposal: proposalShape(), regionBindingId: 'region-1', slug: 'proposal', title: 'Proposal' };
    const first = await app.fetch(request('/v1/proposals', { body, idempotencyKey: 'proposal-key' }));
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ state: 'proposed', version: 2 });
    const replay = await app.fetch(request('/v1/proposals', { body, idempotencyKey: 'proposal-key' }));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ state: 'proposed', version: 2 });
    expect(fixture.state.createCalls).toBe(1);
    expect(fixture.state.auditEvents).toHaveLength(1);
  });

  it('rejects reuse of an idempotency key with a changed body', async () => {
    const fixture = services({ grants: [grant('human-1', ['content.post', 'propose'])] });
    const app = createApi({ services: fixture.services });
    const base = { proposal: proposalShape(), regionBindingId: 'region-1', slug: 'proposal', title: 'Proposal' };
    expect((await app.fetch(request('/v1/proposals', { body: base, idempotencyKey: 'same-key' }))).status).toBe(201);
    const changed = { ...base, title: 'Changed' };
    const response = await app.fetch(request('/v1/proposals', { body: changed, idempotencyKey: 'same-key' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'idempotency_replay_mismatch' });
  });

  it('returns 409 for an in-progress idempotency key without executing the write', async () => {
    const fixture = services({ grants: [grant('human-1', ['content.post', 'propose'])] });
    fixture.state.inProgressIdempotencyKeys.add('tenant-1:busy-key');
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/proposals', {
        body: {
          proposal: proposalShape(),
          regionBindingId: 'region-1',
          slug: 'proposal',
          title: 'Proposal',
        },
        idempotencyKey: 'busy-key',
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'idempotency_in_progress' });
    expect(fixture.state.createCalls).toBe(0);
    expect(fixture.state.auditEvents).toHaveLength(0);
  });

  it('does not return another tenant’s proposal even when the token and header agree', async () => {
    const foreign = { ...proposedRow(), tenantId: 'tenant-2' };
    const fixture = services({
      state: { proposal: foreign, proposerId: 'human-2' },
    });
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/proposals/proposal-1'),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'not_found' });
  });

  it('allows same-human approval only as a separate policy-authorized transition and audits selfApproved', async () => {
    const row = proposedRow();
    const fixture = services({
      state: { proposal: row, proposerId: 'human-1' },
      grants: [grant('human-1', ['content.post', 'approve', 'self_approve'])],
    });
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/proposals/proposal-1/approve', {
        body: { proposal: proposalShape('proposal-1'), note: 'Reviewed' },
        idempotencyKey: 'approve-key',
        ifMatch: 4,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ self_approved: true, target_state: 'approved' });
    expect(fixture.state.approvals[0]).toMatchObject({ selfApproved: true });
    expect(fixture.state.auditEvents.at(-1)).toMatchObject({ selfApproved: true });
    expect(fixture.state.proposal?.state).toBe('approved');
  });

  it('publishes to canonical_written before any live deploy receipt exists', async () => {
    const fixture = services({
      state: { proposal: proposedRow('approved'), proposerId: 'human-2' },
      grants: [grant('human-1', ['content.post', 'publish', 'canonical.write'])],
    });
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/proposals/proposal-1/publish', {
        body: { proposal: proposalShape('proposal-1') },
        idempotencyKey: 'publish-canonical',
        ifMatch: 4,
      }),
    );
    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      status: 'canonical_written',
      proposal_state: 'canonical_written',
      live_at: null,
    });
    expect(fixture.state.revisions).toHaveLength(1);
    expect(fixture.state.publications).toHaveLength(1);
    // The publication must reference the revision id that was actually appended
    // to storage, not any deterministic client-side id.
    const storedRevisionId = fixture.state.revisions[0].id;
    expect(responseBody).toMatchObject({ canonical_revision_id: storedRevisionId });
    expect(fixture.state.publications[0]).toMatchObject({
      canonicalRevisionId: storedRevisionId,
    });
    // The stored diff must contain the canonical revision structure (with its
    // computed id and hash) alongside the authoritative stored proposal payload.
    const storedDiff = fixture.state.revisions[0].diff as Record<string, unknown>;
    expect(storedDiff).toBeDefined();
    expect(storedDiff).toHaveProperty('proposal');
    const canonicalRevision = storedDiff.canonicalRevision as Record<string, unknown>;
    expect(canonicalRevision).toBeDefined();
    expect(canonicalRevision).toMatchObject({
      proposalId: 'proposal-1',
      tenantId: 'tenant-1',
      contentType: 'post',
      environment: 'staging',
      canonicalRepoPath: 'content/post.json',
    });
    expect(typeof canonicalRevision.id).toBe('string');
    expect(typeof canonicalRevision.canonicalHash).toBe('string');
    // diffHash must cover the full diff, not just the proposal shape.
    expect(fixture.state.revisions[0].diffHash).toBeTypeOf('string');
    expect(fixture.state.revisions[0].diffHash).not.toBe('a'.repeat(64));
    expect(fixture.state.auditEvents.at(-1)?.event).toMatchObject({
      kind: 'proposal.canonical_written',
      from: 'approved',
      to: 'canonical_written',
      revisionId: storedRevisionId,
    });
  });

  it('fails optimistic concurrency before applying an approval', async () => {
    const fixture = services({
      state: { proposal: proposedRow(), proposerId: 'human-2' },
      grants: [grant('human-1', ['content.post', 'approve'])],
    });
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/proposals/proposal-1/approve', {
        body: { proposal: proposalShape('proposal-1') }, idempotencyKey: 'stale-key', ifMatch: 3,
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'E_OPTIMISTIC_CONCURRENCY_CONFLICT' });
    expect(fixture.state.approvals).toHaveLength(0);
  });

  it('rolls back prior business writes when a later approval mutation fails', async () => {
    const fixture = services({
      state: {
        proposal: proposedRow(),
        proposerId: 'human-1',
        failNextTransition: true,
      },
      grants: [grant('human-1', ['content.post', 'approve', 'self_approve'])],
    });
    const app = createApi({ services: fixture.services });
    const response = await app.fetch(
      request('/v1/proposals/proposal-1/approve', {
        body: { proposal: proposalShape('proposal-1') },
        idempotencyKey: 'atomic-approval',
        ifMatch: 4,
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'optimistic_concurrency_conflict' });
    expect(fixture.state.approvals).toHaveLength(0);
    expect(fixture.state.auditEvents).toHaveLength(0);
    expect(fixture.state.proposal?.state).toBe('previewing');
    const replay = await app.fetch(
      request('/v1/proposals/proposal-1/approve', {
        body: { proposal: proposalShape('proposal-1') },
        idempotencyKey: 'atomic-approval',
        ifMatch: 4,
      }),
    );
    expect(replay.status).toBe(409);
    expect(replay.headers.get('content-type')).toContain('application/problem+json');
    expect(await replay.json()).toMatchObject({ code: 'optimistic_concurrency_conflict' });
  });

  it('completes one-action human rollback with an immutable audit event', async () => {
    const fixture = services({
      state: { proposal: proposedRow('live'), proposerId: 'human-2' },
      grants: [grant('human-1', ['content.post', 'rollback'])],
    });
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/proposals/proposal-1/rollback', {
        body: { proposal: proposalShape('proposal-1') },
        idempotencyKey: 'rollback-live',
        ifMatch: 4,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'rolled_back', version: 5 });
    expect(fixture.state.auditEvents.at(-1)?.event).toMatchObject({
      kind: 'proposal.rolled_back',
      from: 'live',
      to: 'rolled_back',
    });
  });

  it('requires If-Match for approval writes', async () => {
    const fixture = services({
      state: { proposal: proposedRow(), proposerId: 'human-2' },
      grants: [grant('human-1', ['content.post', 'approve'])],
    });
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/proposals/proposal-1/approve', {
        body: { proposal: proposalShape('proposal-1') },
        idempotencyKey: 'missing-version',
      }),
    );
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ code: 'E_VERSION_HEADER_REQUIRED' });
  });

  it.each(['approve', 'publish', 'rollback'] as const)(
    'hard-refuses service identities on %s',
    async (action) => {
      const fixture = services({
        claims: tokenClaims({ kind: 'service', actorId: 'service-1', sub: 'service-1' }),
        state: { proposal: proposedRow(action === 'rollback' ? 'live' : 'previewing'), proposerId: 'human-2' },
        grants: [grant('service-1', ['content.post', action, 'canonical.write'])],
      });
      const response = await createApi({ services: fixture.services }).fetch(
        request(`/v1/proposals/proposal-1/${action}`, {
          body: { proposal: proposalShape('proposal-1') }, idempotencyKey: `${action}-service`, ifMatch: 4,
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'E_SERVICE_APPROVAL_FORBIDDEN' });
    },
  );

  it('keeps canonical-written separate from live and reconciles after a deploy receipt', async () => {
    const fixture = services({
      state: { proposal: proposedRow('canonical_written'), proposerId: 'human-1' },
    });
    // Deploy-receipt ownership: identity.id must match adapterId and the
    // identity must hold the provisional `deploy.receipt` capability.
    fixture.services.identityResolver.loadActorProfile = async () => ({
      displayName: 'Adapter-1',
      capabilities: ['deploy.receipt'],
    });
    const app = createApi({ services: fixture.services });
    const pending = await app.fetch(
      request('/v1/publications/publication-1/deploy-receipts', {
        body: {
          proposalId: 'proposal-1',
          adapterId: 'human-1',
          externalDeployId: 'deploy-1',
          status: 'pending',
          publicationVersion: 1,
        },
        idempotencyKey: 'deploy-pending',
      }),
    );
    expect(pending.status).toBe(202);
    expect((await pending.json()).proposal).toMatchObject({ state: 'propagating' });

    const succeeded = await app.fetch(
      request('/v1/publications/publication-1/deploy-receipts', {
        body: {
          proposalId: 'proposal-1',
          adapterId: 'human-1',
          externalDeployId: 'deploy-1',
          status: 'succeeded',
          publicationVersion: 2,
          liveUrl: 'https://client.example.test',
        },
        idempotencyKey: 'deploy-succeeded',
      }),
    );
    expect(succeeded.status).toBe(200);
    expect((await succeeded.json()).proposal).toMatchObject({ state: 'live' });
    expect(fixture.state.deployStatuses).toEqual(['pending', 'succeeded']);

    const reconciled = await app.fetch(
      request('/v1/proposals/proposal-1/reconcile', {
        body: { success: true },
        idempotencyKey: 'reconcile-success',
        ifMatch: 6,
      }),
    );
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ state: 'reconciled' });
  });

  it('accepts deployment receipts from a narrowly scoped owning adapter service', async () => {
    const fixture = services({
      claims: tokenClaims({
        sub: 'adapter-1',
        actorId: 'adapter-1',
        kind: 'service',
      }),
      state: { proposal: proposedRow('canonical_written'), proposerId: 'human-1' },
    });
    fixture.services.identityResolver.loadActorProfile = async () => ({
      displayName: null,
      capabilities: ['deploy.receipt'],
    });

    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/publications/publication-1/deploy-receipts', {
        body: {
          proposalId: 'proposal-1',
          adapterId: 'adapter-1',
          externalDeployId: 'deploy-service-1',
          status: 'pending',
          publicationVersion: 1,
        },
        idempotencyKey: 'deploy-service-pending',
      }),
    );

    expect(response.status).toBe(202);
    expect((await response.json()).proposal).toMatchObject({ state: 'propagating' });
    expect(fixture.state.deployStatuses).toEqual(['pending']);
  });

  it('records failed propagation and refuses rollback while a deploy is still in flight', async () => {
    const inFlight = services({
      state: { proposal: proposedRow('propagating'), proposerId: 'human-2' },
      grants: [grant('human-1', ['content.post', 'rollback'])],
    });
    const rollback = await createApi({ services: inFlight.services }).fetch(
      request('/v1/proposals/proposal-1/rollback', {
        body: { proposal: proposalShape('proposal-1') },
        idempotencyKey: 'rollback-in-flight',
        ifMatch: 4,
      }),
    );
    expect(rollback.status).toBe(409);
    expect(await rollback.json()).toMatchObject({ code: 'E_INVALID_TRANSITION' });

    const failed = services({
      state: { proposal: proposedRow('canonical_written'), proposerId: 'human-1' },
    });
    // Adapter ownership: identity.id must equal adapterId and the identity
    // must carry the `deploy.receipt` capability.
    failed.services.identityResolver.loadActorProfile = async () => ({
      displayName: 'Adapter-1',
      capabilities: ['deploy.receipt'],
    });
    const response = await createApi({ services: failed.services }).fetch(
      request('/v1/publications/publication-1/deploy-receipts', {
        body: {
          proposalId: 'proposal-1',
          adapterId: 'human-1',
          externalDeployId: 'deploy-failed',
          status: 'failed',
          publicationVersion: 1,
          failureReason: 'host_unavailable',
        },
        idempotencyKey: 'deploy-failed',
      }),
    );
    // The deploy-receipt double-propagate bug is fixed: a failed receipt
    // from `canonical_written` does NOT spuriously pass through
    // `propagating`. The publication row carries the `failed` status and
    // the proposal stays in `canonical_written` (the receipt row is the
    // authoritative failure record). The missing
    // `canonical_written + propagate -> propagate_failed` edge in
    // @cms/core is documented as an integration blocker.
    expect(response.status).toBe(200);
    expect((await response.json()).proposal).toMatchObject({ state: 'canonical_written' });
    expect(failed.state.deployStatuses).toEqual(['failed']);
  });

  it('returns unauthenticated /v1/health with the negotiated locale', async () => {
    const fixture = services();
    const app = createApi({ services: fixture.services });
    const en = await app.fetch(new Request('https://cms.example.test/v1/health'));
    expect(en.status).toBe(200);
    expect(en.headers.get('content-type')).toContain('application/json');
    const enBody = await en.json();
    expect(enBody).toMatchObject({ status: 'ok', service: '@cms/api', locale: 'en' });

    const es = await app.fetch(
      new Request('https://cms.example.test/v1/health', { headers: { 'accept-language': 'es' } }),
    );
    expect(es.status).toBe(200);
    const esBody = await es.json();
    expect(esBody).toMatchObject({ status: 'ok', locale: 'es' });
  });

  it('refuses a deploy receipt when identity.id does not match adapterId', async () => {
    const fixture = services({
      state: { proposal: proposedRow('canonical_written'), proposerId: 'human-1' },
    });
    fixture.services.identityResolver.loadActorProfile = async () => ({
      displayName: 'Adapter-1',
      capabilities: ['deploy.receipt'],
    });
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/publications/publication-1/deploy-receipts', {
        body: {
          proposalId: 'proposal-1',
          adapterId: 'adapter-1', // not the calling identity id (human-1)
          externalDeployId: 'deploy-1',
          status: 'pending',
          publicationVersion: 1,
        },
        idempotencyKey: 'deploy-mismatch',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'E_INVALID_IDENTITY',
      extensions: { pointer: '/adapterId' },
    });
  });

  it('refuses a deploy receipt when the identity lacks the deploy.receipt capability', async () => {
    const fixture = services({
      state: { proposal: proposedRow('canonical_written'), proposerId: 'human-1' },
    });
    // no capabilities at all
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/publications/publication-1/deploy-receipts', {
        body: {
          proposalId: 'proposal-1',
          adapterId: 'human-1',
          externalDeployId: 'deploy-1',
          status: 'pending',
          publicationVersion: 1,
        },
        idempotencyKey: 'deploy-no-cap',
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'E_INSUFFICIENT_AUTHORITY',
      extensions: { pointer: '/adapterId' },
    });
  });

  it('refuses reconcile for service identities (no impersonation of the live operator)', async () => {
    const fixture = services({
      claims: tokenClaims({ kind: 'service', actorId: 'service-1', sub: 'service-1' }),
      state: { proposal: proposedRow('live'), proposerId: 'human-1' },
    });
    const response = await createApi({ services: fixture.services }).fetch(
      request('/v1/proposals/proposal-1/reconcile', {
        body: { success: true },
        idempotencyKey: 'reconcile-service',
        ifMatch: 4,
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'E_SERVICE_APPROVAL_FORBIDDEN' });
  });
});
