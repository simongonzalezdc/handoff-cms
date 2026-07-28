/**
 * @cms/api — authoritative Hono transport for the handoff CMS.
 *
 * The Hono app is the only authority surface over @cms/core and
 * @cms/storage. CLI/MCP wrap this surface (or `handle`) and never
 * reach past it.
 *
 * Rules:
 *
 *   1. State and policy logic are NOT reimplemented here. Domain
 *      invariants come from @cms/core; persistence from @cms/storage.
 *   2. All service dependencies are passed in via `ApiServices`. The
 *      factory returns a fresh Hono instance for every call; no
 *      module-level state.
 *   3. Errors are RFC 9457 Problem Details, localized in peer en/es
 *      with stable machine codes from the closed union in
 *      `./problem.ts`.
 *   4. Writes require `Idempotency-Key`. Approve / publish / rollback
 *      also require `If-Match` (optimistic concurrency on the
 *      proposal version).
 *   5. Service and MCP identities are refused at the auth layer for
 *      approve / publish / rollback.
 *   6. Self-approval is a stored flag. Same-human propose-then-approve
 *      is allowed only when current policy permits.
 *   7. Canonical_written and live_propagated are distinct beats.
 *   8. Rollback is one current-human-authorized compensating action.
 */

import { createHash } from 'node:crypto';
import {
  Hono,
  type Context,
  type ErrorHandler,
  type MiddlewareHandler,
  type NotFoundHandler,
} from 'hono';

// Hono's `c.json` requires a `ContentfulStatusCode` for the status
// argument; the type isn't part of hono's public surface, so we narrow
// locally. The status codes we emit are always contentful.
type ContentfulStatusCode = 200 | 201 | 202 | 203 | 206 | 207 | 208 | 226 | 300 | 301 | 302 | 303 | 305 | 306 | 307 | 308 | 400 | 401 | 402 | 403 | 404 | 405 | 406 | 407 | 408 | 409 | 410 | 411 | 412 | 413 | 414 | 415 | 416 | 417 | 418 | 421 | 422 | 423 | 424 | 425 | 426 | 428 | 429 | 431 | 451 | 500 | 501 | 502 | 503 | 504 | 505 | 506 | 507 | 508 | 510 | 511;
import {
  type Action,
  type AssetPayload,
  type ContentPayload,
  type Identity,
  type Iso8601,
  type Proposal,
  type Revision,
  assertProposal,
  brandIso8601,
  brandSha256Hex,
  mapContentStateToProposalState,
  mapProposalStateToContentState,
  transition,
} from '@cms/core';
import type {
  AppendAuditEventInput,
  AppendRevisionInput,
  DeployReceiptRow,
  ProposalRow,
  RecordApprovalInput,
  Storage,
  TransitionProposalInput,
} from '@cms/storage';

import {
  AuthorizationError,
  type Audience,
  type AuthorizeResult,
  type AuthorizationContext,
  type IdentityResolver,
  type TokenVerifier,
  authenticate,
  authorize,
  requireHumanAuthority,
} from './auth.js';
import {
  buildProblem,
  negotiateLocale,
  problemFromError,
  type Problem,
  type ProblemCode,
  type ProblemExtensions,
} from './problem.js';
import { openApiDocument, type OpenApiDocument } from './openapi.js';
// ---------------------------------------------------------------------------
// Health-check bypass: the OpenAPI contract marks `/v1/health` as
// unauthenticated. The global request-context middleware would otherwise
// require an Authorization header, an X-Tenant-Id header, and a verified
// token before any other handler runs. `/v1/health` is registered on the
// same Hono app BEFORE the `app.use('*', requestContextMiddleware)`
// registration, so Hono's first-match routing short-circuits the health
// probe before the middleware runs. Everything else still flows through
// the full tenant + bearer middleware.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Service bag
// ---------------------------------------------------------------------------

export interface ApiServices {
  readonly storage: Storage;
  readonly tokenVerifier: TokenVerifier;
  readonly identityResolver: IdentityResolver;
  readonly audience: Audience;
  readonly now: () => Date;
  /** Optional deterministic trace id supplier for tests. */
  readonly traceId?: () => string;
}

export interface CreateApiOptions {
  readonly services: ApiServices;
}

// ---------------------------------------------------------------------------
// Hono context
// ---------------------------------------------------------------------------

export interface ApiVariables {
  readonly auth: AuthorizationContext;
  readonly traceId: string;
  readonly requestFingerprint: string;
  readonly locale: 'en' | 'es';
}

export type ApiEnv = { Variables: ApiVariables };

// ---------------------------------------------------------------------------
// App factory + handle
// ---------------------------------------------------------------------------

/**
 * Build the authority Hono app.
 *
 * `/v1/health` is registered FIRST and short-circuits before the request-
 * context middleware runs, so the OpenAPI `security: []` contract for the
 * health probe is honored without an `X-Tenant-Id` or `Authorization`
 * header. Everything else still runs through the full tenant + bearer
 * middleware.
 */
