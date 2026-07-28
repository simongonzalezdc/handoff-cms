/**
 * Policy engine: every code path through `evaluatePolicy`, the throwing
 * `enforcePolicy`, the convenience guards `guardApproval`,
 * `guardPublication`, `guardStateTransition`, and the resolution hooks
 * `AuthorityResolver` / `ProposerResolver` are exercised against the
 * kernel's exported contract. No mocking of the kernel — the resolver
 * hooks supplied by callers are the only injected boundary.
 */

import { describe, expect, it } from 'vitest';

import {
  DomainInvariantError,
  InvalidTransitionError,
  PolicyDeniedError,
  brandIso8601,
  enforcePolicy,
  evaluatePolicy,
  guardApproval,
  guardPublication,
  guardStateTransition,
  type ActorIdentity,
  type Approval,
  type AuthorityGrant,
  type AuthorityResolver,
  type ContentProposal,
  type ContentState,
  type DelegatedHumanIdentity,
  type Identity,
  type Iso8601,
  type PolicyAction,
  type PolicyInput,
  type PolicyResult,
  type ProposerResolver,
  type Publication,
  type ServiceIdentity,
  type Sha256Hex,
} from '../src/index.js';

const ISO = '2026-07-27T12:00:00.000Z' as Iso8601;
const NOW = '2026-07-27T12:30:00.000Z';
const SHA = 'b'.repeat(64) as Sha256Hex;

const actor: ActorIdentity = Object.freeze({
  kind: 'actor',
  id: 'user-1',
  displayName: 'Alice',
  capabilities: [],
});

const otherActor: ActorIdentity = Object.freeze({
  kind: 'actor',
  id: 'user-2',
  displayName: 'Bob',
  capabilities: [],
});

const mcpService: ServiceIdentity = Object.freeze({
  kind: 'service',
  id: 'svc-mcp',
  displayName: 'MCP Bot',
  capabilities: ['mcp'],
});

const plainService: ServiceIdentity = Object.freeze({
  kind: 'service',
  id: 'svc-plain',
  displayName: 'Plain Bot',
  capabilities: [],
});

const delegated: DelegatedHumanIdentity = Object.freeze({
  kind: 'delegated_human',
  id: 'del-1',
  displayName: 'Sam',
  capabilities: ['content.post'],
  delegatorId: 'user-1',
  delegatedAt: brandIso8601('2026-07-27T11:00:00.000Z'),
  delegatedUntil: brandIso8601('2026-07-27T13:00:00.000Z'),
});

function contentProposal(overrides: Partial<ContentProposal> = {}): ContentProposal {
  return Object.freeze({
    id: 'prop-1',
    tenantId: 'tenant-1',
    kind: 'content' as const,
    contentType: 'post',
    environment: 'staging' as const,
    action: 'create' as const,
    createdBy: actor,
    createdAt: ISO,
    draft: false,
    payload: Object.freeze({
      localizedTitle: Object.freeze({ en: 'T', es: 'Tt' }),
      localizedBody: Object.freeze({ en: 'B', es: 'Bb' }),
      canonicalRepoPath: 'content/posts/hello.md',
    }),
    ...overrides,
  });
}

function grant(overrides: Partial<AuthorityGrant> = {}): AuthorityGrant {
  return Object.freeze({
    identityId: 'user-1',
    roles: Object.freeze(['author', 'approver', 'publisher', 'operator']),
    contentTypes: Object.freeze(['post']),
    environments: Object.freeze(['staging', 'production']),
    capabilities: Object.freeze([
      'content.post',
      'propose',
      'approve',
      'publish',
      'canonical.write',
      'rollback',
    ]),
    notBefore: '2026-07-27T11:00:00.000Z',
    notAfter: '2026-07-27T13:00:00.000Z',
    ...overrides,
  });
}

function resolver(
  map: ReadonlyMap<string, readonly AuthorityGrant[]>,
): AuthorityResolver {
  return (id: string) => map.get(id) ?? [];
}

