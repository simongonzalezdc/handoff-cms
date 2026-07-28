# Governance and human authority

Governance is an explicit lifecycle: **propose → validate → approve → publish → canonical_written → (optional) live propagation → rollback**. A proposal is intent; the approved revision is immutable. The host remains canonical, and every transition is policy-checked, version-checked, idempotent, and audit-recorded.

## Human-controlled lifecycle

1. **Propose.** An author or automation submits a localized (`en` and `es`) proposal. The API validates it and records proposer identity and payload hash.
2. **Approve.** A current human authorization event is required. Self-approval is represented explicitly (`selfApproved`) and is allowed only when current policy permits it; it is never inferred.
3. **Publish.** A human-authorized transition writes the approved revision to the host `canonical_source`. The API returns `canonical_written`; this is not a claim that a remote site is live.
4. **Propagate/reconcile.** A narrowly scoped adapter may report deployment receipts. `live`/`live_propagated` is a separate beat. Failed propagation is recorded as failed while the proposal remains `canonical_written` (fail closed).
5. **Rollback.** One current human authorization action may roll back under current policy and optimistic version checks. It does not replay credentials or impersonate the original approver. Audit records rollback lineage.

## Delegated-human sessions

A delegated-human identity is still a human identity: it carries `delegatorId`, `delegatedAt`, and `delegatedUntil`, and the API rechecks session liveness. The CLI obtains privileged credentials only through a fresh interactive browser/device flow (`delegated_human_fresh_interactive`). Static environment, service, agent, and MCP credentials fail closed. Delegation is recorded in proposal, approval, and audit data; it does not erase the responsible human.

## Eight approved invariants (verbatim checklist)

1. `canonical_source` is the single authoritative host reference.
2. `derived_artifacts` are a closed list and are never direct write targets.
3. `regeneration_contract` is explicit; v1 recognises only `alias_symlink`.
4. Adapters must resolve one unambiguous binding; ambiguous, escaping, self-referential, or empty bindings are refused.
5. Reconcile is read-only and apply is canonical-only, after current-state reconciliation.
6. Approve, publish, and rollback are system-side human-authority transitions, never adapter authority.
7. Localized values require both `en` and `es`; missing locales are rejected, never silently defaulted.
8. Canonical write and live propagation are separate states; rollback ends at `canonical_written`.

## Privileged-transition prohibition

The API rejects service identities and identities carrying the `mcp` capability before policy evaluation for approve, publish, and rollback (`E_SERVICE_APPROVAL_FORBIDDEN`, `E_MCP_APPROVAL_FORBIDDEN`). Agents and MCP tools may propose or report scoped deployment receipts where allowed; they cannot manufacture human approval, publish authority, or rollback authority. No silent fallback or impersonation is permitted.

## Evidence

- `packages/api/src/auth.ts`, `index.ts`, `openapi.ts`
- `packages/core/src/domain.ts`, `policy.ts`, `state-machine.ts`
- `packages/cli/src/index.ts`
- `packages/adapter-sdk/src/index.ts`, `packages/adapter-cerafica/src/index.ts`
- `packages/audit/src/index.ts`