export function createApi(options: CreateApiOptions): Hono<ApiEnv> {
  const { services } = options;
  const app = new Hono<ApiEnv>();
  app.get('/v1/health', (c) => {
    const locale = requireNegotiatedLocale(c.req.header('accept-language'));
    return c.json(
      Object.freeze({
        status: 'ok',
        service: '@cms/api',
        locale,
      }),
      200,
    );
  });
  app.use('*', requestContextMiddleware(services));
  app.onError(problemOnError());
  app.notFound(notFoundOnError());
  registerRoutes(app, services);
  return app;
}

export async function handle(
  request: Request,
  options: CreateApiOptions,
): Promise<Response> {
  return createApi(options).fetch(request);
}

export { openApiDocument, type OpenApiDocument };

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function requestContextMiddleware(services: ApiServices): MiddlewareHandler<ApiEnv> {
  let counter = 0;
  return async (c, next) => {
    const traceId = services.traceId
      ? services.traceId()
      : (() => {
          counter += 1;
          return sha256Hex(`${services.now().toISOString()}:${counter}`);
        })();
    const locale = requireNegotiatedLocale(c.req.header('accept-language'));
    c.set('traceId', traceId);
    c.set('locale', locale);
    c.set('requestFingerprint', await fingerprintFor(c.req.raw));
    const tenantHeader = c.req.header('x-tenant-id');
    if (tenantHeader === undefined || tenantHeader.length === 0) {
      throw new AuthorizationError({
        code: 'E_TENANT_HEADER_REQUIRED',
        message: 'X-Tenant-Id header is required',
      });
    }
    const auth = await authenticate({
      authorizationHeader: c.req.header('authorization'),
      expectedAudience: services.audience,
      requestedTenantId: tenantHeader,
      locale,
      identityResolver: services.identityResolver,
      tokenVerifier: services.tokenVerifier,
      nowSeconds: Math.floor(services.now().getTime() / 1000),
    });
    c.set('auth', auth);
    await next();
  };
}

function problemOnError(): ErrorHandler<ApiEnv> {
  return (err, c) => {
    const problem = problemFromErrorOrProblemError(
      err,
      c.get('locale') ?? 'en',
      c.req.url,
      c.get('traceId'),
    );
    return c.body(JSON.stringify(problem), problem.status as ContentfulStatusCode, {
      'content-type': 'application/problem+json; charset=UTF-8',
    });
  };
}

function notFoundOnError(): NotFoundHandler<ApiEnv> {
  return (c) => {
    const problem = buildProblem({
      code: 'not_found',
      instance: c.req.url,
      locale: c.get('locale') ?? 'en',
      extensions: { traceId: c.get('traceId') },
    });
    return c.body(JSON.stringify(problem), problem.status as ContentfulStatusCode, {
      'content-type': 'application/problem+json; charset=UTF-8',
    });
  };
}