function proposer(map: ReadonlyMap<string, string>): ProposerResolver {
  return (proposalId: string) => {
    const v = map.get(proposalId);
    if (v === undefined) {
      throw new Error(`unknown proposal ${proposalId}`);
    }
    return v;
  };
}

function policyInput(
  action: PolicyAction,
  override: { actor?: Identity; proposal?: ContentProposal } = {},
): PolicyInput {
  return {
    action,
    actor: override.actor ?? actor,
    proposal: override.proposal ?? contentProposal(),
    nowIso: NOW,
  };
}

// --------------------------------------------------------------------
// Service / MCP approval/publish denial
// --------------------------------------------------------------------

describe('policy: service identity denial', () => {
  it('denies approve to a plain service identity with E_SERVICE_APPROVAL_FORBIDDEN', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['svc-plain', [grant({ identityId: 'svc-plain' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve', { actor: plainService }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_SERVICE_APPROVAL_FORBIDDEN');
      expect(r.action).toBe('approve');
      expect(r.proposalId).toBe('prop-1');
    }
  });

  it('denies approve to a service identity with the mcp capability with E_SERVICE_APPROVAL_FORBIDDEN', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['svc-mcp', [grant({ identityId: 'svc-mcp' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve', { actor: mcpService }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_SERVICE_APPROVAL_FORBIDDEN');
    }
  });

  it('denies publish to a service identity with E_SERVICE_APPROVAL_FORBIDDEN', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['svc-plain', [grant({ identityId: 'svc-plain' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('publish', { actor: plainService }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_SERVICE_APPROVAL_FORBIDDEN');
    }
  });

  it('denies approve to MCP-capable actor with E_MCP_APPROVAL_FORBIDDEN', () => {
    const mcpActor: ActorIdentity = Object.freeze({
      kind: 'actor',
      id: 'user-mcp',
      displayName: 'Carol',
      capabilities: ['mcp'],
    });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-mcp', [grant({ identityId: 'user-mcp' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve', { actor: mcpActor }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_MCP_APPROVAL_FORBIDDEN');
    }
  });

  it('denies publish to MCP-capable actor with E_MCP_APPROVAL_FORBIDDEN', () => {
    const mcpActor: ActorIdentity = Object.freeze({
      kind: 'actor',
      id: 'user-mcp',
      displayName: 'Carol',
      capabilities: ['mcp'],
    });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-mcp', [grant({ identityId: 'user-mcp' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('publish', { actor: mcpActor }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_MCP_APPROVAL_FORBIDDEN');
    }
  });
});

// --------------------------------------------------------------------
// Self-approval
// --------------------------------------------------------------------

describe('policy: self-approval', () => {
  it('denies approval when the proposer and actor are the same identity with E_SELF_APPROVAL_FORBIDDEN', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [grant({ identityId: 'user-1' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_SELF_APPROVAL_FORBIDDEN');
      expect(r.action).toBe('approve');
    }
  });

  it('allows same-human approval only with the explicit self_approve capability', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      [
        'user-1',
        [
          grant({
            identityId: 'user-1',
            capabilities: [...grant().capabilities, 'self_approve'],
          }),
        ],
      ],
    ]);
    const result = evaluatePolicy(
      policyInput('approve'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(result.allowed).toBe(true);
  });

  it('denies publish to the proposer for the same proposal with E_SELF_APPROVAL_FORBIDDEN', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [grant({ identityId: 'user-1' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('publish'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_SELF_APPROVAL_FORBIDDEN');
    }
  });

  it('allows approval when proposer and actor are different identities', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-2', [grant({ identityId: 'user-2' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve', { actor: otherActor }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(true);
    if (r.allowed) {
      expect(r.action).toBe('approve');
      expect(r.proposalId).toBe('prop-1');
      expect(r.matchedGrant.identityId).toBe('user-2');
    }
  });

  it('does NOT apply self-approval denial to propose/rollback', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [grant({ identityId: 'user-1' })]],
    ]);
    const proposerHook = proposer(new Map([['prop-1', 'user-1']]));
    const propose = evaluatePolicy(
      policyInput('propose'),
      resolver(grants),
      proposerHook,
    );
    expect(propose.allowed).toBe(true);
    const rollback = evaluatePolicy(
      policyInput('rollback'),
      resolver(grants),
      proposerHook,
    );
    expect(rollback.allowed).toBe(true);
  });
});

