# Content boundary

> **Audience:** everyone who needs the mental model for the **boundary between host content and CMS governance**. This page explains how a single canonical host path becomes a served projection without ever being written through, how commerce stays coordinator-gated, and how rollback and live propagation remain separate beats. The product-level invariant is repeated across [`docs/overview.md`](../overview.md) and [`docs/concepts/architecture.md`](architecture.md); this concept page collects the boundary into one self-contained reference.

The content boundary is **not** a permission list. It is a write/read topology. The host repository is the only place authoritative content bytes live; the CMS owns the proposal, approval, audit, preview, reconciliation, and one-action rollback that wrap that write.

## The shape of the boundary

A region binding declares three frozen fields:

- `canonical_source` — the single authoritative host path the binding targets. The host keeps the bytes.
- `derived_artifacts[]` — the closed list of served or derived paths the adapter maintains. Adapters must never be asked to write these directly.
- `regeneration_contract` — how canonical writes are materialized into served form. v1 recognises exactly one mode: `alias_symlink`.

The CMS writes `canonical_source`. The host serves `derived_artifacts`. Nothing else crosses the boundary on the write side.

## Canonical source versus derived artifacts

Canonical source is a real, host-native file. For the Cerafica reference deployment, the products canonical path is `inventory/products.json`. Adapters resolve it through the host backend; the system reads through this pointer ([`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts#L11-L23), [`packages/storage/src/schema.ts`](../../packages/storage/src/schema.ts#L186-L233)).

Derived artifacts are a closed list of served or derived paths. For Cerafica products, the served path is `website/data/products.json`. The contract is explicit: **adapters must not be asked to write derived artifacts directly** ([`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts#L11-L23)). Direct writes to derived paths are refused at the adapter boundary with `E_DERIVED_WRITE_FORBIDDEN`.

## The `alias_symlink` regeneration contract

For `alias_symlink` mode, the served path is a filesystem alias whose target resolves to the canonical source. Cerafica declares:

- canonical: `inventory/products.json`
- served alias: `website/data/products.json`
- declared alias target: `../../inventory/products.json` (resolved against the repository root)

The adapter does not "copy" bytes into the served path. It verifies the alias exists, is a symlink (not a regular file), resolves within the repository, has no cycle, and points at the canonical source. A missing, broken, retargeted, escaping, looped, or replaced-with-regular-file alias is refused at activation; reconcile re-runs the same verification and refuses to report success until the alias is healthy ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L1-L24), [`packages/adapter-cerafica/src/symlink.ts`](../../packages/adapter-cerafica/src/symlink.ts)).

Concretely: at apply time, only `inventory/products.json` is written. At serve time, the website reads `website/data/products.json`, which the operating system resolves to `inventory/products.json`. There is no second source of truth and no opportunity for the two to drift.

## No direct alias writes

The CMS never writes through an alias. The adapter's `apply` refuses any write whose target is the alias path or any other derived artifact ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L1213-L1223)). Symlinks are not even visible to the write path: writes resolve to the canonical target the adapter selected, and the alias is verified, not authored.

The same rule applies to regeneration. Regeneration is the act of re-establishing the alias (or re-verifying it) after a canonical write. It is not a write into the served artifact. The alias_symlink contract closes the loop without crossing the boundary in reverse.

## The Cerafica products binding at a glance

| Field | Value |
| --- | --- |
| Canonical source | `inventory/products.json` |
| Served alias | `website/data/products.json` |
| Alias target (declared) | `../../inventory/products.json` |
| Regeneration mode | `alias_symlink` (only frozen v1 mode) |
| Source of truth | host repository |
| Write target at apply | `inventory/products.json` only |

The Cerafica reference deployment exposes three editable surfaces — hardcoded HTML pages, the structured JSON products region described above, and the Kyanite journal API. One `@cms/adapter-cerafica` adapter mediates all three, with the same canonical-only / verified-alias shape ([`packages/adapter-cerafica/package.json`](../../packages/adapter-cerafica/package.json)).

## Commerce is coordinator-gated

Commerce-coupled fields are **not** part of the author surface. Cerafica's Stripe-coupled fields (`price`, `stripe_payment_link`, `available`, `coming_soon`, `one_of_one`) default to read-only / coordinator-gated, and `capabilities.coordinator` is the frozen literal `readonly` with `failClosed: true` ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L152-L160), [`docs/overview.md`](../overview.md)).

The enforcement is **id-matched** at the canonical write boundary: each product in the proposed bytes is matched by id to a product in the existing canonical bytes; mismatches (added/removed ids) are refused, and mutations to the closed commerce field set on matched ids are refused. When the canonical file does not yet exist, introducing products is refused; malformed or non-array input fails closed ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L1478-L1582)).

This means:

- The CMS writes the canonical file. It does not encode a commerce change.
- Free-editing `price` without regenerating the Payment Link would create a checkout / display mismatch; flipping `available`, `coming_soon`, or `one_of_one` without inventory coordination would create an availability or oversell risk. The boundary prevents that path by construction.
- The commerce coordinator remains the authority for commerce mutations. The CMS surfaces the failure mode but does not become a coordinator itself.