function problemFromErrorOrProblemError(
  err: unknown,
  locale: 'en' | 'es',
  instance: string,
  traceId: string,
): Problem {
  if (err instanceof ProblemError) {
    return buildProblem({
      code: err.code,
      instance,
      locale,
      extensions: { ...err.extensions, traceId },
    });
  }
  return problemFromError(err, locale, instance, traceId);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function registerRoutes(app: Hono<ApiEnv>, services: ApiServices): void {

  app.get('/v1/proposals/:id', async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id');
    const row = await services.storage.getProposalById(auth.tenantId, id);
    if (row === null) {
      throw new ProblemError('not_found', { proposalId: id });
    }
    return c.json(proposalDto(row), 200);
  });

  app.post('/v1/proposals', (c) =>
    withIdempotentWrite(services, c, async (auth, _idempotencyKey, _fingerprint, storage) => {
      const body = await readJsonObject(c.req.raw);
      const proposalShape = readObjectField(body, 'proposal');
      const regionBindingId = readStringField(body, 'regionBindingId');
      const slug = readStringField(body, 'slug');
      const title = readStringField(body, 'title');

      const proposal = parseProposal(proposalShape, auth.identity);
      const nowIso = brandIso8601(services.now().toISOString());
      await authorize(
        { action: 'propose', identity: auth.identity, proposal, nowIso },
        { identityResolver: services.identityResolver },
      );

      const created = await storage.createProposal({
        tenantId: auth.tenantId,
        regionBindingId,
        slug,
        proposedByActorId: auth.identity.id,
        title,
        payload: proposalShape,
        payloadHash: payloadHashOf(proposalShape),
        idempotencyKey: _idempotencyKey,
        requestFingerprint: _fingerprint,
        endpoint: 'POST /v1/proposals',
      });
      const submitted = await storage.transitionProposal({
        tenantId: auth.tenantId,
        proposalId: created.id,
        expectedVersion: created.version,
        nextState: mapContentStateToProposalState(transition({
          current: mapProposalStateToContentState(created.state),
          action: 'submit',
          actor: auth.identity,
        }).next),
      });
      await appendAudit({ ...services, storage }, auth, {
        kind: 'proposal.proposed',
        selfApproved: false,
        proposalId: created.id,
        from: 'draft',
        to: 'proposed',
      });
      return { status: 201, body: proposalDto(submitted) };
    }),
  );

  app.post('/v1/proposals/:id/approve', (c) =>
    withIdempotentWrite(services, c, async (auth, _idempotencyKey, _fingerprint, storage) => {
      const id = c.req.param('id');
      const expectedVersion = readIfMatch(c);
      const body = await readJsonObject(c.req.raw);
      const proposalShape = readObjectField(body, 'proposal');
      const note = readOptionalStringField(body, 'note');

      const row = await storage.getProposalById(auth.tenantId, id);
      if (row === null) {
        throw new ProblemError('not_found', { proposalId: id });
      }
      if (row.version !== expectedVersion) {
        throw new ProblemError('E_OPTIMISTIC_CONCURRENCY_CONFLICT', {
          proposalId: id,
          expectedVersion,
          currentVersion: row.version,
        });
      }

      const nowIso = brandIso8601(services.now().toISOString());
      const { decision, proposal } = await authorizePersistedProposal(
        services,
        auth,
        row,
        proposalShape,
        'approve',
        nowIso,
      );

      const transitionResult = transition({
        current: mapProposalStateToContentState(row.state),
        action: 'approve',
        actor: auth.identity,
      });
      const recordInput: RecordApprovalInput = {
        tenantId: auth.tenantId,
        proposalId: row.id,
        approverActorId: auth.identity.id,
        selfApproved: decision.selfApproved,
        role: 'approver',
        contentType: proposal.contentType,
        environment: proposal.environment,
        targetState: 'approved',
        ...(note !== null ? { note } : {}),
        ...(auth.delegated ? { delegatedHumanActorId: auth.identity.id } : {}),
      };
      const approvalRow = await storage.recordApproval(recordInput);
      await storage.transitionProposal({
        tenantId: auth.tenantId,
        proposalId: row.id,
        expectedVersion: row.version,
        nextState: mapContentStateToProposalState(transitionResult.next),
        approvedAt: services.now(),
      });


      await appendAudit({ ...services, storage }, auth, {
        kind: 'proposal.approved',
        selfApproved: decision.selfApproved,
        proposalId: row.id,
        approvalId: approvalRow.id,
        from: transitionResult.previous,
        to: transitionResult.next,
      });
      return { status: 200, body: approvalDto(approvalRow) };
    }),
  );

  app.post('/v1/proposals/:id/publish', (c) =>
    withIdempotentWrite(services, c, async (auth, _idempotencyKey, _fingerprint, storage) => {
      const id = c.req.param('id');
      const expectedVersion = readIfMatch(c);
      const body = await readJsonObject(c.req.raw);
      const proposalShape = readObjectField(body, 'proposal');

      const row = await storage.getProposalById(auth.tenantId, id);
      if (row === null) {
        throw new ProblemError('not_found', { proposalId: id });
      }
      if (row.version !== expectedVersion) {
        throw new ProblemError('E_OPTIMISTIC_CONCURRENCY_CONFLICT', {
          proposalId: id,
          expectedVersion,
          currentVersion: row.version,
        });
      }

      const nowIso = brandIso8601(services.now().toISOString());
      const { decision, proposal } = await authorizePersistedProposal(
        services,
        auth,
        row,
        proposalShape,
        'publish',
        nowIso,
      );

      const applyTransition = transition({
        current: mapProposalStateToContentState(row.state),
        action: 'apply',
        actor: auth.identity,
      });
      const canonicalTransition = transition({
        current: applyTransition.next,
        action: 'canonical_write',
        actor: auth.identity,
      });
      const revision = buildCanonicalRevision(proposal, auth.identity, nowIso);
      const diff: Record<string, unknown> = {
        proposal: row.payload,
        canonicalRevision: revision,
      };
      const revisionInput: AppendRevisionInput = {
        tenantId: auth.tenantId,
        proposalId: row.id,
        regionBindingId: row.regionBindingId,
        kind: proposal.kind === 'content' ? 'content' : 'asset',
        slug: row.slug,
        actorId: auth.identity.id,
        selfApproved: decision.selfApproved,
        diff,
        diffHash: payloadHashOf(diff),
      };
      const storedRevision = await storage.appendRevision(revisionInput);

      const publicationRow = await storage.recordPublication({
        tenantId: auth.tenantId,
        proposalId: row.id,
        canonicalRevisionId: storedRevision.id,
      });
      const proposalAfter = await storage.transitionProposal({
        tenantId: auth.tenantId,
        proposalId: row.id,
        expectedVersion: row.version,
        nextState: mapContentStateToProposalState(canonicalTransition.next),
        canonicalWrittenAt: services.now(),
      } satisfies TransitionProposalInput);

      await appendAudit({ ...services, storage }, auth, {
        kind: 'proposal.canonical_written',
        selfApproved: decision.selfApproved,
        proposalId: row.id,
        publicationId: publicationRow.id,
        revisionId: storedRevision.id,
        from: applyTransition.previous,
        to: canonicalTransition.next,
      });
      return { status: 200, body: publicationDto(publicationRow, proposalAfter) };
    }),
  );

  app.post('/v1/proposals/:id/rollback', (c) =>
    withIdempotentWrite(services, c, async (auth, _idempotencyKey, _fingerprint, storage) => {
      const id = c.req.param('id');
      const expectedVersion = readIfMatch(c);
      const body = await readJsonObject(c.req.raw);
      const proposalShape = readObjectField(body, 'proposal');

      const row = await storage.getProposalById(auth.tenantId, id);
      if (row === null) {
        throw new ProblemError('not_found', { proposalId: id });
      }
      if (row.version !== expectedVersion) {
        throw new ProblemError('E_OPTIMISTIC_CONCURRENCY_CONFLICT', {
          proposalId: id,
          expectedVersion,
          currentVersion: row.version,
        });
      }

      const nowIso = brandIso8601(services.now().toISOString());
      await authorizePersistedProposal(
        services,
        auth,
        row,
        proposalShape,
        'rollback',
        nowIso,
      );

      const transitionResult = transition({
        current: mapProposalStateToContentState(row.state),
        action: 'rollback',
        actor: auth.identity,
      });
      const proposalAfter = await storage.transitionProposal({
        tenantId: auth.tenantId,
        proposalId: row.id,
        expectedVersion: row.version,
        nextState: mapContentStateToProposalState(transitionResult.next),
      });
      await appendAudit({ ...services, storage }, auth, {
        kind: 'proposal.rolled_back',
        selfApproved: false,
        proposalId: row.id,
        from: transitionResult.previous,
        to: transitionResult.next,
      });
      return { status: 200, body: proposalDto(proposalAfter) };
    }),
  );
  app.post('/v1/publications/:id/deploy-receipts', (c) =>
    withIdempotentWrite(services, c, async (auth, _idempotencyKey, _fingerprint, storage) => {
      const publicationId = c.req.param('id');
      const body = await readJsonObject(c.req.raw);
      const proposalId = readStringField(body, 'proposalId');
      const adapterId = readStringField(body, 'adapterId');
      const externalDeployId = readStringField(body, 'externalDeployId');
      const status = readStringField(body, 'status');
      if (status !== 'pending' && status !== 'succeeded' && status !== 'failed') {
        throw new ProblemError('E_BAD_REQUEST', { pointer: '/status' });
      }
      // Adapter ownership binding: deploy receipts are host-deployment
      // artifacts, not approval/publication decisions. The authenticated
      // caller must be the declared adapter identity and hold the narrowly
      // scoped deploy.receipt capability. Dedicated adapter services may
      // report receipts; arbitrary agents and MCP identities cannot satisfy
      // both requirements.
      if (auth.identity.id !== adapterId) {
        throw new ProblemError('E_INVALID_IDENTITY', {
          pointer: '/adapterId',
          reason: 'receipt adapterId must match the calling identity id',
        });
      }
      if (!auth.identity.capabilities.includes('deploy.receipt')) {
        throw new ProblemError('E_INSUFFICIENT_AUTHORITY', {
          pointer: '/adapterId',
          reason: 'identity is missing the deploy.receipt capability',
        });
      }
      const publicationVersion = readPositiveInteger(body, 'publicationVersion');
      const row = await storage.getProposalById(auth.tenantId, proposalId);
      if (row === null) {
        throw new ProblemError('not_found', { proposalId });
      }

      const receipt = await storage.recordDeployReceipt({
        tenantId: auth.tenantId,
        publicationId,
        adapterId,
        externalDeployId,
        status,
        ...(body['payload'] && typeof body['payload'] === 'object' && !Array.isArray(body['payload'])
          ? { payload: body['payload'] as Record<string, unknown> }
          : {}),
        ...(typeof body['liveUrl'] === 'string' ? { liveUrl: body['liveUrl'] } : {}),
        ...(status === 'pending' ? {} : { completedAt: services.now() }),
      });

      const nextPublicationStatus =
        status === 'pending' ? 'propagating' : status === 'succeeded' ? 'live' : 'failed';
      await storage.transitionPublication({
        tenantId: auth.tenantId,
        publicationId,
        expectedVersion: publicationVersion,
        nextStatus: nextPublicationStatus,
        ...(status === 'succeeded' ? { liveAt: services.now() } : {}),
        ...(status === 'failed' ? { failureReason: readOptionalStringField(body, 'failureReason') ?? 'deploy_failed' } : {}),
      });

      // Proposal-side state machine.
      //
      // The `failed` branch from `canonical_written` is a known
      // integration blocker: the @cms/core state machine currently has
      // no direct edge from `canonical_written + propagate ->
      // propagate_failed`. The safe fail-closed contract within the
      // assigned files is to leave the proposal in `canonical_written`
      // (no spurious intermediate `propagating` state) and let the
      // publication row carry the `failed` status. The deploy receipt
      // row is the authoritative failure record. See
      // `artifacts/g009/inventory-findings.json` finding
      // `API-DEPLOY-FAILED-DOUBLE-PROPAGATE` for the originating bug
      // report.
      let proposalAfter = row;
      if (proposalAfter.state === 'canonical_written' && status !== 'failed') {
        proposalAfter = await transitionPersistedProposal(
          { ...services, storage },
          auth,
          proposalAfter,
          'propagate',
        );
      }
      if (status === 'succeeded') {
        proposalAfter = await transitionPersistedProposal(
          { ...services, storage },
          auth,
          proposalAfter,
          'go_live',
        );
      } else if (status === 'failed' && proposalAfter.state === 'propagating') {
        proposalAfter = await transitionPersistedProposal(
          { ...services, storage },
          auth,
          proposalAfter,
          'propagate',
        );
      }

      await appendAudit({ ...services, storage }, auth, {
        kind: `deploy.${status}`,
        selfApproved: false,
        proposalId,
        publicationId,
        deployReceiptId: receipt.id,
        from: row.state,
        to: proposalAfter.state,
      });
      return {
        status: status === 'pending' ? 202 : 200,
        body: {
          deploy_receipt: deployReceiptDto(receipt),
          proposal: proposalDto(proposalAfter),
        },
      };
    }),
  );

  app.post('/v1/proposals/:id/reconcile', (c) =>
    withIdempotentWrite(services, c, async (auth, _idempotencyKey, _fingerprint, storage) => {
      // Reconcile ownership: the only safe contract we can introduce here
      // is a current human authority. The host-side publication-owner
      // model is an explicit integration blocker (no publication row
      // carries an owning actor id today); the storage schema must grow
      // a `publication_owner_actor_id` column and a corresponding
      // IdentityResolver.loadPublicationOwner hook before a tighter
      // ownership check can land. See
      // `artifacts/g009/inventory-findings.json` finding
      // `API-DEPLOY-AUTHORITY-BINDING`.
      requireHumanAuthority({ action: 'rollback', identity: auth.identity });
      const proposalId = c.req.param('id');
      const expectedVersion = readIfMatch(c);
      const body = await readJsonObject(c.req.raw);
      const success = body['success'];
      if (typeof success !== 'boolean') {
        throw new ProblemError('E_BAD_REQUEST', { pointer: '/success' });
      }
      const row = await storage.getProposalById(auth.tenantId, proposalId);
      if (row === null) {
        throw new ProblemError('not_found', { proposalId });
      }
      if (row.version !== expectedVersion) {
        throw new ProblemError('E_OPTIMISTIC_CONCURRENCY_CONFLICT', {
          proposalId,
          expectedVersion,
          currentVersion: row.version,
        });
      }
      const proposalAfter = await transitionPersistedProposal(
        { ...services, storage },
        auth,
        row,
        success ? 'reconcile' : 'reconcile_fail',
      );
      await appendAudit({ ...services, storage }, auth, {
        kind: success ? 'deploy.reconciled' : 'deploy.reconcile_failed',
        selfApproved: false,
        proposalId,
        from: row.state,
        to: proposalAfter.state,
      });
      return { status: 200, body: proposalDto(proposalAfter) };
    }),
  );
}