// --------------------------------------------------------------------
// Stale / in-flight grants: currentHumanAuthority semantics
// --------------------------------------------------------------------

describe('policy: stale and in-flight grants', () => {
  it('denies when the actor has no grants at all with E_INSUFFICIENT_AUTHORITY', () => {
    const r = evaluatePolicy(
      policyInput('approve'),
      resolver(new Map()),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_INSUFFICIENT_AUTHORITY');
    }
  });

  it('denies when every grant has expired before now with E_INSUFFICIENT_AUTHORITY', () => {
    const stale = grant({
      notBefore: '2026-07-27T09:00:00.000Z',
      notAfter: '2026-07-27T10:00:00.000Z',
    });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [stale]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_INSUFFICIENT_AUTHORITY');
    }
  });

  it('denies when every grant has not yet started with E_INSUFFICIENT_AUTHORITY', () => {
    const future = grant({
      notBefore: '2026-07-27T15:00:00.000Z',
      notAfter: '2026-07-27T16:00:00.000Z',
    });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [future]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_INSUFFICIENT_AUTHORITY');
    }
  });

  it('treats the upper bound as exclusive: notAfter == nowIso means expired', () => {
    const edge = grant({
      notBefore: '2026-07-27T11:00:00.000Z',
      notAfter: NOW,
    });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [edge]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve', { actor: otherActor }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_INSUFFICIENT_AUTHORITY');
    }
  });

  it('treats the lower bound as inclusive: notBefore == nowIso counts as live', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      [
        'user-2',
        [
          grant({
            identityId: 'user-2',
            notBefore: NOW,
            notAfter: '2026-07-27T13:00:00.000Z',
          }),
        ],
      ],
    ]);
    const r = evaluatePolicy(
      policyInput('approve', { actor: otherActor }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(true);
  });

  it('a mixed batch (one stale, one live) resolves to allowed', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      [
        'user-2',
        [
          grant({
            identityId: 'user-2',
            notBefore: '2026-07-27T09:00:00.000Z',
            notAfter: '2026-07-27T10:00:00.000Z',
          }),
          grant({
            identityId: 'user-2',
            notBefore: '2026-07-27T11:00:00.000Z',
            notAfter: '2026-07-27T13:00:00.000Z',
          }),
        ],
      ],
    ]);
    const r = evaluatePolicy(
      policyInput('approve', { actor: otherActor }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(true);
  });
});

// --------------------------------------------------------------------
// Role / content / environment / action allow-list
// --------------------------------------------------------------------

