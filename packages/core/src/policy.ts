/**
 * Single policy engine for propose / approve / publish / rollback.
 *
 * Rules enforced (none are optional, none may be skipped):
 *   1. Service and MCP-capable identities are never permitted to approve
 *      or publish. The API authority layer additionally requires a human
 *      identity for rollback.
 *   2. Approval requires a CURRENT human authority. The host must call
 *      `currentHumanAuthority` to resolve whether the identity holds a
 *      live, non-expired grant right now. Cached/expired grants are
 *      rejected.
 *   3. Same-human approval requires an explicit `self_approve` capability
 *      on the matching current grant; it is denied by default.
 *   4. Field-level capabilities are checked against the proposal's
 *      content type. Missing capabilities produce a hard denial, not a
 *      soft warning.
 *   5. Role / content-type / environment / action combinations are
 *      matched against an explicit allow-list supplied by the host. Any
 *      combination not listed is denied.
 *
 * The engine returns explicit error codes from the closed union in
 * `domain.ts`. It never silently succeeds.
 */

import {
  DomainInvariantError,
  isMcpIdentity,
  isServiceIdentity,
  type Approval,
  type ErrorCode,
  type Identity,
  type Proposal,
  type Publication,
} from './domain.js';
import { transition, type Action, type ContentState } from './state-machine.js';

export type PolicyAction = 'propose' | 'approve' | 'publish' | 'rollback';

export interface AuthorityGrant {
  readonly identityId: string;
  readonly roles: readonly string[];
  readonly contentTypes: readonly string[];
  readonly environments: readonly ('staging' | 'production')[];
  readonly capabilities: readonly string[];
  readonly notBefore: string;
  readonly notAfter: string;
}

/**
 * Hook the host must supply: given an identity id, return its CURRENT
 * grants. The host is responsible for time-of-check; the engine
 * validates the returned grants' temporal windows.
 */
export type AuthorityResolver = (identityId: string) => readonly AuthorityGrant[];

/**
 * Hook the host must supply: given a proposal id, return its proposer
 * identity id. This is how the engine enforces self-approval policy.
 */
export type ProposerResolver = (proposalId: string) => string;

export interface PolicyInput {
  readonly action: PolicyAction;
  readonly actor: Identity;
  readonly proposal: Proposal;
  readonly nowIso: string;
}

export interface PolicyDecision {
  readonly allowed: true;
  readonly actor: Identity;
  readonly action: PolicyAction;
  readonly proposalId: string;
  readonly matchedGrant: AuthorityGrant;
}

export interface PolicyDenial {
  readonly allowed: false;
  readonly code: ErrorCode;
  readonly message: string;
  readonly actor: Identity;
  readonly action: PolicyAction;
  readonly proposalId: string;
}

export type PolicyResult = PolicyDecision | PolicyDenial;

export class PolicyDeniedError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'PolicyDeniedError';
    this.code = code;
  }
}

/**
 * Evaluate whether `actor` may perform `action` on `proposal` right now.
 * `resolver` returns the actor's current authority grants; `proposer`
 * returns the proposer id of a proposal.
 */
export function evaluatePolicy(
  input: PolicyInput,
  resolver: AuthorityResolver,
  proposer: ProposerResolver,
): PolicyResult {
  const { action, actor, proposal, nowIso } = input;

  // Rule 1: services and MCP identities cannot approve or publish.
  if (action === 'approve' || action === 'publish') {
    if (isServiceIdentity(actor)) {
      return denial(
        'E_SERVICE_APPROVAL_FORBIDDEN',
        `service identity ${actor.id} may not approve or publish`,
        input,
      );
    }
    if (isMcpIdentity(actor)) {
      return denial(
        'E_MCP_APPROVAL_FORBIDDEN',
        `MCP-capable identity ${actor.id} may not approve or publish`,
        input,
      );
    }
  }

  // For propose/approve/publish/rollback, the actor MUST hold a grant.
  const grants = resolver(actor.id);
  if (grants.length === 0) {
    return denial(
      'E_INSUFFICIENT_AUTHORITY',
      `identity ${actor.id} has no authority grants`,
      input,
    );
  }

  const live = grants.filter((g) => g.notBefore <= nowIso && nowIso < g.notAfter);
  if (live.length === 0) {
    return denial(
      'E_INSUFFICIENT_AUTHORITY',
      `identity ${actor.id} has no live grant at ${nowIso}`,
      input,
    );
  }

  // Same-human approval is an explicit capability, disabled unless a
  // matching current grant includes `self_approve`.
  const isSelfApproval =
    (action === 'approve' || action === 'publish') &&
    proposer(proposal.id) === actor.id;

  // Rule 4+5: evaluate every live grant. A capability-incomplete grant
  // cannot shadow a later complete grant merely because of resolver order.
  const missingCapabilities = new Set<string>();
  for (const grant of live) {
    const roleOk = grant.roles.includes(actionRole(action));
    const contentOk = grant.contentTypes.includes(proposal.contentType);
    const envOk = grant.environments.includes(proposal.environment);
    if (!roleOk || !contentOk || !envOk) continue;

    const required = requiredCapabilitiesFor(action, proposal, isSelfApproval);
    const missing = required.filter((capability) => !grant.capabilities.includes(capability));
    if (missing.length > 0) {
      for (const capability of missing) missingCapabilities.add(capability);
      continue;
    }
    return {
      allowed: true,
      actor,
      action,
      proposalId: proposal.id,
      matchedGrant: grant,
    };
  }

  if (isSelfApproval && missingCapabilities.has('self_approve')) {
    return denial(
      'E_SELF_APPROVAL_FORBIDDEN',
      `identity ${actor.id} lacks self_approve for proposal ${proposal.id}`,
      input,
    );
  }
  if (missingCapabilities.size > 0) {
    return denial(
      'E_FIELD_CAPABILITY_MISSING',
      `grants for ${actor.id} missing capabilities: ${[...missingCapabilities].sort().join(', ')}`,
      input,
    );
  }
  return denial(
    'E_ROLE_MISMATCH',
    `no grant covers action=${action} content=${proposal.contentType} env=${proposal.environment}`,
    input,
  );
}