// ---------------------------------------------------------------------------
// Idempotency-wrapped write
// ---------------------------------------------------------------------------

type WriteHandler = (
  auth: AuthorizationContext,
  idempotencyKey: string,
  fingerprint: string,
  storage: Storage,
) => Promise<{ readonly status: number; readonly body: unknown }>;

async function withIdempotentWrite(
  services: ApiServices,
  c: Context<ApiEnv>,
  handler: WriteHandler,
): Promise<Response> {
  const auth = c.get('auth');
  const keyHeader = c.req.header('idempotency-key');
  if (keyHeader === undefined || keyHeader.length === 0) {
    throw new AuthorizationError({
      code: 'E_IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header is required',
    });
  }
  if (keyHeader.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(keyHeader)) {
    throw new AuthorizationError({
      code: 'E_IDEMPOTENCY_KEY_MALFORMED',
      message: 'Idempotency-Key is not well-formed',
    });
  }
  const traceId = c.get('traceId');
  const replay = await services.storage.beginIdempotency({
    tenantId: auth.tenantId,
    idempotencyKey: keyHeader,
    requestFingerprint: c.get('requestFingerprint'),
    endpoint: `${c.req.method} ${c.req.path}`,
    lockedBy: traceId,
    lockTtlSeconds: 600,
  });
  if (replay.source === 'succeeded' || replay.source === 'failed') {
    const record = replay.record;
    if (record.response === null || record.responseStatus === null) {
      throw new AuthorizationError({
        code: 'E_IDEMPOTENCY_REPLAY_MISMATCH',
        message: 'recorded response is incomplete',
      });
    }
    if (replay.source === 'failed') {
      return c.body(
        JSON.stringify(record.response),
        record.responseStatus as ContentfulStatusCode,
        { 'content-type': 'application/problem+json; charset=UTF-8' },
      );
    }
    return c.json(record.response, record.responseStatus as ContentfulStatusCode);
  }
  try {
    const result = await services.storage.runInTransaction(async (transaction) => {
      const body = await handler(
        auth,
        keyHeader,
        c.get('requestFingerprint'),
        transaction,
      );
      await transaction.finalizeIdempotency({
        tenantId: auth.tenantId,
        idempotencyKey: keyHeader,
        outcome: 'succeeded',
        response: body.body as Record<string, unknown>,
        responseStatus: body.status,
      });
      return body;
    });
    return c.json(result.body, result.status as ContentfulStatusCode);
  } catch (err) {
    const problem = problemFromErrorOrProblemError(err, auth.locale, c.req.url, traceId);
    await services.storage.finalizeIdempotency({
      tenantId: auth.tenantId,
      idempotencyKey: keyHeader,
      outcome: 'failed',
      response: problem as unknown as Record<string, unknown>,
      responseStatus: problem.status,
    });
    throw err;
  }
}