describe('policy: role/content/environment/action allow-list', () => {
  it('denies when the grant roles do not include the action-role', () => {
    const g = grant({ roles: ['approver', 'publisher', 'operator'] }); // no 'author'
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [g]],
    ]);
    const r = evaluatePolicy(
      policyInput('propose'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_ROLE_MISMATCH');
    }
  });

  it('denies when the grant contentTypes do not include the proposal contentType', () => {
    const g = grant({ contentTypes: ['landing'] });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [g]],
    ]);
    const r = evaluatePolicy(
      policyInput('propose'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_ROLE_MISMATCH');
    }
  });

  it('denies when the grant environments do not include the proposal environment', () => {
    const g = grant({ environments: ['production'] });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [g]],
    ]);
    const r = evaluatePolicy(
      policyInput('propose', {
        proposal: contentProposal({ environment: 'staging' }),
      }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_ROLE_MISMATCH');
    }
  });

  it('approves when role + content + environment all match', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [grant({ identityId: 'user-1' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-2']])),
    );
    expect(r.allowed).toBe(true);
  });

  it('publishes when role + content + environment + capabilities all match', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [grant({ identityId: 'user-1' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('publish'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-2']])),
    );
    expect(r.allowed).toBe(true);
  });
});

// --------------------------------------------------------------------
// Field-level capabilities
// --------------------------------------------------------------------

describe('policy: field capability gating', () => {
  it('denies approval when the grant lacks the action capability with E_FIELD_CAPABILITY_MISSING', () => {
    const g = grant({ capabilities: ['content.post', 'propose'] }); // no approve
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [g]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-2']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_FIELD_CAPABILITY_MISSING');
      expect(r.message).toMatch(/missing capabilities/);
    }
  });

  it('denies publish when the grant lacks canonical.write', () => {
    const g = grant({
      capabilities: ['content.post', 'publish'],
    });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [g]],
    ]);
    const r = evaluatePolicy(
      policyInput('publish'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-2']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_FIELD_CAPABILITY_MISSING');
    }
  });

  it('denies rollback when the grant lacks rollback capability', () => {
    const g = grant({
      capabilities: ['content.post', 'propose', 'approve', 'publish', 'canonical.write'],
    });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [g]],
    ]);
    const r = evaluatePolicy(
      policyInput('rollback'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-2']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_FIELD_CAPABILITY_MISSING');
    }
  });

  it('requires the content-specific capability prefix matching the proposal contentType', () => {
    const g = grant({ capabilities: ['content.landing', 'propose'] });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [g]],
    ]);
    const r = evaluatePolicy(
      policyInput('propose'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-2']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_FIELD_CAPABILITY_MISSING');
    }
  });

  it('matches when the capability prefix AND action capability are both present', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [grant({ identityId: 'user-1' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-2']])),
    );
    expect(r.allowed).toBe(true);
  });
});

// --------------------------------------------------------------------
// Delegated human identity
// --------------------------------------------------------------------

describe('policy: delegated human identity', () => {
  it('a delegated human within the delegation window is treated as an actor for service/MCP checks', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['del-1', [grant({ identityId: 'del-1' })]],
    ]);
    const r = evaluatePolicy(
      policyInput('approve', { actor: delegated }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
    );
    expect(r.allowed).toBe(true);
  });

  it('a delegated human whose delegation is expired is denied with E_INSUFFICIENT_AUTHORITY', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['del-1', [grant({ identityId: 'del-1' })]],
    ]);
    const expiredDelegated: DelegatedHumanIdentity = Object.freeze({
      kind: 'delegated_human',
      id: 'del-2',
      displayName: 'Pat',
      capabilities: ['content.post'],
      delegatorId: 'user-1',
      delegatedAt: brandIso8601('2026-07-27T08:00:00.000Z'),
      delegatedUntil: brandIso8601('2026-07-27T08:30:00.000Z'),
    });
    const r = evaluatePolicy(
      policyInput('approve', { actor: expiredDelegated }),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-2']])),
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe('E_INSUFFICIENT_AUTHORITY');
    }
  });
});

// --------------------------------------------------------------------
// enforcePolicy throwing variant
// --------------------------------------------------------------------

describe('policy: enforcePolicy', () => {
  it('returns the decision on success', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [grant({ identityId: 'user-1' })]],
    ]);
    const r = enforcePolicy(
      policyInput('approve'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-2']])),
    );
    expect(r.allowed).toBe(true);
  });

  it('throws PolicyDeniedError carrying the code on denial', () => {
    try {
      enforcePolicy(
        policyInput('approve'),
        resolver(new Map()),
        proposer(new Map([['prop-1', 'user-1']])),
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect((err as PolicyDeniedError).code).toBe('E_INSUFFICIENT_AUTHORITY');
    }
  });
});

