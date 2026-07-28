/**
 * Deterministic governance state machine.
 *
 * Happy path:
 *   draft -> proposed -> validated -> previewing -> approved
 *           -> applying -> canonical_written -> propagating -> live -> reconciled
 *
 * Failure branches (all explicit, none implicit):
 *   validated   -> validation_failed      (terminal until rollback)
 *   previewing  -> preview_failed         (terminal until rollback)
 *   approved    -> approval_revoked       (rollback target)
 *   applying    -> apply_failed           (rollback target)
 *   canonical_written -> write_failed     (rollback target)
 *   propagating -> propagate_failed       (rollback target)
 *   live        -> reconcile_failed       (rollback target)
 *   reconciled  -> rollback               (only from live/reconciled/failed)
 *
 * Rollback semantics: a single one-action rollback from any failure branch
 * or from `live`/`reconciled` moves to the terminal `rolled_back` state.
 * Revision targeting, stale-base refusal, and rollback-window checks are
 * validated by the application service before this pure state transition.
 */

import { type ErrorCode, type Identity } from './domain.js';

export type ContentState =
  | 'draft'
  | 'proposed'
  | 'validated'
  | 'validation_failed'
  | 'previewing'
  | 'preview_failed'
  | 'approved'
  | 'approval_revoked'
  | 'applying'
  | 'apply_failed'
  | 'canonical_written'
  | 'write_failed'
  | 'propagating'
  | 'propagate_failed'
  | 'live'
  | 'reconcile_failed'
  | 'reconciled'
  | 'rolled_back';

export const ALL_STATES: readonly ContentState[] = [
  'draft',
  'proposed',
  'validated',
  'validation_failed',
  'previewing',
  'preview_failed',
  'approved',
  'approval_revoked',
  'applying',
  'apply_failed',
  'canonical_written',
  'write_failed',
  'propagating',
  'propagate_failed',
  'live',
  'reconcile_failed',
  'reconciled',
  'rolled_back',
] as const;

export const TERMINAL_STATES: readonly ContentState[] = [
  'rolled_back',
] as const;

export const FAILURE_STATES: readonly ContentState[] = [
  'validation_failed',
  'preview_failed',
  'approval_revoked',
  'apply_failed',
  'write_failed',
  'propagate_failed',
  'reconcile_failed',
] as const;

export type Action =
  | 'submit'
  | 'validate'
  | 'preview'
  | 'approve'
  | 'apply'
  | 'canonical_write'
  | 'propagate'
  | 'go_live'
  | 'reconcile'
  | 'reconcile_fail'
  | 'rollback';

interface Transition {
  readonly from: ContentState;
  readonly to: ContentState;
  readonly action: Action;
}

const TRANSITIONS: readonly Transition[] = [
  { from: 'draft',            action: 'submit',          to: 'proposed' },
  { from: 'proposed',         action: 'validate',        to: 'validated' },
  { from: 'validated',        action: 'validate',        to: 'validation_failed' },
  { from: 'validated',        action: 'preview',         to: 'previewing' },
  { from: 'previewing',       action: 'preview',         to: 'preview_failed' },
  { from: 'previewing',       action: 'approve',         to: 'approved' },
  { from: 'approved',         action: 'approve',         to: 'approval_revoked' },
  { from: 'approved',         action: 'apply',           to: 'applying' },
  { from: 'applying',         action: 'apply',           to: 'apply_failed' },
  { from: 'applying',         action: 'canonical_write', to: 'canonical_written' },
  { from: 'canonical_written',action: 'canonical_write', to: 'write_failed' },
  { from: 'canonical_written',action: 'propagate',       to: 'propagating' },
  { from: 'propagating',      action: 'propagate',       to: 'propagate_failed' },
  { from: 'propagating',      action: 'go_live',         to: 'live' },
  { from: 'live',             action: 'reconcile_fail',  to: 'reconcile_failed' },
  { from: 'live',             action: 'reconcile',       to: 'reconciled' },
  { from: 'reconciled',       action: 'reconcile_fail',  to: 'reconcile_failed' },
  // Rollback from any failure branch or live/reconciled.
  { from: 'validation_failed', action: 'rollback', to: 'rolled_back' },
  { from: 'preview_failed',    action: 'rollback', to: 'rolled_back' },
  { from: 'approval_revoked',  action: 'rollback', to: 'rolled_back' },
  { from: 'apply_failed',      action: 'rollback', to: 'rolled_back' },
  { from: 'write_failed',      action: 'rollback', to: 'rolled_back' },
  { from: 'propagate_failed',  action: 'rollback', to: 'rolled_back' },
  { from: 'reconcile_failed',  action: 'rollback', to: 'rolled_back' },
  { from: 'live',              action: 'rollback', to: 'rolled_back' },
  { from: 'reconciled',        action: 'rollback', to: 'rolled_back' },
];

export interface TransitionInput {
  readonly current: ContentState;
  readonly action: Action;
  readonly actor: Identity;
}

export interface TransitionResult {
  readonly previous: ContentState;
  readonly next: ContentState;
  readonly action: Action;
  readonly actor: Identity;
}