async function transitionPersistedProposal(
  services: ApiServices,
  auth: AuthorizationContext,
  row: ProposalRow,
  action: Action,
): Promise<ProposalRow> {
  const result = transition({
    current: mapProposalStateToContentState(row.state),
    action,
    actor: auth.identity,
  });
  return services.storage.transitionProposal({
    tenantId: auth.tenantId,
    proposalId: row.id,
    expectedVersion: row.version,
    nextState: mapContentStateToProposalState(result.next),
    ...(result.next === 'live' ? { liveAt: services.now() } : {}),
  });
}

// ---------------------------------------------------------------------------
// ProblemError: a transport-level failure the middleware renders as a
// Problem. Carries the closed-union code and an extensions bag.
// ---------------------------------------------------------------------------

class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly extensions: ProblemExtensions;
  constructor(code: ProblemCode, extensions: ProblemExtensions = {}) {
    super(code);
    this.name = 'ProblemError';
    this.code = code;
    this.extensions = extensions;
  }
}

function requireNegotiatedLocale(acceptLanguage: string | undefined): 'en' | 'es' {
  const locale = negotiateLocale(acceptLanguage);
  if (locale === undefined) throw new ProblemError('E_BAD_LOCALE');
  return locale;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------


function proposalDto(row: ProposalRow): unknown {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    region_binding_id: row.regionBindingId,
    slug: row.slug,
    proposed_by_actor_id: row.proposedByActorId,
    delegated_human_actor_id: row.delegatedHumanActorId,
    title: row.title,
    state: row.state,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    validated_at: row.validatedAt === null ? null : row.validatedAt.toISOString(),
    approved_at: row.approvedAt === null ? null : row.approvedAt.toISOString(),
    canonical_written_at: row.canonicalWrittenAt === null ? null : row.canonicalWrittenAt.toISOString(),
    live_at: row.liveAt === null ? null : row.liveAt.toISOString(),
  };
}

