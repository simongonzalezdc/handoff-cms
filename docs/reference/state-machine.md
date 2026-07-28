# Governance state machine

> **Audience:** integrators, operators, and adapter builders who need
> the closed contract for the proposal lifecycle. This page is
> information-oriented (Diátaxis reference): it mirrors
> `packages/core/src/state-machine.ts` line-for-line and explains
> the projection to the storage alphabet defined by the Postgres
> `CHECK` constraint. Procedural guidance for the lifecycle lives in
> [`docs/concepts/handoff-beat.md`](../concepts/handoff-beat.md).

> [Versión en español](state-machine.es.md) · English and Spanish are
> peer locales. Both siblings ship in the same pull request (zero-lag
> rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## What the state machine is

The state machine in `@cms/core` is a deterministic, pure transition
function over the proposal lifecycle. It has exactly eighteen states,
eleven actions, and one terminal state. The state machine never
performs I/O, never consults storage, and never resolves actor
authority; those checks live in the application service that
surrounds `transition()`.

The lifecycle covers authoring, validation, preview, approval, apply
(canonical write), propagation, go-live, reconciliation, and a
single one-action rollback from any failure branch or from the
post-live states.

## The eighteen states

Source: `packages/core/src/state-machine.ts:26-44`
(`ContentState` type) and `:46-65` (`ALL_STATES` array). The set is
**closed**: adding a state requires updating both the type alias and
the runtime array.

| # | State | Class |
| --- | --- | --- |
| 1 | `draft` | Initial |
| 2 | `proposed` | Initial |
| 3 | `validated` | Happy |
| 4 | `validation_failed` | Failure |
| 5 | `previewing` | Happy |
| 6 | `preview_failed` | Failure |
| 7 | `approved` | Happy |
| 8 | `approval_revoked` | Failure |
| 9 | `applying` | Happy |
| 10 | `apply_failed` | Failure |
| 11 | `canonical_written` | Happy (write beat) |
| 12 | `write_failed` | Failure |
| 13 | `propagating` | Happy |
| 14 | `propagate_failed` | Failure |
| 15 | `live` | Happy |
| 16 | `reconcile_failed` | Failure |
| 17 | `reconciled` | Happy (terminal-but-not-final) |
| 18 | `rolled_back` | Terminal |

Class counts: 10 non-failure, non-terminal states (including the write beat at
`canonical_written` and the post-live success state), 7 failure
branches, and 1 terminal. `draft` is the single initial state; `proposed`
is reached by the `submit` transition. `rolled_back` is the only terminal state.

### Terminal state — `rolled_back`

Source: `packages/core/src/state-machine.ts:67-69`.

```ts
export const TERMINAL_STATES: readonly ContentState[] = [
  'rolled_back',
] as const;
```

`rolled_back` is the only state from which no further transition is
defined. `isTerminalState` (`packages/core/src/state-machine.ts:204-206`)
returns `true` exclusively for `rolled_back`. After rollback, the
proposal is final; subsequent attempts to act on it return
`E_INVALID_TRANSITION`.

### Failure states (seven)

Source: `packages/core/src/state-machine.ts:71-79`.

```ts
export const FAILURE_STATES: readonly ContentState[] = [
  'validation_failed',
  'preview_failed',
  'approval_revoked',
  'apply_failed',
  'write_failed',
  'propagate_failed',
  'reconcile_failed',
] as const;
```

Each failure state is reachable from exactly one happy state by the
same action that would otherwise advance the lifecycle. Failure is
never silent and never implicit: a `validate` action moves from
`validated` to `validation_failed`, a `canonical_write` action moves
from `canonical_written` to `write_failed`, and so on.

## Happy path

Source: `packages/core/src/state-machine.ts:5-12` and `:100-128`
(`TRANSITIONS`).

```text
draft -> proposed -> validated -> previewing -> approved
      -> applying -> canonical_written -> propagating -> live -> reconciled
```

Nine sequential transitions. Each transition is one action:

| Step | From | Action | To |
| --- | --- | --- | --- |
| 1 | `draft` | `submit` | `proposed` |
| 2 | `proposed` | `validate` | `validated` |
| 3 | `validated` | `preview` | `previewing` |
| 4 | `previewing` | `approve` | `approved` |
| 5 | `approved` | `apply` | `applying` |
| 6 | `applying` | `canonical_write` | `canonical_written` |
| 7 | `canonical_written` | `propagate` | `propagating` |
| 8 | `propagating` | `go_live` | `live` |
| 9 | `live` | `reconcile` | `reconciled` |

`reconciled` is the post-live steady state. From `reconciled` the
next allowed transitions are `reconcile_fail` (back into the failure
branch) or `rollback` (terminal `rolled_back`).

## Failure paths

Every happy state from step 3 onward has a co-named failure state
that the same action reaches when the underlying operation does not
succeed. The failure state is named `<phase>_failed` (or
`approval_revoked` for the approval branch, which is an explicit
revocation rather than a technical failure). The transition table is:

| Step | From | Action | Failure target |
| --- | --- | --- | --- |
| 3 | `validated` | `validate` | `validation_failed` |
| 4 | `previewing` | `preview` | `preview_failed` |
| 5 | `approved` | `approve` | `approval_revoked` |
| 6 | `applying` | `apply` | `apply_failed` |
| 7 | `canonical_written` | `canonical_write` | `write_failed` |
| 8 | `propagating` | `propagate` | `propagate_failed` |
| 9 | `live` | `reconcile_fail` | `reconcile_failed` |
| 9b | `reconciled` | `reconcile_fail` | `reconcile_failed` |

There are no implicit failures. If the action is not listed for the
current state, `transition()` throws `InvalidTransitionError` and
returns `E_INVALID_TRANSITION`.

## One-action rollback

Source: `packages/core/src/state-machine.ts:18-21`
(rationale), `:119-127` (transitions).

```text
validation_failed   ──rollback──► rolled_back
preview_failed      ──rollback──► rolled_back
approval_revoked    ──rollback──► rolled_back
apply_failed        ──rollback──► rolled_back
write_failed        ──rollback──► rolled_back
propagate_failed    ──rollback──► rolled_back
reconcile_failed    ──rollback──► rolled_back
live                ──rollback──► rolled_back
reconciled          ──rollback──► rolled_back
```

A `rollback` action is permitted from any failure branch and from
either post-live state. The transition is a single one-action
move to the terminal `rolled_back` state. Revision targeting,
stale-base refusal, and the rollback-window check
(`E_ROLLBACK_WINDOW_EXPIRED`) are validated by the application
service before this pure transition; the state machine itself
only checks that the current state allows `rollback`.

### Write beat vs `rolled_back` terminal accuracy

The proposal terminal state is `rolled_back`. The write beat at
`canonical_written` is **not** a terminal state — it is the
canonical-write beat from which propagation continues. Confusion
between the two is the source of the only documented inaccuracy:

- After a successful `canonical_write`, the state is
  `canonical_written` and the proposal is not final. The remaining
  lifecycle (`propagate`, `go_live`, `reconcile`) runs from there.
- After `rollback`, the state is `rolled_back` and the proposal is
  final. No further action is permitted by the state machine.

A proposal whose terminal proposal state is `rolled_back` (read
from `ProposalState` after storage projection) is reported as
rolled back; a proposal whose last core state was
`canonical_written` is reported as having completed the canonical
write beat. The two states are distinct and never conflated.

## Action vocabulary (eleven)

Source: `packages/core/src/state-machine.ts:81-92`.

| Action | Used from |
| --- | --- |
| `submit` | `draft` |
| `validate` | `proposed`, `validated` |
| `preview` | `validated`, `previewing` |
| `approve` | `previewing`, `approved` |
| `apply` | `approved`, `applying` |
| `canonical_write` | `applying`, `canonical_written` |
| `propagate` | `canonical_written`, `propagating` |
| `go_live` | `propagating` |
| `reconcile` | `live` |
| `reconcile_fail` | `live`, `reconciled` |
| `rollback` | any failure branch, `live`, `reconciled` |

`allowedActions(state)` (`packages/core/src/state-machine.ts:212-214`)
returns the actions permitted from the given state — useful for UI
surfaces and audit rendering.

## Core ↔ storage projection

The storage alphabet is the subset of (and the projection target of)
the core lifecycle. The Postgres schema enforces the storage
alphabet via `CHECK` constraints; every persisted proposal row
carries exactly one `ProposalState`.

Source: `packages/core/src/state-machine.ts:228-244` (`ProposalState`).

| Core state | Storage state (`ProposalState`) |
| --- | --- |
| `draft` | `draft` |
| `proposed` | `proposed` |
| `validated` | `validated` |
| `previewing` | `previewing` |
| `approved` | `approved` |
| `applying` | `applying` |
| `canonical_written` | `canonical_written` |
| `propagating` | `propagating` |
| `live` | `live` |
| `reconciled` | `reconciled` |
| `validation_failed` | `refused` |
| `preview_failed` | `refused` |
| `approval_revoked` | `rolled_back` |
| `apply_failed` | `apply_failed` |
| `write_failed` | `apply_failed` |
| `propagate_failed` | `deploy_failed` |
| `reconcile_failed` | `reconcile_pending` |
| `rolled_back` | `rolled_back` |

The forward projection
(`mapContentStateToProposalState`,
`packages/core/src/state-machine.ts:301-303`) is total over
`ContentState`. The reverse projection
(`mapProposalStateToContentState`,
`packages/core/src/state-machine.ts:311-313`) is total over
`ProposalState`; storage rows outside the storage alphabet fail
closed inside `@cms/storage`'s decoder.

Core failure states that the schema's `CHECK` constraint does not
allow collapse onto the closest semantically equivalent storage
state. The audit row carries the original core state in the `event`
payload, so the projection is recoverable for diagnostic and
operator-facing UI.

## Why this contract is closed

The state machine is the single source of truth for "what state is
this proposal in?". The CLI, MCP, server, web, and adapter surfaces
all derive their observable state from `ContentState` and the
storage projection. A new state is a contract change: every consumer
and every localized message must ship in the same pull request.

The contract is also the only place where `E_INVALID_TRANSITION` and
`E_ROLLBACK_WINDOW_EXPIRED` are produced. Both error codes are part
of the Core union; see the [error code catalog](error-codes.md) for
the complete enumeration.
