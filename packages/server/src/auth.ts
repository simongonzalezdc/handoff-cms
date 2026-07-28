/**
 * @cms/server — OIDC bearer-token verifier for the self-hosted server.
 *
 * Implements the `@cms/api` `TokenVerifier` contract on top of Node Web
 * standards (`jose`): JWT compact JWS, JWKS-backed RS/ES/PS asymmetric
 * signature verification, audience/issuer/expiry/nbf claim validation,
 * bounded JWKS cache, bounded fetch timeout.
 *
 * Hard rules:
 *   - `none` and any HS* (symmetric) algorithm are refused.
 *   - The verifier never logs or echoes the bearer token, even on failure.
 *   - The cache TTL is bounded by `CMS_OIDC_JWKS_CACHE_SECONDS` and the
 *     fetch is bounded by `CMS_OIDC_FETCH_TIMEOUT_MS` so a malicious or
 *     slow JWKS endpoint cannot stall the server.
 *   - Tokens are validated for `iss`, `aud`, `exp`, and (if present) `nbf`.
 *     Clock skew of 30 seconds is tolerated to match real OIDC deployments.
 *   - The verifier is a pure dependency of the server: production code
 *     always wires a real `createOidcVerifier(config.oidc)` instance.
 *     Tests may inject a custom `TokenVerifier` via `CreateServerOptions`.
 */
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyOptions,
  type JWTVerifyResult,
} from 'jose';
import {
  type Audience,
  type TokenClaims,
  type TokenVerifier,
  type VerifiedToken,
} from '@cms/api';
import { brandIso8601, type AuthorityGrant } from '@cms/core';
import type { ServerOidc } from './config.js';

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export const SERVER_AUTH_ERROR_CODES = [
  'E_TOKEN_MISSING',
  'E_TOKEN_MALFORMED',
  'E_TOKEN_BAD_SIGNATURE',
  'E_TOKEN_BAD_AUDIENCE',
  'E_TOKEN_BAD_ISSUER',
  'E_TOKEN_EXPIRED',
  'E_TOKEN_NOT_YET_VALID',
  'E_TOKEN_BAD_ALGORITHM',
  'E_OIDC_JWKS_UNAVAILABLE',
] as const;
Object.freeze(SERVER_AUTH_ERROR_CODES);

export type ServerAuthErrorCode = (typeof SERVER_AUTH_ERROR_CODES)[number];

/**
 * Closed-union error for the OIDC verifier. Never embeds the raw token.
 * `extensions` carries redacted, non-PII diagnostics suitable for
 * structured logs.
 */
export class ServerAuthError extends Error {
  public readonly code: ServerAuthErrorCode;
  public readonly extensions: Readonly<Record<string, string>>;
  constructor(
    code: ServerAuthErrorCode,
    message: string,
    extensions: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'ServerAuthError';
    this.code = code;
    this.extensions = Object.freeze({ ...extensions });
  }
}

// ---------------------------------------------------------------------------
// Claim validation
// ---------------------------------------------------------------------------

const EXPECTED_CLAIM_TYPES = Object.freeze({
  iss: 'string',
  sub: 'string',
  aud: 'string-or-array',
  exp: 'number',
  iat: 'number',
  tenantId: 'string',
  actorId: 'string',
  kind: 'string',
  scope: 'array-of-string',
  delegatorId: 'string',
  delegatedAt: 'string',
  delegatedUntil: 'string',
} as const);

function readString(payload: JWTPayload, key: keyof typeof EXPECTED_CLAIM_TYPES): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(payload: JWTPayload, key: keyof typeof EXPECTED_CLAIM_TYPES): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readScope(payload: JWTPayload): readonly string[] | undefined {
  const value = payload['scope'];
  if (typeof value === 'string') {
    return Object.freeze(
      value
        .split(/\s+/g)
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    );
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item.length > 0) out.push(item);
    }
    return Object.freeze(out);
  }
  return undefined;
}