function approvalDto(row: {
  id: string;
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
}): unknown {
  return {
    id: row.id,
    proposal_id: row.proposalId,
    approver_actor_id: row.approverActorId,
    delegated_human_actor_id: row.delegatedHumanActorId,
    self_approved: row.selfApproved,
    role: row.role,
    content_type: row.contentType,
    environment: row.environment,
    note: row.note,
    target_state: row.targetState,
    rollback_target_proposal_id: row.rollbackTargetProposalId,
    created_at: row.createdAt.toISOString(),
  };
}

function publicationDto(
  row: {
    id: string;
    proposalId: string;
    canonicalRevisionId: string;
    status: string;
    canonicalWrittenAt: Date;
    liveAt: Date | null;
    failureReason: string | null;
    version: number;
  },
  proposal: ProposalRow,
): unknown {
  return {
    id: row.id,
    proposal_id: row.proposalId,
    canonical_revision_id: row.canonicalRevisionId,
    status: row.status,
    canonical_written_at: row.canonicalWrittenAt.toISOString(),
    live_at: row.liveAt === null ? null : row.liveAt.toISOString(),
    failure_reason: row.failureReason,
    version: row.version,
    proposal_state: proposal.state,
  };
}

function deployReceiptDto(row: DeployReceiptRow): unknown {
  return {
    id: row.id,
    publication_id: row.publicationId,
    adapter_id: row.adapterId,
    external_deploy_id: row.externalDeployId,
    status: row.status,
    payload: row.payload,
    live_url: row.liveUrl,
    received_at: row.receivedAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length === 0) {
    throw new ProblemError('E_BAD_REQUEST', { pointer: '/' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProblemError('E_BAD_REQUEST', { pointer: '/' });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProblemError('E_BAD_REQUEST', { pointer: '/' });
  }
  return parsed as Record<string, unknown>;
}

function readStringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProblemError('E_BAD_REQUEST', { pointer: `/${key}` });
  }
  return value;
}

function readOptionalStringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ProblemError('E_BAD_REQUEST', { pointer: `/${key}` });
  }
  return value;
}

function readPositiveInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ProblemError('E_BAD_REQUEST', { pointer: `/${key}` });
  }
  return value as number;
}

