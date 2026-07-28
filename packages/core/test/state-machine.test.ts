/**
 * State machine: every allowed transition must round-trip, every invalid
 * transition must throw InvalidTransitionError, and the rolled_back state
 * must be the only terminal. The covered states are exposed by
 * `ALL_STATES`, `FAILURE_STATES`, `TERMINAL_STATES` and the predicates
 * `isFailureState`/`isTerminalState`/`allowedActions`.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_STATES,
  FAILURE_STATES,
  InvalidTransitionError,
  TERMINAL_STATES,
  allowedActions,
  isFailureState,
  isTerminalState,
  transition,
  tryTransition,
  type Action,
  type ActorIdentity,
  type ContentState,
  type TransitionInput,
} from '../src/index.js';
import {
  CONTENT_STATE_TO_PROPOSAL_STATE,
  PROPOSAL_STATE_TO_CONTENT_STATE,
  mapContentStateToProposalState,
  mapProposalStateToContentState,
  type ProposalState,
} from '../src/state-machine.js';

const actor: ActorIdentity = Object.freeze({
  kind: 'actor',
  id: 'user-1',
  displayName: 'Alice',
  capabilities: [],
});

function tx(current: ContentState, action: Action): TransitionInput {
  return { current, action, actor };
}

describe('state machine: state set composition', () => {
  it('ALL_STATES contains every reachable state, including the 7 failure branches', () => {
    expect(ALL_STATES).toContain('draft');
    expect(ALL_STATES).toContain('proposed');
    expect(ALL_STATES).toContain('validated');
    expect(ALL_STATES).toContain('validation_failed');
    expect(ALL_STATES).toContain('previewing');
    expect(ALL_STATES).toContain('preview_failed');
    expect(ALL_STATES).toContain('approved');
    expect(ALL_STATES).toContain('approval_revoked');
    expect(ALL_STATES).toContain('applying');
    expect(ALL_STATES).toContain('apply_failed');
    expect(ALL_STATES).toContain('canonical_written');
    expect(ALL_STATES).toContain('write_failed');
    expect(ALL_STATES).toContain('propagating');
    expect(ALL_STATES).toContain('propagate_failed');
    expect(ALL_STATES).toContain('live');
    expect(ALL_STATES).toContain('reconcile_failed');
    expect(ALL_STATES).toContain('reconciled');
    expect(ALL_STATES).toContain('rolled_back');
    expect(ALL_STATES.length).toBe(18);
  });

  it('FAILURE_STATES contains exactly the 7 failure branches', () => {
    expect(new Set(FAILURE_STATES)).toEqual(
      new Set<ContentState>([
        'validation_failed',
        'preview_failed',
        'approval_revoked',
        'apply_failed',
        'write_failed',
        'propagate_failed',
        'reconcile_failed',
      ]),
    );
    expect(FAILURE_STATES.length).toBe(7);
  });

  it('TERMINAL_STATES contains exactly rolled_back', () => {
    expect(TERMINAL_STATES).toEqual(['rolled_back']);
  });

  it('classifies representative failure, live, and terminal states', () => {
    expect(isFailureState('apply_failed')).toBe(true);
    expect(isFailureState('live')).toBe(false);
    expect(isTerminalState('rolled_back')).toBe(true);
    expect(isTerminalState('reconciled')).toBe(false);
  });
});

describe('state machine: happy-path transitions', () => {
  const cases: ReadonlyArray<readonly [ContentState, Action, ContentState]> = [
    ['draft', 'submit', 'proposed'],
    ['proposed', 'validate', 'validated'],
    ['validated', 'validate', 'validation_failed'],
    ['validated', 'preview', 'previewing'],
    ['previewing', 'preview', 'preview_failed'],
    ['previewing', 'approve', 'approved'],
    ['approved', 'approve', 'approval_revoked'],
    ['approved', 'apply', 'applying'],
    ['applying', 'apply', 'apply_failed'],
    ['applying', 'canonical_write', 'canonical_written'],
    ['canonical_written', 'canonical_write', 'write_failed'],
    ['canonical_written', 'propagate', 'propagating'],
    ['propagating', 'propagate', 'propagate_failed'],
    ['propagating', 'go_live', 'live'],
    ['live', 'reconcile_fail', 'reconcile_failed'],
    ['live', 'reconcile', 'reconciled'],
    ['reconciled', 'reconcile_fail', 'reconcile_failed'],
  ];

  for (const [from, action, to] of cases) {
    it(`${from} --${action}--> ${to}`, () => {
      const r = transition(tx(from, action));
      expect(r.previous).toBe(from);
      expect(r.next).toBe(to);
      expect(r.action).toBe(action);
      expect(r.actor).toBe(actor);
    });
  }
});

describe('state machine: one-action rollback from every supported source', () => {
  const sources: readonly ContentState[] = [
    'validation_failed',
    'preview_failed',
    'approval_revoked',
    'apply_failed',
    'write_failed',
    'propagate_failed',
    'reconcile_failed',
    'live',
    'reconciled',
  ];

  for (const from of sources) {
    it(`rollback from ${from} returns to rolled_back`, () => {
      const r = transition(tx(from, 'rollback'));
      expect(r.previous).toBe(from);
      expect(r.next).toBe('rolled_back');
      expect(r.action).toBe('rollback');
    });
  }

  it('rolled_back is a true terminal: no actions permitted', () => {
    expect(allowedActions('rolled_back')).toEqual([]);
  });
});

describe('state machine: invalid transitions', () => {
  it('rejects skipping the proposed step (draft -> validate)', () => {
    expect(() => transition(tx('draft', 'validate'))).toThrow(InvalidTransitionError);
  });

  it('rejects jumping the queue (draft -> go_live)', () => {
    expect(() => transition(tx('draft', 'go_live'))).toThrow(InvalidTransitionError);
  });

  it('rejects going back to an earlier state (approved -> preview)', () => {
    expect(() => transition(tx('approved', 'preview'))).toThrow(InvalidTransitionError);
  });

  it('rejects acting on rolled_back from any further action', () => {
    for (const a of ['submit', 'validate', 'preview', 'approve', 'apply', 'canonical_write', 'propagate', 'go_live', 'reconcile', 'reconcile_fail', 'rollback'] as const) {
      expect(() => transition(tx('rolled_back', a))).toThrow(InvalidTransitionError);
    }
  });

  it('rejects reconcile from a state that never leads to reconcile', () => {
    expect(() => transition(tx('proposed', 'reconcile'))).toThrow(InvalidTransitionError);
  });

  it('rejects submit after already submitted', () => {
    expect(() => transition(tx('proposed', 'submit'))).toThrow(InvalidTransitionError);
  });

  it('error carries code E_INVALID_TRANSITION, the offending from state and action', () => {
    try {
      transition(tx('draft', 'go_live'));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.code).toBe('E_INVALID_TRANSITION');
      expect(e.from).toBe('draft');
      expect(e.action).toBe('go_live');
      expect(e.message).toMatch(/no transition from draft via go_live/);
    }
  });
});

describe('state machine: failure branches are reachable and rollbackable', () => {
  it('every failure branch rolls back in exactly one step', () => {
    for (const fb of FAILURE_STATES) {
      const r = transition(tx(fb, 'rollback'));
      expect(r.next).toBe('rolled_back');
    }
  });

  it('classifies failures without treating live or reconciled as failures', () => {
    expect(isFailureState('validation_failed')).toBe(true);
    expect(isFailureState('reconcile_failed')).toBe(true);
    expect(isFailureState('live')).toBe(false);
    expect(isFailureState('reconciled')).toBe(false);
  });
});

describe('state machine: allowedActions enumerates valid next actions', () => {
  it('submit is the only action permitted from draft', () => {
    expect(new Set(allowedActions('draft'))).toEqual(new Set<Action>(['submit']));
  });

  it('validate is the only action permitted from proposed', () => {
    expect(new Set(allowedActions('proposed'))).toEqual(new Set<Action>(['validate']));
  });

  it('validated fans out into validate (failure) and preview', () => {
    expect(new Set(allowedActions('validated'))).toEqual(
      new Set<Action>(['validate', 'preview']),
    );
  });

  it('previewing fans out into preview (failure) and approve', () => {
    expect(new Set(allowedActions('previewing'))).toEqual(
      new Set<Action>(['preview', 'approve']),
    );
  });

  it('approved fans out into approve (revoke) and apply', () => {
    expect(new Set(allowedActions('approved'))).toEqual(
      new Set<Action>(['approve', 'apply']),
    );
  });

  it('applying fans out into apply (failure) and canonical_write', () => {
    expect(new Set(allowedActions('applying'))).toEqual(
      new Set<Action>(['apply', 'canonical_write']),
    );
  });

  it('canonical_written fans out into canonical_write (failure) and propagate', () => {
    expect(new Set(allowedActions('canonical_written'))).toEqual(
      new Set<Action>(['canonical_write', 'propagate']),
    );
  });

  it('propagating fans out into propagate (failure) and go_live', () => {
    expect(new Set(allowedActions('propagating'))).toEqual(
      new Set<Action>(['propagate', 'go_live']),
    );
  });

  it('live has distinct reconciliation success/failure actions plus rollback', () => {
    expect(allowedActions('live')).toEqual(['reconcile_fail', 'reconcile', 'rollback']);
  });

  it('reconciled permits explicit reconciliation failure or rollback', () => {
    expect(allowedActions('reconciled')).toEqual(['reconcile_fail', 'rollback']);
  });

  it('has no duplicate state/action transition keys', () => {
    for (const state of ALL_STATES) {
      const actions = allowedActions(state);
      expect(new Set(actions).size).toBe(actions.length);
    }
  });

  it('every failure branch allows only rollback', () => {
    for (const fb of FAILURE_STATES) {
      expect(new Set(allowedActions(fb))).toEqual(new Set<Action>(['rollback']));
    }
  });
});

describe('state machine: tryTransition non-throwing variant', () => {
  it('returns ok:true with the TransitionResult for valid edges', () => {
    const r = tryTransition(tx('draft', 'submit'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.previous).toBe('draft');
      expect(r.value.next).toBe('proposed');
      expect(r.value.action).toBe('submit');
    }
  });

  it('returns ok:false with the typed code for invalid edges', () => {
    const r = tryTransition(tx('rolled_back', 'submit'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('E_INVALID_TRANSITION');
      expect(r.message).toMatch(/no transition/);
    }
  });

  it('tryTransition never throws for any in-state action, valid or not', () => {
    for (const s of ALL_STATES) {
      for (const a of [
        'submit',
        'validate',
        'preview',
        'approve',
        'apply',
        'canonical_write',
        'propagate',
        'go_live',
        'reconcile',
        'reconcile_fail',
        'rollback',
      ] as const) {
        const r = tryTransition(tx(s, a));
        expect(typeof r.ok).toBe('boolean');
      }
    }
  });
});

describe('state machine: deterministic end-to-end walk', () => {
  it('walks draft -> reconciled via the canonical success pipeline', () => {
    const path: Array<{ from: ContentState; action: Action }> = [
      { from: 'draft', action: 'submit' },
      { from: 'proposed', action: 'validate' },
      { from: 'validated', action: 'preview' },
      { from: 'previewing', action: 'approve' },
      { from: 'approved', action: 'apply' },
      { from: 'applying', action: 'canonical_write' },
      { from: 'canonical_written', action: 'propagate' },
      { from: 'propagating', action: 'go_live' },
      { from: 'live', action: 'reconcile' },
    ];
    let last: ContentState = 'draft';
    for (const step of path) {
      expect(step.from).toBe(last);
      const r = transition(tx(step.from, step.action));
      last = r.next;
    }
    expect(last).toBe('reconciled');
  });
});

describe('state machine: storage-alphabet mapping (ContentState -> ProposalState)', () => {
  // Every ContentState has an explicit projection. Failure branches whose
  // alphabet does not exist in the storage schema collapse onto the closest
  // semantically-equivalent storage state; the audit row carries the original
  // core state via the event payload, so the projection is recoverable.
  const cases: ReadonlyArray<readonly [ContentState, ProposalState]> = [
    ['draft', 'draft'],
    ['proposed', 'proposed'],
    ['validated', 'validated'],
    ['validation_failed', 'refused'],
    ['previewing', 'previewing'],
    ['preview_failed', 'refused'],
    ['approved', 'approved'],
    ['approval_revoked', 'rolled_back'],
    ['applying', 'applying'],
    ['apply_failed', 'apply_failed'],
    ['canonical_written', 'canonical_written'],
    ['write_failed', 'apply_failed'],
    ['propagating', 'propagating'],
    ['propagate_failed', 'deploy_failed'],
    ['live', 'live'],
    ['reconcile_failed', 'reconcile_pending'],
    ['reconciled', 'reconciled'],
    ['rolled_back', 'rolled_back'],
  ];

  it('covers every entry in ALL_STATES exactly once', () => {
    const states = cases.map(([s]) => s);
    expect(new Set(states)).toEqual(new Set(ALL_STATES));
    expect(states.length).toBe(ALL_STATES.length);
  });

  for (const [from, to] of cases) {
    it(`maps ${from} -> ${to} via the record`, () => {
      expect(CONTENT_STATE_TO_PROPOSAL_STATE[from]).toBe(to);
    });

    it(`maps ${from} -> ${to} via the helper`, () => {
      expect(mapContentStateToProposalState(from)).toBe(to);
    });
  }

  it('CONTENT_STATE_TO_PROPOSAL_STATE is the same object the helper consults', () => {
    expect(mapContentStateToProposalState('approved')).toBe(CONTENT_STATE_TO_PROPOSAL_STATE['approved']);
    expect(mapContentStateToProposalState('rolled_back')).toBe(CONTENT_STATE_TO_PROPOSAL_STATE['rolled_back']);
  });

  it('CONTENT_STATE_TO_PROPOSAL_STATE is frozen so callers cannot mutate the canonical table', () => {
    expect(Object.isFrozen(CONTENT_STATE_TO_PROPOSAL_STATE)).toBe(true);
  });

  it('every input ContentState maps to exactly one ProposalState', () => {
    for (const state of ALL_STATES) {
      const out = mapContentStateToProposalState(state);
      expect(typeof out).toBe('string');
      // Round-trip: re-encoding through the reverse map returns a core
      // state. (The round-trip is non-identity for the lossy edges by
      // design — see the round-trip suite for the per-case expected
      // back-projection.)
      const back = mapProposalStateToContentState(out);
      expect(typeof back).toBe('string');
    }
  });
});

describe('state machine: storage-alphabet mapping (ProposalState -> ContentState)', () => {
  // Every ProposalState has an explicit reverse projection. Storage-only
  // states that have no 1:1 core counterpart map onto the closest core
  // failure state (e.g. `refused` -> `validation_failed`).
  const cases: ReadonlyArray<readonly [ProposalState, ContentState]> = [
    ['draft', 'draft'],
    ['proposed', 'proposed'],
    ['validated', 'validated'],
    ['previewing', 'previewing'],
    ['approved', 'approved'],
    ['applying', 'applying'],
    ['canonical_written', 'canonical_written'],
    ['propagating', 'propagating'],
    ['live', 'live'],
    ['reconciled', 'reconciled'],
    ['apply_failed', 'apply_failed'],
    ['deploy_pending', 'apply_failed'],
    ['deploy_failed', 'propagate_failed'],
    ['reconcile_pending', 'reconcile_failed'],
    ['rolled_back', 'rolled_back'],
    ['refused', 'validation_failed'],
  ];

  for (const [from, to] of cases) {
    it(`maps ${from} -> ${to} via the record`, () => {
      expect(PROPOSAL_STATE_TO_CONTENT_STATE[from]).toBe(to);
    });

    it(`maps ${from} -> ${to} via the helper`, () => {
      expect(mapProposalStateToContentState(from)).toBe(to);
    });
  }

  it('PROPOSAL_STATE_TO_CONTENT_STATE is the same object the helper consults', () => {
    expect(mapProposalStateToContentState('live')).toBe(PROPOSAL_STATE_TO_CONTENT_STATE['live']);
    expect(mapProposalStateToContentState('refused')).toBe(PROPOSAL_STATE_TO_CONTENT_STATE['refused']);
  });

  it('PROPOSAL_STATE_TO_CONTENT_STATE is frozen so callers cannot mutate the canonical table', () => {
    expect(Object.isFrozen(PROPOSAL_STATE_TO_CONTENT_STATE)).toBe(true);
  });
});

describe('state machine: storage-alphabet mapping round-trips', () => {
  // Round-trip expectations. The mapping is intentionally lossy at the
  // failure/storage-only edges: the storage alphabet is a subset of the
  // core alphabet, and several distinct core failure states collapse onto
  // the same storage row. The reverse projection must land on a core
  // state that the original mapped to — that is the only invariant
  // preservation property the storage layer promises for diagnostic UI.
  type RoundTripCase = {
    readonly core: ContentState;
    readonly stored: ProposalState;
    readonly back: ContentState;
  };

  const cases: ReadonlyArray<RoundTripCase> = [
    // Happy path: identity round-trip on both directions.
    { core: 'draft', stored: 'draft', back: 'draft' },
    { core: 'proposed', stored: 'proposed', back: 'proposed' },
    { core: 'validated', stored: 'validated', back: 'validated' },
    { core: 'previewing', stored: 'previewing', back: 'previewing' },
    { core: 'approved', stored: 'approved', back: 'approved' },
    { core: 'applying', stored: 'applying', back: 'applying' },
    { core: 'canonical_written', stored: 'canonical_written', back: 'canonical_written' },
    { core: 'propagating', stored: 'propagating', back: 'propagating' },
    { core: 'live', stored: 'live', back: 'live' },
    { core: 'reconciled', stored: 'reconciled', back: 'reconciled' },
    // Core -> storage failure collapses.
    { core: 'apply_failed', stored: 'apply_failed', back: 'apply_failed' },
    { core: 'rolled_back', stored: 'rolled_back', back: 'rolled_back' },
    // Lossy forward projection, deterministic back-projection.
    { core: 'validation_failed', stored: 'refused', back: 'validation_failed' },
    { core: 'preview_failed', stored: 'refused', back: 'validation_failed' },
    { core: 'approval_revoked', stored: 'rolled_back', back: 'rolled_back' },
    { core: 'write_failed', stored: 'apply_failed', back: 'apply_failed' },
    { core: 'propagate_failed', stored: 'deploy_failed', back: 'propagate_failed' },
    { core: 'reconcile_failed', stored: 'reconcile_pending', back: 'reconcile_failed' },
  ];

  for (const c of cases) {
    it(`round-trips ${c.core} -> ${c.stored} -> ${c.back}`, () => {
      const forward = mapContentStateToProposalState(c.core);
      const back = mapProposalStateToContentState(c.stored);
      expect(forward).toBe(c.stored);
      expect(back).toBe(c.back);
      // Stable re-encoding: mapping the back-projection through the
      // forward map lands on the same stored state (idempotence of the
      // forward direction on the storage alphabet).
      expect(mapContentStateToProposalState(back)).toBe(c.stored);
    });
  }

  it('storage-only ProposalState values have explicit deterministic canonical projections', () => {
    const canonicalized: ReadonlyArray<readonly [ProposalState, ProposalState]> = [
      ['deploy_pending', 'apply_failed'],
      ['deploy_failed', 'deploy_failed'],
      ['reconcile_pending', 'reconcile_pending'],
      ['refused', 'refused'],
    ];
    for (const [stored, expectedCanonical] of canonicalized) {
      const back = mapProposalStateToContentState(stored);
      expect(mapContentStateToProposalState(back)).toBe(expectedCanonical);
    }
  });

  it('fail-closed: unknown ProposalState is excluded by the type system', () => {
    // The type system rejects unrecognised ProposalState values at
    // compile time; the runtime helper therefore cannot observe an
    // unrecognised input. This test pins the contract: the helper does
    // not perform any string coercion or fall-back lookup.
    const sampleKnown: ReadonlyArray<ProposalState> = [
      'draft',
      'proposed',
      'validated',
      'previewing',
      'approved',
      'applying',
      'canonical_written',
      'propagating',
      'live',
      'reconciled',
      'apply_failed',
      'deploy_pending',
      'deploy_failed',
      'reconcile_pending',
      'rolled_back',
      'refused',
    ];
    for (const s of sampleKnown) {
      // Direct access — the record is total, so any key in the union
      // returns a defined string.
      expect(typeof PROPOSAL_STATE_TO_CONTENT_STATE[s]).toBe('string');
      expect(typeof mapProposalStateToContentState(s)).toBe('string');
    }
  });

  it('fail-closed: PROPOSAL_STATE_TO_CONTENT_STATE has exactly 16 keys (storage alphabet size)', () => {
    expect(Object.keys(PROPOSAL_STATE_TO_CONTENT_STATE).length).toBe(16);
  });

  it('fail-closed: CONTENT_STATE_TO_PROPOSAL_STATE has exactly 18 keys (core alphabet size)', () => {
    expect(Object.keys(CONTENT_STATE_TO_PROPOSAL_STATE).length).toBe(18);
  });

  it('forward map preserves every state in the happy-path enum block (no failure collapse on canonical success states)', () => {
    const happyPath: ReadonlyArray<ContentState> = [
      'draft',
      'proposed',
      'validated',
      'previewing',
      'approved',
      'applying',
      'canonical_written',
      'propagating',
      'live',
      'reconciled',
    ];
    for (const s of happyPath) {
      const stored = mapContentStateToProposalState(s);
      // Identity round-trip on every happy-path core state.
      expect(mapProposalStateToContentState(stored)).toBe(s);
    }
  });

  it('forward map collapses every failure branch onto a defined storage state', () => {
    for (const s of FAILURE_STATES) {
      const stored = mapContentStateToProposalState(s);
      expect(typeof stored).toBe('string');
      // Every failure branch maps onto a defined ProposalState key in the
      // reverse table.
      expect(PROPOSAL_STATE_TO_CONTENT_STATE[stored]).toBeDefined();
    }
  });
});