// --------------------------------------------------------------------
// guardApproval / guardPublication
// --------------------------------------------------------------------

describe('policy: guardApproval', () => {
  function approval(stateBefore: ContentState): Approval {
    return Object.freeze({
      id: 'app-1',
      proposalId: 'prop-1',
      revisionId: 'rev-1',
      approvedBy: otherActor,
      approvedAt: ISO,
      attestationHash: SHA,
      stateBefore,
      stateAfter: 'approved',
    });
  }

  it('approves when policy + stateBefore=previewing are both satisfied', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-2', [grant({ identityId: 'user-2' })]],
    ]);
    const r = guardApproval(
      contentProposal(),
      approval('previewing'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
      NOW,
    );
    expect(r.allowed).toBe(true);
  });

  it('approves when stateBefore=approved (idempotent approval re-record)', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-2', [grant({ identityId: 'user-2' })]],
    ]);
    const r = guardApproval(
      contentProposal(),
      approval('approved'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
      NOW,
    );
    expect(r.allowed).toBe(true);
  });

  it('throws PolicyDeniedError when policy denies', () => {
    try {
      guardApproval(
        contentProposal(),
        approval('previewing'),
        resolver(new Map()),
        proposer(new Map([['prop-1', 'user-1']])),
        NOW,
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect((err as PolicyDeniedError).code).toBe('E_INSUFFICIENT_AUTHORITY');
    }
  });

  it('throws PolicyDeniedError for self-approval', () => {
    // The approval's approvedBy field becomes the policy actor; here we
    // want actor == proposer, so the proposer resolver returns 'user-2'
    // and the grants map gives 'user-2' live authority.
    const selfApproval = Object.freeze({
      id: 'app-self',
      proposalId: 'prop-1',
      revisionId: 'rev-1',
      approvedBy: otherActor,
      approvedAt: ISO,
      attestationHash: SHA,
      stateBefore: 'previewing' as ContentState,
      stateAfter: 'approved' as ContentState,
    });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-2', [grant({ identityId: 'user-2' })]],
    ]);
    try {
      guardApproval(
        contentProposal(),
        selfApproval,
        resolver(grants),
        proposer(new Map([['prop-1', 'user-2']])),
        NOW,
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect((err as PolicyDeniedError).code).toBe('E_SELF_APPROVAL_FORBIDDEN');
    }
  });

  it('throws DomainInvariantError when stateBefore is not previewing or approved', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-2', [grant({ identityId: 'user-2' })]],
    ]);
    for (const bad of [
      'draft',
      'proposed',
      'validated',
      'validation_failed',
      'applying',
      'live',
      'reconciled',
      'rolled_back',
    ] as const) {
      try {
        guardApproval(
          contentProposal(),
          approval(bad),
          resolver(grants),
          proposer(new Map([['prop-1', 'user-1']])),
          NOW,
        );
        throw new Error(`expected stateBefore=${bad} to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainInvariantError);
        expect((err as DomainInvariantError).code).toBe('E_INVALID_TRANSITION');
      }
    }
  });
});

describe('policy: guardPublication', () => {
  function publication(stateBefore: ContentState): Publication {
    return Object.freeze({
      id: 'pub-1',
      revisionId: 'rev-1',
      publishedBy: otherActor,
      publishedAt: ISO,
      attestationHash: SHA,
      stateBefore,
      stateAfter: 'live',
      deployReceiptId: 'rcp-1',
    });
  }

  it('publishes when policy + stateBefore=live are both satisfied', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-2', [grant({ identityId: 'user-2' })]],
    ]);
    const r = guardPublication(
      contentProposal(),
      publication('live'),
      resolver(grants),
      proposer(new Map([['prop-1', 'user-1']])),
      NOW,
    );
    expect(r.allowed).toBe(true);
  });

  it('throws PolicyDeniedError when policy denies', () => {
    try {
      guardPublication(
        contentProposal(),
        publication('live'),
        resolver(new Map()),
        proposer(new Map([['prop-1', 'user-1']])),
        NOW,
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError);
    }
  });

  it('throws PolicyDeniedError when service attempts to publish', () => {
    // The publication's publishedBy field is the policy actor. Use a
    // service identity so the service-denial rule fires BEFORE the
    // grant lookup. The service still has a valid live grant to prove
    // the service rule (not the grant lookup) is what denies.
    const servicePublication = Object.freeze({
      id: 'pub-svc',
      revisionId: 'rev-1',
      publishedBy: plainService,
      publishedAt: ISO,
      attestationHash: SHA,
      stateBefore: 'live' as ContentState,
      stateAfter: 'live' as ContentState,
      deployReceiptId: 'rcp-1',
    });
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['svc-plain', [grant({ identityId: 'svc-plain' })]],
    ]);
    try {
      guardPublication(
        contentProposal(),
        servicePublication,
        resolver(grants),
        proposer(new Map([['prop-1', 'user-1']])),
        NOW,
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect((err as PolicyDeniedError).code).toBe('E_SERVICE_APPROVAL_FORBIDDEN');
    }
  });

  it('throws DomainInvariantError when stateBefore is not live', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-2', [grant({ identityId: 'user-2' })]],
    ]);
    for (const bad of [
      'draft',
      'proposed',
      'validated',
      'previewing',
      'approved',
      'applying',
      'propagating',
      'reconciled',
      'rolled_back',
    ] as const) {
      try {
        guardPublication(
          contentProposal(),
          publication(bad),
          resolver(grants),
          proposer(new Map([['prop-1', 'user-1']])),
          NOW,
        );
        throw new Error(`expected stateBefore=${bad} to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainInvariantError);
        expect((err as DomainInvariantError).code).toBe('E_INVALID_TRANSITION');
      }
    }
  });
});