The same gating runs before the rollback writer commits any bytes, so rollback cannot become a bypass hatch against coordinator-gated authority ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L683-L710), [`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L1024-L1050)).

## Reconcile is read-only

`reconcile` is a read-only operation. It re-runs alias verification and the canonical hash check; it does not write. `apply` is canonical-only and refuses to run before reconcile has observed the latest canonical state ([`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts#L33-L44)). The cerafica adapter enforces this on top: apply writes the canonical `inventory/products.json`; reconcile re-verifies the alias and the hash and reports state, never bytes ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L11-L24)).

## Rollback completes at `canonical_written`

A governed rollback is one compensating human-authorized action. It does not replay credentials or impersonate the original approver, and it does not push a synthetic "live" receipt. The governed adapter write boundary completes at **`canonical_written`**, not at `live`; the governed proposal lifecycle transitions to terminal **`rolled_back`** and is audited as `proposal.rolled_back`. Asynchronous deployment reconciliation follows the canonical write and reports separately if and when the served site catches up ([`packages/core/src/state-machine.ts`](../../packages/core/src/state-machine.ts#L1-L16), [`docs/concepts/governance-and-human-authority.md`](governance-and-human-authority.md)).

The cerafica adapter mirrors this exactly: rollback writes canonical bytes and returns `canonical_written`. The proposal lifecycle records terminal `rolled_back`; a subsequent asynchronous reconcile follows the canonical write and does not claim `live` ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L1213-L1238), [`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L860-L871)).

## Asynchronous deployment reconciliation

Live propagation is a separate beat. A deploy capability may report `succeeded`, `failed`, or `cancelled`; those are deploy-receipt states, not proposal states. The trigger surfaces an immediately terminal receipt — no `canonical_written` return hides a `failed` or `cancelled` outcome; a malformed terminal receipt throws and leaves no `pending`/`terminal` state behind for a later reconcile to resurrect ([`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts#L749-L796)).

Concretely:

1. `apply` writes the canonical file. The proposal transitions to `canonical_written`.
2. The deploy capability reports receipt(s) asynchronously. The publication row tracks them; the proposal is left in `canonical_written` until a terminal receipt arrives.
3. A `failed` receipt is recorded as failed while the proposal stays in `canonical_written`. The proposal does not silently move through an intermediate `propagating` state it never visited. The receipt row is the authoritative failure record.
4. A `succeeded` receipt closes the live beat. Until that arrives, the proposal's deployment status is "deploy pending" from the author's perspective.

The CMS tracks `canonical_written` versus `live`/`live_propagated` and reconciles the two; it does not collapse them into a single state.

## What the host remains

The host repository remains content truth. Every content byte and every asset lives in the host; Handoff CMS owns only the governed projection around it. The boundary is enforced by the topology: one canonical write target, a closed derived-artifact list, one regeneration mode, a coordinator-gated commerce contract, and a state machine that distinguishes canonical bytes from live propagation. None of this is a deployment-convergence claim; what is described here is the contract the system enforces when it touches the host, not a claim about any specific live deployment.

## Evidence

- [`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts) — frozen `canonical_source` / `derived_artifacts` / `regeneration_contract` contract; `alias_symlink` is the only frozen mode; reconcile is read-only, apply is canonical-only.
- [`packages/adapter-sdk/src/conformance.ts`](../../packages/adapter-sdk/src/conformance.ts) — refusal harness for service / agent apply paths; read-only probes and adversarial apply probes.
- [`packages/core/src/domain.ts`](../../packages/core/src/domain.ts) — domain types, `E_BAD_REGENERATION_MODE`, `E_EMPTY_DERIVED_ARTIFACTS`.
- [`packages/core/src/state-machine.ts`](../../packages/core/src/state-machine.ts) — canonical_written is distinct from propagating / live; rollback lands at terminal `rolled_back`.
- [`packages/storage/src/schema.ts`](../../packages/storage/src/schema.ts) — frozen `canonical_source`, `derived_artifacts[]`, `regeneration_contract` jsonb columns; mode check constraint.
- [`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql) — table-level invariants, publication row carries `canonical_written_at` / `live_at`, deploy receipt table is the authoritative failure record.
- [`packages/api/src/index.ts`](../../packages/api/src/index.ts) — distinct `canonical_written` and `live_propagated` beats; failed receipt leaves the proposal at `canonical_written`.
- [`packages/adapter-cerafica/src/index.ts`](../../packages/adapter-cerafica/src/index.ts) — cerafica adapter behavior; alias verification, canonical-only writes, coordinator-gated commerce, `alias_symlink` is the only mode, rollback completes at `canonical_written`.
- [`packages/adapter-cerafica/src/symlink.ts`](../../packages/adapter-cerafica/src/symlink.ts) — single point at which the adapter inspects the products symlink.
- [`packages/adapter-cerafica/package.json`](../../packages/adapter-cerafica/package.json) — host contract summary: canonical `inventory/products.json`, served alias `website/data/products.json`.