function readObjectField(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProblemError('E_BAD_REQUEST', { pointer: `/${key}` });
  }
  return value as Record<string, unknown>;
}

function readIfMatch(c: Context<ApiEnv>): number {
  const header = c.req.header('if-match');
  if (header === undefined || header.length === 0) {
    throw new ProblemError('E_VERSION_HEADER_REQUIRED');
  }
  const parsed = Number.parseInt(header.replace(/^W\//, '').replace(/^"|"$/g, ''), 10);
  if (!Number.isFinite(parsed)) {
    throw new ProblemError('E_BAD_REQUEST', { pointer: '/If-Match' });
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Proposal parsing. Strict and bounded; all errors become Problem-shaped.
// ---------------------------------------------------------------------------

function parseProposal(shape: Record<string, unknown>, identity: Identity): Proposal {
  const id = readStringField(shape, 'id');
  const tenantId = readStringField(shape, 'tenantId');
  const contentType = readStringField(shape, 'contentType');
  const environmentRaw = readStringField(shape, 'environment');
  if (environmentRaw !== 'staging' && environmentRaw !== 'production') {
    throw new ProblemError('E_BAD_REQUEST', { pointer: '/proposal/environment' });
  }
  const environment = environmentRaw;
  const actionRaw = readStringField(shape, 'action');
  if (actionRaw !== 'create' && actionRaw !== 'update' && actionRaw !== 'delete' && actionRaw !== 'retire') {
    throw new ProblemError('E_BAD_REQUEST', { pointer: '/proposal/action' });
  }
  const action = actionRaw;
  const createdAt = brandIso8601(readStringField(shape, 'createdAt'));
  const draft = shape['draft'] === true;
  const kindRaw = readStringField(shape, 'kind');
  if (kindRaw !== 'content' && kindRaw !== 'asset') {
    throw new ProblemError('E_BAD_REQUEST', { pointer: '/proposal/kind' });
  }
  const kind = kindRaw;
  if (kind === 'content') {
    const payload: ContentPayload = {
      localizedTitle: {
        en: readStringField(readObjectField(shape, 'localizedTitle'), 'en'),
        es: readStringField(readObjectField(shape, 'localizedTitle'), 'es'),
      },
      localizedBody: {
        en: readStringField(readObjectField(shape, 'localizedBody'), 'en'),
        es: readStringField(readObjectField(shape, 'localizedBody'), 'es'),
      },
      canonicalRepoPath: readStringField(shape, 'canonicalRepoPath'),
    };
    const proposal: Proposal = {
      kind: 'content',
      id,
      tenantId,
      contentType,
      environment,
      action,
      createdBy: identity,
      createdAt,
      draft,
      payload,
    };
    assertProposal(proposal);
    return proposal;
  }
  const payload: AssetPayload = {
    bindingId: readStringField(shape, 'bindingId'),
    canonicalRepoPath: readStringField(shape, 'canonicalRepoPath'),
    previewRepoPath: readStringField(shape, 'previewRepoPath'),
  };
  const proposal: Proposal = {
    kind: 'asset',
    id,
    tenantId,
    contentType,
    environment,
    action,
    createdBy: identity,
    createdAt,
    draft,
    payload,
  };
  assertProposal(proposal);
  return proposal;
}

// ---------------------------------------------------------------------------
// Authorize against the persisted proposal row.
//
// Fails closed unless the request proposal payload hash exactly matches
// `row.payloadHash`, parses `row.payload`, verifies persisted tenant
// consistency, and uses `row.id` / `row.tenantId` as authoritative for
// policy / proposer lookup. Request-body divergence in id, contentType,
// environment, or any proposal payload returns a stable bad-request
// problem before authorization / state mutation.
// ---------------------------------------------------------------------------
async function authorizePersistedProposal(
  services: ApiServices,
  auth: AuthorizationContext,
  row: ProposalRow,
  proposalShape: Record<string, unknown>,
  action: 'approve' | 'publish' | 'rollback',
  nowIso: Iso8601,
): Promise<{ readonly decision: AuthorizeResult; readonly proposal: Proposal }> {
  const bodyHash = payloadHashOf(proposalShape);
  if (bodyHash !== row.payloadHash) {
    throw new ProblemError('E_BAD_REQUEST', {
      pointer: '/proposal',
      reason: 'request proposal payload does not match the persisted proposal row',
    });
  }
  const parsed = parseProposal(proposalShape, auth.identity);
  const proposal: Proposal = {
    ...parsed,
    id: row.id,
    tenantId: row.tenantId,
  };
  const decision = await authorize(
    { action, identity: auth.identity, proposal, nowIso },
    { identityResolver: services.identityResolver },
  );
  return { decision, proposal };
}
// ---------------------------------------------------------------------------
// Build a canonical revision (immutable post-publish record). The id is
// derived deterministically from the proposal id + revision time so two
// API instances given the same input produce the same id.
// ---------------------------------------------------------------------------

function buildCanonicalRevision(
  proposal: Proposal,
  identity: Identity,
  nowIso: Iso8601,
): Revision {
  const revisionId = `rev_${sha256Hex(`${proposal.id}|${nowIso}`).slice(0, 32)}`;
  if (proposal.kind === 'content') {
    return {
      id: revisionId,
      proposalId: proposal.id,
      tenantId: proposal.tenantId,
      contentType: proposal.contentType,
      environment: proposal.environment,
      locale: 'en',
      localizedTitle: proposal.payload.localizedTitle,
      localizedBody: proposal.payload.localizedBody,
      canonicalRepoPath: proposal.payload.canonicalRepoPath,
      canonicalHash: brandSha256Hex(sha256Hex(JSON.stringify(proposal.payload))),
      createdAt: nowIso,
      createdBy: identity,
    };
  }
  return {
    id: revisionId,
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    bindingId: proposal.payload.bindingId,
    environment: proposal.environment,
    canonicalRepoPath: proposal.payload.canonicalRepoPath,
    canonicalHash: brandSha256Hex(sha256Hex(JSON.stringify(proposal.payload))),
    previewRepoPath: proposal.payload.previewRepoPath,
    previewHash: brandSha256Hex(sha256Hex(JSON.stringify(proposal.payload))),
    createdAt: nowIso,
    createdBy: identity,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

interface AuditInput {
  readonly kind: string;
  readonly selfApproved: boolean;
  readonly proposalId?: string;
  readonly approvalId?: string;
  readonly publicationId?: string;
  readonly revisionId?: string;
  readonly deployReceiptId?: string;
  readonly from?: string;
  readonly to?: string;
}

async function appendAudit(
  services: ApiServices,
  auth: AuthorizationContext,
  input: AuditInput,
): Promise<void> {
  const eventEnvelope: Record<string, unknown> = { kind: input.kind };
  if (input.from !== undefined) eventEnvelope['from'] = input.from;
  if (input.to !== undefined) eventEnvelope['to'] = input.to;
  if (input.publicationId !== undefined) eventEnvelope['publicationId'] = input.publicationId;
  if (input.revisionId !== undefined) eventEnvelope['revisionId'] = input.revisionId;
  if (input.deployReceiptId !== undefined) eventEnvelope['deployReceiptId'] = input.deployReceiptId;
  const occurredAt = services.now();
  const eventHash = sha256Hex(
    JSON.stringify({
      ...eventEnvelope,
      tenantId: auth.tenantId,
      actorId: auth.identity.id,
      proposalId: input.proposalId ?? null,
      approvalId: input.approvalId ?? null,
      occurredAt: occurredAt.toISOString(),
    }),
  );
  const base: Omit<AppendAuditEventInput, 'proposalId' | 'approvalId'> = {
    eventHash,
    tenantId: auth.tenantId,
    actorId: auth.identity.id,
    selfApproved: input.selfApproved,
    occurredAt,
    schemaVersion: 1,
    event: eventEnvelope,
  };
  const append: AppendAuditEventInput = {
    ...base,
    ...(input.proposalId !== undefined ? { proposalId: input.proposalId } : {}),
    ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
  };
  await services.storage.appendAuditEvent(append);
}

// ---------------------------------------------------------------------------
// Hashing helpers (SHA-256; the audit module owns signed envelopes).
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function payloadHashOf(payload: Record<string, unknown>): string {
  const sorted = Object.keys(payload).sort();
  const canonical = `{${sorted.map((k) => `${JSON.stringify(k)}:${JSON.stringify(payload[k])}`).join(',')}}`;
  return sha256Hex(canonical);
}

async function fingerprintFor(req: Request): Promise<string> {
  const url = new URL(req.url);
  const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.clone().text();
  return sha256Hex(
    `${req.method}\n${url.pathname}\n${url.search}\n${req.headers.get('content-type') ?? ''}\n${body}`,
  );
}

// ---------------------------------------------------------------------------
// Re-exports for downstream consumers (CLI, MCP, tests).
// ---------------------------------------------------------------------------

export {
  AuthorizationError,
  authenticate,
  authorize,
  buildActorIdentity,
  buildServiceIdentity,
  buildDelegatedHumanIdentity,
  detectSelfApproval,
  requireHumanAuthority,
  requireLiveDelegation,
  enforceTenantScope,
  validateTokenShape,
} from './auth.js';
export type {
  Audience,
  AuthorizationContext,
  AuthorizeResult,
  IdentityResolver,
  ResolvedActorKind,
  TokenClaims,
  TokenVerifier,
  VerifiedToken,
} from './auth.js';

export {
  API_ERROR_CODES,
  PROBLEM_LOCALES,
  buildProblem,
  isSupportedLocale,
  messageFor,
  negotiateLocale,
  problemCodeScope,
  problemFromError,
  problemTypeUrn,
  statusFor,
} from './problem.js';
export type {
  ApiErrorCode,
  FieldError,
  Problem,
  ProblemCode,
  ProblemCodeScope,
  ProblemExtensions,
  ProblemMessage,
} from './problem.js';

