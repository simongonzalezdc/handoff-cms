/**
 * @cms/api — token verification, identity resolution, and the single
 * authorization facade for the authority surface.
 *
 * This module owns:
 *   - Bearer-token contract: audience-bound, tenant-bound, expiry-checked.
 *   - Token shape validation (the verifier is pluggable; this checks the
 *     post-verification claims).
 *   - Identity construction (actor / service / delegated_human).
 *   - Hard refusal of service and MCP identities for approve / publish /
 *     rollback — runs before the policy engine.
 *   - Delegated-session liveness check for delegated_human identities.
 *   - Self-approval flag detection.
 *   - The single `authorize` facade. Handlers never touch the policy
 *     engine directly.
 *
 * Authority grants and proposer lookup are pulled via the injected
 * `IdentityResolver`, so no module-level state and no I/O here.
 */

import {
  type AuthorityGrant,
  type AuthorityResolver,
  type ErrorCode as CoreErrorCode,
  type Identity,
  type Iso8601,
  type Locale,
  type PolicyAction,
  type PolicyDecision,
  type ProposerResolver,
  type Proposal,
  enforcePolicy,
} from '@cms/core';
import type { ApiErrorCode } from './problem.js';

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

export type Audience = string & { readonly __brand: 'Audience' };

// ---------------------------------------------------------------------------
// Token shapes
// ---------------------------------------------------------------------------

export interface TokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: Audience;
  readonly exp: number;
  readonly iat: number;
  readonly tenantId: string;
  readonly actorId: string;
  readonly kind: 'human' | 'service';
  readonly scope: readonly string[];
  readonly delegatorId?: string;
  readonly delegatedAt?: Iso8601;
  readonly delegatedUntil?: Iso8601;
}

export interface VerifiedToken {
  readonly claims: TokenClaims;
  readonly tokenId: string;
}

/**
 * Pluggable bearer-token verifier. The host wires a real implementation
 * (JWT verify, DPoP verify, mTLS, etc.) and the API surface treats it as
 * a pure function: present the raw `Authorization` header, get a
 * `VerifiedToken` or throw. The verifier is responsible for all
 * cryptographic work; this contract is the only shape the API knows.
 */