function parseClaims(payload: JWTPayload, audience: Audience, issuer: string): TokenClaims {
  const iss = readString(payload, 'iss');
  if (iss === undefined || iss !== issuer) {
    throw new ServerAuthError(
      'E_TOKEN_BAD_ISSUER',
      'token issuer does not match the configured OIDC issuer',
      { configured: issuer },
    );
  }
  const sub = readString(payload, 'sub');
  if (sub === undefined) {
    throw new ServerAuthError(
      'E_TOKEN_MALFORMED',
      'token is missing required string claim "sub"',
    );
  }
  const rawAud = payload['aud'];
  let audOk = false;
  if (typeof rawAud === 'string') audOk = rawAud === audience;
  else if (Array.isArray(rawAud)) {
    for (const entry of rawAud) {
      if (typeof entry === 'string' && entry === audience) {
        audOk = true;
        break;
      }
    }
  }
  if (!audOk) {
    throw new ServerAuthError(
      'E_TOKEN_BAD_AUDIENCE',
      'token audience does not match the configured OIDC audience',
      { configured: audience },
    );
  }
  const exp = readNumber(payload, 'exp');
  if (exp === undefined) {
    throw new ServerAuthError(
      'E_TOKEN_MALFORMED',
      'token is missing required numeric claim "exp"',
    );
  }
  const iat = readNumber(payload, 'iat');
  if (iat === undefined) {
    throw new ServerAuthError(
      'E_TOKEN_MALFORMED',
      'token is missing required numeric claim "iat"',
    );
  }
  const tenantId = readString(payload, 'tenantId');
  if (tenantId === undefined) {
    throw new ServerAuthError(
      'E_TOKEN_MALFORMED',
      'token is missing required string claim "tenantId"',
    );
  }
  const actorId = readString(payload, 'actorId');
  if (actorId === undefined) {
    throw new ServerAuthError(
      'E_TOKEN_MALFORMED',
      'token is missing required string claim "actorId"',
    );
  }
  const kindRaw = readString(payload, 'kind');
  if (kindRaw !== 'human' && kindRaw !== 'service') {
    throw new ServerAuthError(
      'E_TOKEN_MALFORMED',
      'token claim "kind" must be "human" or "service"',
    );
  }
  const scope = readScope(payload);
  if (scope === undefined) {
    throw new ServerAuthError(
      'E_TOKEN_MALFORMED',
      'token is missing required claim "scope"',
    );
  }

  const delegatorId = readString(payload, 'delegatorId');
  const delegatedAt = readString(payload, 'delegatedAt');
  const delegatedUntil = readString(payload, 'delegatedUntil');
  return {
    iss,
    sub,
    aud: audience,
    exp,
    iat,
    tenantId,
    actorId,
    kind: kindRaw,
    scope,
    ...(delegatorId !== undefined ? { delegatorId } : {}),
    ...(delegatedAt !== undefined ? { delegatedAt: brandIso8601(delegatedAt) } : {}),
    ...(delegatedUntil !== undefined ? { delegatedUntil: brandIso8601(delegatedUntil) } : {}),
  };
}

function toAudience(oidc: ServerOidc): Audience {
  // The api brand is a phantom type: cast is intentional and local.
  return oidc.audience as Audience;
}

function tokenIdOf(payload: JWTPayload, sub: string): string {
  // Stable id for the verified token: a deterministic, non-PII fingerprint
  // based on subject + issuer + iat. The api surface expects a string.
  return `${payload['iss'] ?? 'unknown'}::${sub}::${payload['iat'] ?? 0}`;
}

// ---------------------------------------------------------------------------
// OIDC verifier
// ---------------------------------------------------------------------------

/** Clock skew tolerated for `exp` and `nbf` checks. Matches common OIDC deployments. */
const CLOCK_SKEW_SECONDS = 30;

/** Pluggable JWKS source for tests; production uses a bounded remote JWKS. */
export interface JwksSource {
  verifyJwt(token: string, options: JWTVerifyOptions): Promise<JWTVerifyResult>;
}

interface RemoteJwksSourceOptions {
  readonly jwksUrl: string;
  readonly cacheSeconds: number;
  readonly fetchTimeoutMs: number;
}

function buildRemoteJwks(options: RemoteJwksSourceOptions): JwksSource {
  const set = createRemoteJWKSet(new URL(options.jwksUrl), {
    cacheMaxAge: options.cacheSeconds * 1000,
    timeoutDuration: options.fetchTimeoutMs,
    cooldownDuration: Math.max(options.cacheSeconds * 1000, 30_000),
  });
  return {
    async verifyJwt(token, verifyOptions): Promise<JWTVerifyResult> {
      return jwtVerify(token, set, verifyOptions);
    },
  };
}

export interface OidcVerifierOptions {
  readonly oidc: ServerOidc;
  /** Optional JWKS source for tests; defaults to a bounded remote JWKS. */
  readonly jwks?: JwksSource;
  /** Injectable `Date.now` for deterministic tests. */
  readonly nowSeconds?: () => number;
}

