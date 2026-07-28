/**
 * `@cms/core` — pure governance kernel.
 *
 * This package is I/O-free. It does not read files, talk to databases,
 * call network endpoints, import framework code, or perform any other
 * side effect. Every function it exports takes its inputs as values
 * and returns values.
 *
 * What it does do, deterministically:
 *   - Encode the closed set of domain invariants the rest of the CMS
 *     must respect (RegionBinding, identities, proposals, revisions,
 *     localised values, audit data, deploy status, error codes).
 *   - Drive the governance state machine, including its explicit
 *     failure branches and one-action rollback semantics.
 *   - Run the single policy engine for propose/approve/publish/rollback.
 *
 * What it does NOT do:
 *   - Persist anything.
 *   - Approve, publish, or write to the host repository on its own.
 *   - Hide failures or fall back to permissive defaults.
 *
 * Any denial — whether by the state machine or by the policy engine —
 * surfaces as a `DomainInvariantError`, `InvalidTransitionError`,
 * `RollbackWindowExpiredError`, or `PolicyDeniedError`. Callers
 * pattern-match on the `code` field of those errors, which is a stable
 * closed literal union defined in `./domain.ts`.
 */

// --------------------------------------------------------------------
// Domain types
// --------------------------------------------------------------------

export {
  ERROR_CODES,
  DomainInvariantError,
  assertLocalized,
  assertProposal,
  assertRegionBinding,
  brandIso8601,
  brandSha256Hex,
  checkRepoRelativePath,
  assertRepoRelativePath,
  isMcpIdentity,
  isServiceIdentity,
  type AliasSymlinkContract,
  type Approval,
  type AssetPayload,
  type AssetProposal,
  type AssetRevision,
  type CanonicalSource,
  type ContentPayload,
  type ContentProposal,
  type ContentRevision,
  type DeployStatus,
  type DerivedArtifact,
  type ErrorCode,
  type Identity,
  type IdentityBase,
  type ActorIdentity,
  type ServiceIdentity,
  type DelegatedHumanIdentity,
  type IdentityKind,
  type Iso8601,
  type Locale,
  type LocalizedValue,
  type Proposal,
  type ProposalAction,
  type ProposalBase,
  type ProposalPayload,
  type Publication,
  type RegenerationContract,
  type RegenerationMode,
  type RegionBinding,
  type Revision,
  type Sha256Hex,
} from './domain.js';

// --------------------------------------------------------------------
// State machine
// --------------------------------------------------------------------

export {
  ALL_STATES,
  FAILURE_STATES,
  CONTENT_STATE_TO_PROPOSAL_STATE,
  PROPOSAL_STATE_TO_CONTENT_STATE,
  InvalidTransitionError,
  TERMINAL_STATES,
  allowedActions,
  isFailureState,
  isTerminalState,
  mapContentStateToProposalState,
  mapProposalStateToContentState,
  transition,
  tryTransition,
  type Action,
  type ContentState,
  type ProposalState,
  type TransitionInput,
  type TransitionResult,
} from './state-machine.js';

// --------------------------------------------------------------------
// Policy engine
// --------------------------------------------------------------------

export {
  PolicyDeniedError,
  enforcePolicy,
  evaluatePolicy,
  guardApproval,
  guardPublication,
  guardStateTransition,
  type AuthorityGrant,
  type AuthorityResolver,
  type PolicyAction,
  type PolicyDecision,
  type PolicyDenial,
  type PolicyInput,
  type PolicyResult,
  type ProposerResolver,
} from './policy.js';