export interface TokenVerifier {
  verify(
    authorizationHeader: string,
    expectedAudience: Audience,
  ): VerifiedToken | Promise<VerifiedToken>;
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

export type ResolvedActorKind = 'human' | 'agent' | 'service';

export interface IdentityResolver {
  /**
   * Return the canonical actor kind for a verified token. `null` means
   * "no actor row matches these claims" — the API then refuses the
   * request with E_UNAUTHORIZED.
   */
  resolveActorKind(claims: TokenClaims): Promise<ResolvedActorKind | null>;
  /** Return the live, non-expired authority grants for an actor. */
  loadGrants(tenantId: string, actorId: string): Promise<readonly AuthorityGrant[]>;
  /** Return the proposer actor id of a proposal. */
  loadProposerId(tenantId: string, proposalId: string): Promise<string | null>;
  /** Return the display name and capabilities to stamp onto the identity. */
  loadActorProfile(
    actorId: string,
    claims: TokenClaims,
  ): Promise<{ readonly displayName: string; readonly capabilities: readonly string[] }>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface AuthorizationErrorOptions {
  readonly code: ApiErrorCode | CoreErrorCode;
  readonly message: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export class AuthorizationError extends Error {
  readonly code: ApiErrorCode | CoreErrorCode;
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(options: AuthorizationErrorOptions) {
    super(options.message);
    this.name = 'AuthorizationError';
    this.code = options.code;
    this.extensions = options.extensions ?? {};
  }
}

// ---------------------------------------------------------------------------
// Identity construction
// ---------------------------------------------------------------------------

function isMcpCapability(scope: readonly string[]): boolean {
  return scope.includes('mcp');
}

const TOKEN_IDENTITY_CAPABILITY_ALLOWLIST: ReadonlySet<string> = new Set([
  'mcp',
  'deploy.receipt',
]);

function allowedTokenIdentityCapabilities(scope: readonly string[]): readonly string[] {
  return scope.filter((capability) => TOKEN_IDENTITY_CAPABILITY_ALLOWLIST.has(capability));
}

export interface BuildIdentityInput {
  readonly claims: TokenClaims;
  readonly displayName: string;
  readonly capabilities: readonly string[];
}

export function buildActorIdentity(input: BuildIdentityInput): Identity {
  return {
    kind: 'actor',
    id: input.claims.actorId,
    displayName: input.displayName,
    capabilities: input.capabilities,
  };
}

export function buildServiceIdentity(input: BuildIdentityInput): Identity {
  return {
    kind: 'service',
    id: input.claims.actorId,
    displayName: input.displayName,
    capabilities: input.capabilities,
  };
}

export function buildDelegatedHumanIdentity(input: BuildIdentityInput): Identity {
  if (input.claims.kind !== 'human') {
    throw new AuthorizationError({
      code: 'E_TOKEN_MALFORMED',
      message: 'delegated session token must identify a human actor',
    });
  }
  if (input.claims.delegatorId === undefined) {
    throw new AuthorizationError({
      code: 'E_TOKEN_MALFORMED',
      message: 'delegated session token is missing delegatorId',
    });
  }
  if (input.claims.delegatedAt === undefined || input.claims.delegatedUntil === undefined) {
    throw new AuthorizationError({
      code: 'E_TOKEN_MALFORMED',
      message: 'delegated session token is missing delegatedAt/delegatedUntil',
    });
  }
  return {
    kind: 'delegated_human',
    id: input.claims.actorId,
    displayName: input.displayName,
    capabilities: input.capabilities,
    delegatorId: input.claims.delegatorId,
    delegatedAt: input.claims.delegatedAt,
    delegatedUntil: input.claims.delegatedUntil,
  };
}

// ---------------------------------------------------------------------------
// Hard refusal: service and MCP identities cannot approve/publish/rollback.
// Runs before the policy engine.
// ---------------------------------------------------------------------------

const HUMAN_REQUIRED_ACTIONS: ReadonlySet<PolicyAction> = new Set([
  'approve',
  'publish',
  'rollback',
]);

export function requireHumanAuthority(input: {
  readonly action: PolicyAction;
  readonly identity: Identity;
}): void {
  if (!HUMAN_REQUIRED_ACTIONS.has(input.action)) return;
  if (input.identity.kind === 'service') {
    throw new AuthorizationError({
      code: 'E_SERVICE_APPROVAL_FORBIDDEN',
      message: 'service identity is not allowed to approve, publish, or rollback',
    });
  }
  if (input.identity.capabilities.includes('mcp')) {
    throw new AuthorizationError({
      code: 'E_MCP_APPROVAL_FORBIDDEN',
      message: 'MCP-capable identity is not allowed to approve, publish, or rollback',
    });
  }
}

// ---------------------------------------------------------------------------
// Delegated-session liveness
// ---------------------------------------------------------------------------

export function requireLiveDelegation(input: {
  readonly identity: Identity;
  readonly nowIso: string;
}): void {
  if (input.identity.kind !== 'delegated_human') return;
  const now = Date.parse(input.nowIso);
  const from = Date.parse(input.identity.delegatedAt);
  const until = Date.parse(input.identity.delegatedUntil);
  if (Number.isNaN(now) || Number.isNaN(from) || Number.isNaN(until)) {
    throw new AuthorizationError({
      code: 'E_TOKEN_MALFORMED',
      message: 'delegated session timestamps are not valid ISO-8601',
    });
  }
  if (now < from || now >= until) {
    throw new AuthorizationError({
      code: 'E_DELEGATION_EXPIRED',
      message: 'delegated session is not within its active window',
    });
  }
}

// ---------------------------------------------------------------------------
// Self-approval flag
// ---------------------------------------------------------------------------

export function detectSelfApproval(
  identity: Identity,
  proposerIdentityId: string,
): boolean {
  return identity.id === proposerIdentityId;
}

// ---------------------------------------------------------------------------
// Authorization facade
// ---------------------------------------------------------------------------

export interface AuthorizeInput {
  readonly action: PolicyAction;
  readonly identity: Identity;
  readonly proposal: Proposal;
  readonly nowIso: string;
}

export interface AuthorizeDeps {
  readonly identityResolver: IdentityResolver;
}

export interface AuthorizeResult extends PolicyDecision {
  readonly selfApproved: boolean;
}

export async function authorize(
  input: AuthorizeInput,
  deps: AuthorizeDeps,
): Promise<AuthorizeResult> {
  requireHumanAuthority({ action: input.action, identity: input.identity });
  requireLiveDelegation({ identity: input.identity, nowIso: input.nowIso });

  const grants = await deps.identityResolver.loadGrants(input.proposal.tenantId, input.identity.id);
  const proposerId =
    input.action === 'propose'
      ? input.identity.id
      : await deps.identityResolver.loadProposerId(input.proposal.tenantId, input.proposal.id);
  if (proposerId === null) {
    throw new AuthorizationError({
      code: 'E_UNAUTHORIZED',
      message: `proposer for proposal ${input.proposal.id} not found`,
    });
  }

  const resolver: AuthorityResolver = () => grants;
  const proposer: ProposerResolver = () => proposerId;
  const decision = enforcePolicy(
    {
      action: input.action,
      actor: input.identity,
      proposal: input.proposal,
      nowIso: input.nowIso,
    },
    resolver,
    proposer,
  );
  return { ...decision, selfApproved: detectSelfApproval(input.identity, proposerId) };
}

// ---------------------------------------------------------------------------
// Tenant scope
// ---------------------------------------------------------------------------

export function enforceTenantScope(input: {
  readonly claims: TokenClaims;
  readonly requestedTenantId: string;
}): void {
  if (input.claims.tenantId !== input.requestedTenantId) {
    throw new AuthorizationError({
      code: 'E_TENANT_FORBIDDEN',
      message: 'token tenant does not match the requested tenant',
    });
  }
}

// ---------------------------------------------------------------------------
// Token shape verification
// ---------------------------------------------------------------------------

export function validateTokenShape(input: {
  readonly claims: TokenClaims;
  readonly nowSeconds: number;
  readonly audience: Audience;
}): void {
  const { claims, nowSeconds, audience } = input;
  if (claims.aud !== audience) {
    throw new AuthorizationError({
      code: 'E_TOKEN_AUDIENCE_MISMATCH',
      message: 'token audience does not match the API audience',
    });
  }
  if (claims.exp <= nowSeconds) {
    throw new AuthorizationError({ code: 'E_TOKEN_EXPIRED', message: 'token has expired' });
  }
  if (claims.iat > nowSeconds) {
    throw new AuthorizationError({
      code: 'E_TOKEN_MALFORMED',
      message: 'token iat is in the future',
    });
  }
  if (claims.actorId.length === 0) {
    throw new AuthorizationError({ code: 'E_TOKEN_MALFORMED', message: 'token actorId missing' });
  }
  if (claims.tenantId.length === 0) {
    throw new AuthorizationError({ code: 'E_TOKEN_MALFORMED', message: 'token tenantId missing' });
  }
  if (claims.kind !== 'human' && claims.kind !== 'service') {
    throw new AuthorizationError({
      code: 'E_TOKEN_MALFORMED',
      message: 'token kind must be human or service',
    });
  }
}

// ---------------------------------------------------------------------------
// Authorization context
// ---------------------------------------------------------------------------

export interface AuthorizationContext {
  readonly identity: Identity;
  readonly claims: TokenClaims;
  readonly tenantId: string;
  readonly locale: Locale;
  readonly delegated: boolean;
}

export interface AuthenticateInput {
  readonly authorizationHeader: string | null | undefined;
  readonly expectedAudience: Audience;
  readonly requestedTenantId: string;
  readonly locale: Locale;
  readonly identityResolver: IdentityResolver;
  readonly tokenVerifier: TokenVerifier;
  readonly nowSeconds: number;
}

export async function authenticate(input: AuthenticateInput): Promise<AuthorizationContext> {
  if (input.authorizationHeader === null || input.authorizationHeader === undefined) {
    throw new AuthorizationError({ code: 'E_TOKEN_MISSING', message: 'Authorization header required' });
  }
  if (input.authorizationHeader.trim() === '') {
    throw new AuthorizationError({ code: 'E_TOKEN_MISSING', message: 'Authorization header empty' });
  }

  let verified: VerifiedToken;
  try {
    verified = await input.tokenVerifier.verify(input.authorizationHeader, input.expectedAudience);
  } catch (cause) {
    throw new AuthorizationError({
      code: 'E_TOKEN_MALFORMED',
      message: cause instanceof Error ? cause.message : 'token verification failed',
    });
  }
  validateTokenShape({
    claims: verified.claims,
    nowSeconds: input.nowSeconds,
    audience: input.expectedAudience,
  });
  enforceTenantScope({
    claims: verified.claims,
    requestedTenantId: input.requestedTenantId,
  });

  const kind = await input.identityResolver.resolveActorKind(verified.claims);
  if (kind === null) {
    throw new AuthorizationError({ code: 'E_UNAUTHORIZED', message: 'identity is not provisioned' });
  }
  const profile = await input.identityResolver.loadActorProfile(verified.claims.actorId, verified.claims);
  const identity = buildIdentity({
    claims: verified.claims,
    declaredKind: kind,
    capabilities: [...new Set([
      ...profile.capabilities,
      ...allowedTokenIdentityCapabilities(verified.claims.scope),
    ])],
    displayName: profile.displayName,
  });
  return {
    identity,
    claims: verified.claims,
    tenantId: input.requestedTenantId,
    locale: input.locale,
    delegated: identity.kind === 'delegated_human',
  };
}

interface BuildIdentityOptions {
  readonly claims: TokenClaims;
  readonly declaredKind: ResolvedActorKind;
  readonly capabilities: readonly string[];
  readonly displayName: string;
}

function buildIdentity(opts: BuildIdentityOptions): Identity {
  if (opts.declaredKind === 'service' || opts.claims.kind === 'service') {
    return buildServiceIdentity({
      claims: opts.claims,
      displayName: opts.displayName,
      capabilities: opts.capabilities,
    });
  }
  if (opts.claims.delegatorId !== undefined) {
    return buildDelegatedHumanIdentity({
      claims: opts.claims,
      displayName: opts.displayName,
      capabilities: opts.capabilities,
    });
  }
  return buildActorIdentity({
    claims: opts.claims,
    displayName: opts.displayName,
    capabilities: opts.capabilities,
  });
}

export function tokenHasMcpCapability(claims: TokenClaims): boolean {
  return isMcpCapability(claims.scope);
}

export type { AuthorityGrant, AuthorityResolver, ProposerResolver };