export class InvalidTransitionError extends Error {
  readonly code: ErrorCode = 'E_INVALID_TRANSITION';
  readonly from: ContentState;
  readonly action: Action;
  constructor(from: ContentState, action: Action, message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.action = action;
  }
}


/**
 * Apply an action to the current state. Returns the deterministic next
 * state. Throws `InvalidTransitionError` for any action not listed in
 * `TRANSITIONS` for the given `current` state.
 */
export function transition(input: TransitionInput): TransitionResult {
  const { current, action, actor } = input;
  const match = TRANSITIONS.find(
    (t) => t.from === current && t.action === action,
  );
  if (match === undefined) {
    throw new InvalidTransitionError(
      current,
      action,
      `no transition from ${current} via ${action}`,
    );
  }
  return {
    previous: match.from,
    next: match.to,
    action: match.action,
    actor,
  };
}

/**
 * Non-throwing variant: returns a tagged result so callers can compose
 * without try/catch.
 */
export function tryTransition(
  input: TransitionInput,
):
  | { ok: true; value: TransitionResult }
  | { ok: false; code: ErrorCode; message: string } {
  try {
    return { ok: true, value: transition(input) };
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  }
}

export function isFailureState(state: ContentState): boolean {
  return (FAILURE_STATES as readonly ContentState[]).includes(state);
}

export function isTerminalState(state: ContentState): boolean {
  return (TERMINAL_STATES as readonly ContentState[]).includes(state);
}

/**
 * Convenience: list the actions permitted from a given state. Useful
 * for UI surfaces and audit rendering.
 */
export function allowedActions(state: ContentState): readonly Action[] {
  return TRANSITIONS.filter((t) => t.from === state).map((t) => t.action);
}

// ---------------------------------------------------------------------------
// Storage alphabet mapping
// ---------------------------------------------------------------------------

/**
 * Storage-layer proposal states. This is the alphabet the @cms/storage
 * Postgres schema enforces via CHECK constraints. It is intentionally a
 * subset of (and intentionally mapped to) the core lifecycle alphabet so
 * that every core state has a stable, fail-closed projection into the
 * persisted proposal row, and no core failure state becomes unreadable
 * when it is loaded back from storage.
 */
export type ProposalState =
  | 'draft'
  | 'proposed'
  | 'validated'
  | 'previewing'
  | 'approved'
  | 'applying'
  | 'canonical_written'
  | 'propagating'
  | 'live'
  | 'reconciled'
  | 'apply_failed'
  | 'deploy_pending'
  | 'deploy_failed'
  | 'reconcile_pending'
  | 'rolled_back'
  | 'refused';

/**
 * Mapping from a core lifecycle state to the storage-layer proposal state.
 * The mapping is total: every `ContentState` has a non-null projection.
 * Core failure states that the schema's CHECK constraint does not allow
 * collapse onto the closest semantically equivalent storage state — the
 * audit row carries the original core state via the `event` payload, so
 * the projection is recoverable for diagnostic and operator-facing UI.
 */
export const CONTENT_STATE_TO_PROPOSAL_STATE: Readonly<Record<ContentState, ProposalState>> = Object.freeze({
  draft: 'draft',
  proposed: 'proposed',
  validated: 'validated',
  validation_failed: 'refused',
  previewing: 'previewing',
  preview_failed: 'refused',
  approved: 'approved',
  approval_revoked: 'rolled_back',
  applying: 'applying',
  apply_failed: 'apply_failed',
  canonical_written: 'canonical_written',
  write_failed: 'apply_failed',
  propagating: 'propagating',
  propagate_failed: 'deploy_failed',
  live: 'live',
  reconcile_failed: 'reconcile_pending',
  reconciled: 'reconciled',
  rolled_back: 'rolled_back',
});

/** Reverse projection from the storage alphabet back to a core state. */
export const PROPOSAL_STATE_TO_CONTENT_STATE: Readonly<Record<ProposalState, ContentState>> = Object.freeze({
  draft: 'draft',
  proposed: 'proposed',
  validated: 'validated',
  previewing: 'previewing',
  approved: 'approved',
  applying: 'applying',
  canonical_written: 'canonical_written',
  propagating: 'propagating',
  live: 'live',
  reconciled: 'reconciled',
  apply_failed: 'apply_failed',
  deploy_pending: 'apply_failed',
  deploy_failed: 'propagate_failed',
  reconcile_pending: 'reconcile_failed',
  rolled_back: 'rolled_back',
  refused: 'validation_failed',
});

/**
 * Project a core lifecycle state to the persisted storage state. Total:
 * every `ContentState` has a mapping. Throws nothing — invalid inputs are
 * excluded by the type system.
 */
export function mapContentStateToProposalState(state: ContentState): ProposalState {
  return CONTENT_STATE_TO_PROPOSAL_STATE[state];
}

/**
 * Project a persisted storage state back to the core lifecycle state.
 * Total over `ProposalState`. Storage rows outside this alphabet fail
 * closed inside @cms/storage's decoder; the core never has to handle an
 * unrecognised persisted string.
 */
export function mapProposalStateToContentState(state: ProposalState): ContentState {
  return PROPOSAL_STATE_TO_CONTENT_STATE[state];
}