import { describe, expect, it } from 'vitest';
import type { AuthorityGrant, ContentProposal, Identity } from '@cms/core';
import {
  AuthorizationError,
  authenticate,
  authorize,
  requireHumanAuthority,
  type Audience,
  type IdentityResolver,
  type TokenClaims,
  type TokenVerifier,
} from '../src/index.js';

const audience = 'https://cms.example.test' as Audience;
const nowSeconds = 1_785_139_200;
const nowIso = '2026-07-27T12:00:00.000Z';

function claims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return {
    iss: 'https://issuer.example.test',
    sub: 'human-1',
    aud: audience,
    exp: nowSeconds + 300,
    iat: nowSeconds - 30,
    tenantId: 'tenant-1',
    actorId: 'human-1',
    kind: 'human',
    scope: ['propose'],
    ...overrides,
  };
}

function proposal(createdBy: Identity): ContentProposal {
  return {
    id: 'proposal-1',
    tenantId: 'tenant-1',
    kind: 'content',
    contentType: 'post',
    environment: 'staging',
    action: 'update',
    createdBy,
    createdAt: nowIso as ContentProposal['createdAt'],
    draft: false,
    payload: {
      localizedTitle: { en: 'Title', es: 'Título' },
      localizedBody: { en: 'Body', es: 'Cuerpo' },
      canonicalRepoPath: 'content/post.json',
    },
  };
}

function grant(actorId: string, capabilities: readonly string[]): AuthorityGrant {
  return {
    identityId: actorId,
    roles: ['author', 'approver', 'publisher', 'operator'],
    contentTypes: ['post'],
    environments: ['staging'],
    capabilities,
    notBefore: '2026-07-27T11:00:00.000Z',
    notAfter: '2026-07-27T13:00:00.000Z',
  };
}

function resolver(options: {
  kind?: 'human' | 'agent' | 'service';
  proposerId?: string | null;
  capabilities?: readonly string[];
  grants?: readonly AuthorityGrant[];
} = {}): IdentityResolver {
  return {
    async resolveActorKind() {
      return options.kind ?? 'human';
    },
    async loadGrants() {
      return options.grants ?? [];
    },
    async loadProposerId() {
      return options.proposerId ?? 'human-1';
    },
    async loadActorProfile() {
      return { displayName: 'Client editor', capabilities: options.capabilities ?? [] };
    },
  };
}

function verifier(tokenClaims: TokenClaims): TokenVerifier {
  return {
    verify() {
      return { claims: tokenClaims, tokenId: 'token-1' };
    },
  };
}

async function auth(tokenClaims: TokenClaims, identityResolver = resolver()) {
  return authenticate({
    authorizationHeader: 'Bearer test',
    expectedAudience: audience,
    requestedTenantId: 'tenant-1',
    locale: 'en',
    identityResolver,
    tokenVerifier: verifier(tokenClaims),
    nowSeconds,
  });
}

describe('authentication boundaries', () => {
  it('rejects an audience mismatch', async () => {
    await expect(auth(claims({ aud: 'https://other.example.test' as Audience }))).rejects.toMatchObject({
      code: 'E_TOKEN_AUDIENCE_MISMATCH',
    });
  });

  it('rejects expired credentials', async () => {
    await expect(auth(claims({ exp: nowSeconds }))).rejects.toMatchObject({ code: 'E_TOKEN_EXPIRED' });
  });

  it('rejects cross-tenant use', async () => {
    await expect(auth(claims({ tenantId: 'tenant-2' }))).rejects.toMatchObject({
      code: 'E_TENANT_FORBIDDEN',
    });
  });

  it('carries only allowlisted token scopes into the resolved identity', async () => {
    const context = await auth(claims({ scope: ['mcp', 'deploy.receipt', 'propose', 'self_approve'] }));
    expect(context.identity.capabilities).toContain('mcp');
    expect(context.identity.capabilities).toContain('deploy.receipt');
    expect(context.identity.capabilities).not.toContain('propose');
    expect(context.identity.capabilities).not.toContain('self_approve');
    expect(() => requireHumanAuthority({ action: 'approve', identity: context.identity })).toThrowError(
      expect.objectContaining({ code: 'E_MCP_APPROVAL_FORBIDDEN' }),
    );
  });

  it('hard-refuses service identities for approve, publish, and rollback', async () => {
    const context = await auth(
      claims({ kind: 'service', actorId: 'service-1', sub: 'service-1' }),
      resolver({ kind: 'service' }),
    );
    for (const action of ['approve', 'publish', 'rollback'] as const) {
      expect(() => requireHumanAuthority({ action, identity: context.identity })).toThrowError(
        expect.objectContaining({ code: 'E_SERVICE_APPROVAL_FORBIDDEN' }),
      );
    }
  });
});

describe('current policy authorization', () => {
  const actor: Identity = {
    kind: 'actor',
    id: 'human-1',
    displayName: 'Client editor',
    capabilities: [],
  };

  it('authorizes proposal creation without requiring a persisted proposer row first', async () => {
    const identityResolver = resolver({
      proposerId: null,
      grants: [grant('human-1', ['content.post', 'propose'])],
    });
    const decision = await authorize(
      { action: 'propose', identity: actor, proposal: proposal(actor), nowIso },
      { identityResolver },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.selfApproved).toBe(true);
  });

  it('denies same-human approval by default', async () => {
    const identityResolver = resolver({
      proposerId: 'human-1',
      grants: [grant('human-1', ['content.post', 'approve'])],
    });
    await expect(
      authorize(
        { action: 'approve', identity: actor, proposal: proposal(actor), nowIso },
        { identityResolver },
      ),
    ).rejects.toMatchObject({ code: 'E_SELF_APPROVAL_FORBIDDEN' });
  });

  it('allows a separate explicit approval when current policy grants self_approve and records it', async () => {
    const identityResolver = resolver({
      proposerId: 'human-1',
      grants: [grant('human-1', ['content.post', 'approve', 'self_approve'])],
    });
    const decision = await authorize(
      { action: 'approve', identity: actor, proposal: proposal(actor), nowIso },
      { identityResolver },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.selfApproved).toBe(true);
  });

  it('does not turn authorization failures into permissive fallbacks', async () => {
    const identityResolver = resolver({ proposerId: 'human-2', grants: [] });
    await expect(
      authorize(
        { action: 'rollback', identity: actor, proposal: proposal(actor), nowIso },
        { identityResolver },
      ),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      authorize(
        { action: 'rollback', identity: actor, proposal: proposal(actor), nowIso },
        { identityResolver },
      ),
    ).rejects.toSatisfy((error: unknown) =>
      error instanceof AuthorizationError || (error instanceof Error && error.name === 'PolicyDeniedError'),
    );
  });
});