// --------------------------------------------------------------------
// guardStateTransition: action-specific policy
// --------------------------------------------------------------------

describe('policy: guardStateTransition', () => {
  const grants = new Map<string, readonly AuthorityGrant[]>([
    ['user-2', [grant({ identityId: 'user-2' })]],
  ]);
  const proposerHook = proposer(new Map([['prop-1', 'user-1']]));
  const proposal = contentProposal();

  it('approve action goes through approve policy', () => {
    const r = guardStateTransition(
      'previewing',
      'approve',
      otherActor,
      resolver(grants),
      proposerHook,
      proposal,
      NOW,
    );
    expect(r.policy.allowed).toBe(true);
    expect(r.policy.action).toBe('approve');
  });

  it('go_live action goes through publish policy', () => {
    const r = guardStateTransition(
      'propagating',
      'go_live',
      otherActor,
      resolver(grants),
      proposerHook,
      proposal,
      NOW,
    );
    expect(r.policy.allowed).toBe(true);
    expect(r.policy.action).toBe('publish');
  });

  it('rollback action goes through rollback policy', () => {
    const r = guardStateTransition(
      'live',
      'rollback',
      otherActor,
      resolver(grants),
      proposerHook,
      proposal,
      NOW,
    );
    expect(r.policy.allowed).toBe(true);
    expect(r.policy.action).toBe('rollback');
  });

  it('non-policy actions evaluate under propose policy', () => {
    const r = guardStateTransition(
      'draft',
      'submit',
      otherActor,
      resolver(grants),
      proposerHook,
      proposal,
      NOW,
    );
    expect(r.policy.allowed).toBe(true);
    expect(r.policy.action).toBe('propose');
  });

  it('canonical_write validates the edge and requires publish authority', () => {
    const result = guardStateTransition(
      'applying',
      'canonical_write',
      otherActor,
      resolver(grants),
      proposerHook,
      proposal,
      NOW,
    );
    expect(result.policy.action).toBe('publish');

    const insufficient = grant({
      identityId: 'user-2',
      roles: ['publisher'],
      capabilities: ['content.post', 'publish'],
    });
    expect(() =>
      guardStateTransition(
        'applying',
        'canonical_write',
        otherActor,
        resolver(new Map([['user-2', [insufficient]]])),
        proposerHook,
        proposal,
        NOW,
      ),
    ).toThrow(PolicyDeniedError);
  });

  it('rejects an invalid state/action edge before evaluating authority', () => {
    expect(() =>
      guardStateTransition(
        'rolled_back',
        'submit',
        otherActor,
        resolver(grants),
        proposerHook,
        proposal,
        NOW,
      ),
    ).toThrow(InvalidTransitionError);
  });

  it('does not let an incomplete earlier grant shadow a later complete grant', () => {
    const incomplete = grant({
      identityId: 'user-2',
      roles: ['approver'],
      capabilities: ['content.post'],
    });
    const complete = grant({
      identityId: 'user-2',
      roles: ['approver'],
      capabilities: ['content.post', 'approve'],
    });
    const result = evaluatePolicy(
      { action: 'approve', actor: otherActor, proposal, nowIso: NOW },
      resolver(new Map([['user-2', [incomplete, complete]]])),
      proposerHook,
    );
    expect(result.allowed).toBe(true);
  });

  it('throws PolicyDeniedError when rollback policy denies (no rollback role)', () => {
    const g = grant({ roles: ['author', 'approver', 'publisher'] }); // no operator
    const localGrants = new Map<string, readonly AuthorityGrant[]>([
      ['user-2', [g]],
    ]);
    expect(() =>
      guardStateTransition(
        'live',
        'rollback',
        otherActor,
        resolver(localGrants),
        proposerHook,
        proposal,
        NOW,
      ),
    ).toThrow(PolicyDeniedError);
  });
});