function denial(
  code: ErrorCode,
  message: string,
  input: PolicyInput,
): PolicyDenial {
  return {
    allowed: false,
    code,
    message,
    actor: input.actor,
    action: input.action,
    proposalId: input.proposal.id,
  };
}

/**
 * Throwing variant. Use this when the caller wants to short-circuit on
 * denial rather than branch on the tagged result.
 */
export function enforcePolicy(
  input: PolicyInput,
  resolver: AuthorityResolver,
  proposer: ProposerResolver,
): PolicyDecision {
  const result = evaluatePolicy(input, resolver, proposer);
  if (!result.allowed) {
    throw new PolicyDeniedError(result.code, result.message);
  }
  return result;
}

function actionRole(action: PolicyAction): string {
  switch (action) {
    case 'propose':
      return 'author';
    case 'approve':
      return 'approver';
    case 'publish':
      return 'publisher';
    case 'rollback':
      return 'operator';
  }
}

function requiredCapabilitiesFor(
  action: PolicyAction,
  proposal: Proposal,
  selfApproval = false,
): readonly string[] {
  const base: readonly string[] = [`content.${proposal.contentType}`];
  switch (action) {
    case 'propose':
      return [...base, 'propose'];
    case 'approve':
      return [...base, 'approve', ...(selfApproval ? ['self_approve'] : [])];
    case 'publish':
      return [...base, 'publish', 'canonical.write', ...(selfApproval ? ['self_approve'] : [])];
    case 'rollback':
      return [...base, 'rollback'];
  }
}

// --------------------------------------------------------------------
// Convenience guards
// --------------------------------------------------------------------

/**
 * Wrap an Approval creation with policy + state-machine checks. The
 * host invokes this immediately before persisting an Approval record.
 */
export function guardApproval(
  proposal: Proposal,
  approval: Approval,
  resolver: AuthorityResolver,
  proposer: ProposerResolver,
  nowIso: string,
): PolicyDecision {
  const result = evaluatePolicy(
    {
      action: 'approve',
      actor: approval.approvedBy,
      proposal,
      nowIso,
    },
    resolver,
    proposer,
  );
  if (!result.allowed) {
    throw new PolicyDeniedError(result.code, result.message);
  }
  if (
    approval.stateBefore !== 'previewing' &&
    approval.stateBefore !== 'approved'
  ) {
    throw new DomainInvariantError(
      'E_INVALID_TRANSITION',
      `approval recorded from invalid state ${approval.stateBefore}`,
    );
  }
  return result;
}

/**
 * Wrap a Publication creation with policy + state-machine checks.
 */
export function guardPublication(
  proposal: Proposal,
  publication: Publication,
  resolver: AuthorityResolver,
  proposer: ProposerResolver,
  nowIso: string,
): PolicyDecision {
  const result = evaluatePolicy(
    {
      action: 'publish',
      actor: publication.publishedBy,
      proposal,
      nowIso,
    },
    resolver,
    proposer,
  );
  if (!result.allowed) {
    throw new PolicyDeniedError(result.code, result.message);
  }
  if (publication.stateBefore !== 'live') {
    throw new DomainInvariantError(
      'E_INVALID_TRANSITION',
      `publication recorded from invalid state ${publication.stateBefore}`,
    );
  }
  return result;
}

/**
 * Carry an explicit `from -> to` state transition past the policy gate.
 * The state-machine module validates the edge.
 */
export function guardStateTransition(
  current: ContentState,
  action: Action,
  actor: Identity,
  resolver: AuthorityResolver,
  proposer: ProposerResolver,
  proposal: Proposal,
  nowIso: string,
): { policy: PolicyDecision } {
  transition({ current, action, actor });

  const policyAction: PolicyAction =
    action === 'approve'
      ? 'approve'
      : action === 'go_live' || action === 'canonical_write'
        ? 'publish'
        : action === 'rollback'
          ? 'rollback'
          : 'propose';
  const result = evaluatePolicy(
    {
      action: policyAction,
      actor,
      proposal,
      nowIso,
    },
    resolver,
    proposer,
  );
  if (!result.allowed) {
    throw new PolicyDeniedError(result.code, result.message);
  }
  return { policy: result };
}