function verificationError(cause: unknown): ServerAuthError {
  if (typeof cause === 'object' && cause !== null) {
    const code = 'code' in cause ? String(cause.code) : '';
    const claim = 'claim' in cause ? String(cause.claim) : '';
    const message = cause instanceof Error ? cause.message : '';
    if (code === 'ERR_JWT_EXPIRED') {
      return new ServerAuthError('E_TOKEN_EXPIRED', 'token has expired');
    }
    if (claim === 'nbf' || message.includes('nbf')) {
      return new ServerAuthError('E_TOKEN_NOT_YET_VALID', 'token is not yet valid');
    }
    if (code === 'ERR_JWT_CLAIM_VALIDATION' && claim === 'aud') {
      return new ServerAuthError('E_TOKEN_BAD_AUDIENCE', 'token audience does not match');
    }
    if (code === 'ERR_JWT_CLAIM_VALIDATION' && claim === 'iss') {
      return new ServerAuthError('E_TOKEN_BAD_ISSUER', 'token issuer does not match');
    }
    if (code.startsWith('ERR_JWKS_') || cause instanceof TypeError) {
      return new ServerAuthError('E_OIDC_JWKS_UNAVAILABLE', 'OIDC JWKS is unavailable');
    }
  }
  return new ServerAuthError(
    'E_TOKEN_BAD_SIGNATURE',
    cause instanceof Error ? cause.message : 'JWS verification failed',
  );
}

/**
 * Build an OIDC verifier. The returned function matches `@cms/api`'s
 * `TokenVerifier` contract: present the raw `Authorization` header, get a
 * `VerifiedToken` or throw a `ServerAuthError`.
 *
 * Algorithm policy: only asymmetric RS/ES/PS variants listed in
 * `oidc.algorithms` are accepted. `none` and any HS* variant are refused
 * regardless of configuration — symmetric secrets in production are
 * incompatible with a self-hosted control plane.
 */
export function createOidcVerifier(
  options: OidcVerifierOptions,
): TokenVerifier {
  const { oidc } = options;
  const audience = toAudience(oidc);
  const allowedAlgorithms = new Set<string>(oidc.algorithms);

  const jwks = options.jwks ?? buildRemoteJwks({
    jwksUrl: oidc.jwksUrl,
    cacheSeconds: oidc.jwksCacheSeconds,
    fetchTimeoutMs: oidc.fetchTimeoutMs,
  });

  const nowSeconds = options.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));

  async function verifyInner(authorizationHeader: string): Promise<VerifiedToken> {
    const token = stripBearer(authorizationHeader);
    if (token === null) {
      throw new ServerAuthError(
        'E_TOKEN_MISSING',
        'Authorization header is missing or not a Bearer credential',
      );
    }

    let header: { alg?: unknown };
    try {
      header = decodeProtectedHeader(token);
    } catch (cause) {
      throw new ServerAuthError(
        'E_TOKEN_MALFORMED',
        cause instanceof Error ? cause.message : 'token header is not a JOSE header',
      );
    }
    const alg = typeof header.alg === 'string' ? header.alg : '';
    if (alg === '' || alg.toLowerCase() === 'none' || alg.startsWith('HS')) {
      throw new ServerAuthError(
        'E_TOKEN_BAD_ALGORITHM',
        'token uses a refused algorithm (none or symmetric)',
        { rejected: alg },
      );
    }
    if (!allowedAlgorithms.has(alg)) {
      throw new ServerAuthError(
        'E_TOKEN_BAD_ALGORITHM',
        'token algorithm is not in the configured allow-list',
        { rejected: alg, allowed: [...allowedAlgorithms].join(',') },
      );
    }

    let verified: JWTVerifyResult | undefined;
    try {
      verified = await jwks.verifyJwt(token, {
        algorithms: [...allowedAlgorithms],
        audience,
        issuer: oidc.issuer,
        clockTolerance: CLOCK_SKEW_SECONDS,
      });
    } catch (cause) {
      if (cause instanceof ServerAuthError) {
        // Re-raise with the jose error attached for operator diagnostics.
        throw new ServerAuthError(cause.code, cause.message, cause.extensions);
      }
      throw verificationError(cause);
    }
    if (verified === undefined) {
      throw new ServerAuthError(
        'E_TOKEN_BAD_SIGNATURE',
        'JWS verification returned no result',
      );
    }

    const payload = verified.payload;
    const exp = typeof payload.exp === 'number' ? payload.exp : Number.NaN;
    const current = nowSeconds();
    if (Number.isFinite(exp) && exp <= current - CLOCK_SKEW_SECONDS) {
      throw new ServerAuthError(
        'E_TOKEN_EXPIRED',
        'token has expired',
      );
    }
    if (typeof payload.nbf === 'number' && payload.nbf > current + CLOCK_SKEW_SECONDS) {
      throw new ServerAuthError(
        'E_TOKEN_NOT_YET_VALID',
        'token is not yet valid (nbf in the future)',
      );
    }

    const claims = parseClaims(payload, audience, oidc.issuer);
    const sub = typeof payload.sub === 'string' ? payload.sub : claims.sub;
    return Object.freeze({
      claims,
      tokenId: tokenIdOf(payload, sub),
    });
  }

  return Object.freeze({
    verify(authorizationHeader: string, expectedAudience: Audience): Promise<VerifiedToken> {
      if (expectedAudience !== audience) {
        return Promise.reject(new ServerAuthError(
          'E_TOKEN_BAD_AUDIENCE',
          'requested audience does not match the configured OIDC audience',
          { configured: audience },
        ));
      }
      return verifyInner(authorizationHeader);
    },
  });
}