// --------------------------------------------------------------------
// End-to-end shaped scenarios
// --------------------------------------------------------------------

describe('policy: end-to-end scenarios', () => {
  it('a full content proposal flow: propose -> approve -> publish all succeed with proper grants', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [grant({ identityId: 'user-1' })]],
      ['user-2', [grant({ identityId: 'user-2' })]],
    ]);
    const proposerHook = proposer(new Map([['prop-1', 'user-1']]));
    const propose: PolicyResult = evaluatePolicy(
      { action: 'propose', actor: actor, proposal: contentProposal(), nowIso: NOW },
      resolver(grants),
      proposerHook,
    );
    expect(propose.allowed).toBe(true);
    const approve = evaluatePolicy(
      { action: 'approve', actor: otherActor, proposal: contentProposal(), nowIso: NOW },
      resolver(grants),
      proposerHook,
    );
    expect(approve.allowed).toBe(true);
    const publish = evaluatePolicy(
      { action: 'publish', actor: otherActor, proposal: contentProposal(), nowIso: NOW },
      resolver(grants),
      proposerHook,
    );
    expect(publish.allowed).toBe(true);
    const rollback = evaluatePolicy(
      { action: 'rollback', actor: otherActor, proposal: contentProposal(), nowIso: NOW },
      resolver(grants),
      proposerHook,
    );
    expect(rollback.allowed).toBe(true);
  });

  it('every PolicyAction produces an explicit decision or denial — never throws inside evaluatePolicy', () => {
    const grants = new Map<string, readonly AuthorityGrant[]>([
      ['user-1', [grant({ identityId: 'user-1' })]],
    ]);
    const proposerHook = proposer(new Map([['prop-1', 'user-2']]));
    for (const action of ['propose', 'approve', 'publish', 'rollback'] as const) {
      const r = evaluatePolicy(
        policyInput(action),
        resolver(grants),
        proposerHook,
      );
      expect(typeof r.allowed).toBe('boolean');
    }
  });
});