import { describe, expect, it } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JWTVerifyOptions,
} from 'jose';
import type { Audience, TokenClaims } from '@cms/api';
import type { Storage } from '@cms/storage';
import { createOidcVerifier, createStorageIdentityResolver, type JwksSource } from '../src/auth.js';
import type { ServerOidc } from '../src/config.js';

const NOW = 1_800_000_000;
const AUDIENCE = 'https://cms.example/api' as Audience;

function oidc(): ServerOidc {
  return Object.freeze({
    issuer: 'https://issuer.example',
    audience: AUDIENCE,
    jwksUrl: 'https://issuer.example/.well-known/jwks.json',
    algorithms: Object.freeze(['RS256']),
    jwksCacheSeconds: 300,
    fetchTimeoutMs: 1_000,
  });
}

async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const local = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
  const jwks: JwksSource = {
    verifyJwt(token: string, options: JWTVerifyOptions) {
      return jwtVerify(token, local, options);
    },
  };
  const sign = (overrides: Record<string, unknown> = {}) => {
    const { exp, nbf, ...customClaims } = overrides;
    let jwt = new SignJWT({
      tenantId: 'tenant-1',
      actorId: 'actor-1',
      kind: 'human',
      scope: ['content:read'],
      ...customClaims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://issuer.example')
      .setAudience(AUDIENCE)
      .setSubject('actor-1')
      .setIssuedAt(NOW - 10)
      .setExpirationTime(typeof exp === 'number' ? exp : NOW + 300);
    if (typeof nbf === 'number') jwt = jwt.setNotBefore(nbf);
    return jwt.sign(privateKey);
  };
  return { jwks, sign };
}

describe('createOidcVerifier', () => {
  it('verifies an asymmetric audience-bound token', async () => {
    const { jwks, sign } = await fixture();
    const verifier = createOidcVerifier({ oidc: oidc(), jwks, nowSeconds: () => NOW });
    const token = await sign();
    const verified = await verifier.verify(`Bearer ${token}`, AUDIENCE);
    expect(verified.claims.tenantId).toBe('tenant-1');
    expect(verified.claims.actorId).toBe('actor-1');
  });

  it('rejects the wrong expected audience before verification', async () => {
    const { jwks, sign } = await fixture();
    const verifier = createOidcVerifier({ oidc: oidc(), jwks, nowSeconds: () => NOW });
    const token = await sign();
    await expect(verifier.verify(`Bearer ${token}`, 'https://other.example' as Audience))
      .rejects.toMatchObject({ code: 'E_TOKEN_BAD_AUDIENCE' });
  });

  it('rejects expired and future-nbf credentials', async () => {
    const { jwks, sign } = await fixture();
    const verifier = createOidcVerifier({ oidc: oidc(), jwks, nowSeconds: () => NOW });
    await expect(verifier.verify(`Bearer ${await sign({ exp: NOW - 60 })}`, AUDIENCE))
      .rejects.toMatchObject({ code: 'E_TOKEN_EXPIRED' });
    await expect(verifier.verify(`Bearer ${await sign({ nbf: NOW + 120 })}`, AUDIENCE))
      .rejects.toMatchObject({ code: 'E_TOKEN_NOT_YET_VALID' });
  });

  it('rejects symmetric and unsigned algorithm headers without calling JWKS', async () => {
    let calls = 0;
    const jwks: JwksSource = {
      async verifyJwt() {
        calls += 1;
        throw new Error('must not run');
      },
    };
    const verifier = createOidcVerifier({ oidc: oidc(), jwks, nowSeconds: () => NOW });
    const hsHeader = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    await expect(verifier.verify(`Bearer ${hsHeader}.e30.signature`, AUDIENCE))
      .rejects.toMatchObject({ code: 'E_TOKEN_BAD_ALGORITHM' });
    await expect(verifier.verify(`Bearer ${noneHeader}.e30.`, AUDIENCE))
      .rejects.toMatchObject({ code: 'E_TOKEN_BAD_ALGORITHM' });
    expect(calls).toBe(0);
  });

  it('never includes the raw bearer token in an error', async () => {
    const { jwks } = await fixture();
    const verifier = createOidcVerifier({ oidc: oidc(), jwks, nowSeconds: () => NOW });
    const secretToken = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImJhZCJ9.e30.secret-signature';
    let message = '';
    try {
      await verifier.verify(`Bearer ${secretToken}`, AUDIENCE);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secretToken);
  });

  it('reports JWKS infrastructure failures truthfully', async () => {
    const { sign } = await fixture();
    const unavailable: JwksSource = {
      async verifyJwt() {
        throw Object.assign(new Error('JWKS request timed out'), { code: 'ERR_JWKS_TIMEOUT' });
      },
    };
    const verifier = createOidcVerifier({ oidc: oidc(), jwks: unavailable, nowSeconds: () => NOW });
    await expect(verifier.verify(`Bearer ${await sign()}`, AUDIENCE))
      .rejects.toMatchObject({ code: 'E_OIDC_JWKS_UNAVAILABLE' });
  });
});

describe('storage identity mapping', () => {
  const claims = {
    tenantId: 'tenant-1',
    actorId: 'actor-1',
  } as TokenClaims;

  it.each([
    ['human', 'human'],
    ['agent', 'service'],
    ['service', 'service'],
  ] as const)('maps %s storage actors to %s API authority', async (kind, expected) => {
    const fakeStorage = {
      async getActorById() {
        return { kind };
      },
    } as unknown as Pick<Storage, 'getActorById'>;
    const resolver = createStorageIdentityResolver(fakeStorage);
    await expect(resolver.resolveActorKind(claims)).resolves.toBe(expected);
  });

  it('loads tenant-scoped grants and proposer identity for human governance', async () => {
    const fakeStorage = {
      async getActorById(tenantId: string, actorId: string) {
        return {
          id: actorId,
          tenantId,
          kind: 'human',
          verified: true,
          disabledAt: null,
          declaredCapabilities: {
            authorityGrants: [{
              roles: ['editor'],
              contentTypes: ['post'],
              environments: ['production'],
              capabilities: ['approve', 'publish', 'rollback'],
              notBefore: '2026-01-01T00:00:00.000Z',
              notAfter: '2027-01-01T00:00:00.000Z',
            }],
          },
        };
      },
      async getProposalById(tenantId: string, proposalId: string) {
        return { id: proposalId, tenantId, proposedByActorId: 'author-1' };
      },
    } as unknown as Pick<Storage, 'getActorById' | 'getProposalById'>;
    const resolver = createStorageIdentityResolver(fakeStorage);
    const grants = await resolver.loadGrants('tenant-1', 'human-1');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      identityId: 'human-1',
      capabilities: ['approve', 'publish', 'rollback'],
    });
    await expect(resolver.loadProposerId('tenant-1', 'proposal-1')).resolves.toBe('author-1');
  });
});