function stripBearer(header: string): string | null {
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split(/\s+/g, 2);
  if (parts.length !== 2) return null;
  if (parts[0] !== 'Bearer' && parts[0] !== 'bearer') return null;
  const token = parts[1];
  if (token === undefined || token.length === 0) return null;
  return token;
}

// ---------------------------------------------------------------------------
// Identity resolver backed by PostgresStorage
// ---------------------------------------------------------------------------


import type { Storage } from '@cms/storage';
import type { IdentityResolver, ResolvedActorKind } from '@cms/api';

/**
 * Build a tenant-scoped `IdentityResolver` over canonical storage. Actor kind,
 * enabled/verified status, declared authority grants, and proposal authorship
 * all come from the same tenant-bound database contract. Agent and service
 * rows map to service authority; only enabled, verified human rows can supply
 * grants. Malformed grant entries are ignored so authorization fails closed.
 * The resolver never logs actor ids or grant contents.
 */

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return Object.freeze([...value] as string[]);
}

function authorityGrants(value: unknown, actorId: string): readonly AuthorityGrant[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const grants: AuthorityGrant[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const row = candidate as Record<string, unknown>;
    const roles = stringArray(row['roles']);
    const contentTypes = stringArray(row['contentTypes']);
    const environments = stringArray(row['environments']);
    const capabilities = stringArray(row['capabilities']);
    const notBefore = row['notBefore'];
    const notAfter = row['notAfter'];
    if (
      roles === null || contentTypes === null || environments === null || capabilities === null
      || environments.some((entry) => entry !== 'staging' && entry !== 'production')
      || typeof notBefore !== 'string' || typeof notAfter !== 'string'
    ) continue;
    grants.push(Object.freeze({
      identityId: actorId,
      roles,
      contentTypes,
      environments: environments as readonly ('staging' | 'production')[],
      capabilities,
      notBefore,
      notAfter,
    }));
  }
  return Object.freeze(grants);
}

export function createStorageIdentityResolver(
  storage: Pick<Storage, 'getActorById' | 'getProposalById'>,
): IdentityResolver {
  const resolver: IdentityResolver = {
    async resolveActorKind(claims: TokenClaims): Promise<ResolvedActorKind | null> {
      const actor = await storage.getActorById(claims.tenantId, claims.actorId);
      if (actor === null) return null;
      if (actor.kind === 'human') return 'human';
      if (actor.kind === 'agent' || actor.kind === 'service') return 'service';
      return null;
    },
    async loadGrants(tenantId: string, actorId: string) {
      const actor = await storage.getActorById(tenantId, actorId);
      if (actor === null || actor.disabledAt !== null || !actor.verified || actor.kind !== 'human') {
        return Object.freeze([]);
      }
      return authorityGrants(actor.declaredCapabilities['authorityGrants'], actorId);
    },
    async loadProposerId(tenantId: string, proposalId: string): Promise<string | null> {
      const proposal = await storage.getProposalById(tenantId, proposalId);
      return proposal?.proposedByActorId ?? null;
    },
    async loadActorProfile(actorId: string, claims: TokenClaims) {
      const actor = await storage.getActorById(claims.tenantId, actorId);
      const displayName = actor?.displayName ?? actorId;
      const capabilities = extractCapabilities(actor);
      return Object.freeze({
        displayName,
        capabilities,
      });
    },
  };
  return Object.freeze(resolver);
}

function extractCapabilities(actor: Awaited<ReturnType<Storage['getActorById']>>): readonly string[] {
  if (actor === null) return Object.freeze([]);
  const declared = actor.declaredCapabilities;
  if (Array.isArray(declared)) {
    const out: string[] = [];
    for (const item of declared) {
      if (typeof item === 'string' && item.length > 0) out.push(item);
    }
    return Object.freeze(out);
  }
  if (declared && typeof declared === 'object') {
    const out: string[] = [];
    for (const [key, value] of Object.entries(declared)) {
      if (value === true) out.push(key);
    }
    return Object.freeze(out);
  }
  return Object.freeze([]);
}