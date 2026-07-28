# Adapter SDK

> **Audience:** integrators and adapter builders. This page is the closed
> contract reference for `@cms/adapter-sdk` — the frozen invariant-bearing
> shape every host adapter implements. It is information-oriented
> (Diátaxis reference): it mirrors the runtime union in
> `packages/adapter-sdk/src/index.ts` and the harness in
> `packages/adapter-sdk/src/conformance.ts` line-for-line. Procedural
> guidance for adapters that ship today lives in the companion page
> [`docs/adapters/cerafica.md`](../adapters/cerafica.md) · [`.es`](../adapters/cerafica.es.md).

> [Versión en español](adapter-sdk.es.md) · English and Spanish are
> peer locales. Both siblings ship in the same pull request (zero-lag
> rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## What the SDK is

`@cms/adapter-sdk` is the public contract that connects a host
repository to the system. It is intentionally **I/O-free**: it only
describes shapes, contracts, and boundaries. Adapters take these
shapes, perform the host work, and return the system-defined
receipts. The SDK never opens a file, runs a shell command, or
contacts a network.

The SDK partitions its surface into a **frozen core** (semver
`1.0.0`) and **provisional extensions** (`1.0.0-rc.1`). The major
line is the only field callers compare on; `provisional` and
`extensions` are informational.

| Surface | Version | Status |
| --- | --- | --- |
| Frozen core | `1.0.0` | Breaking changes require a major bump |
| Extensions | `1.0.0-rc.1` | Breaking changes allowed inside `1.0.0` |
| Surface identifier | `@cms/adapter-sdk` | The string every adapter contract declaration must echo |

Source: `packages/adapter-sdk/src/index.ts:96-129`
(`AdapterContractVersion`, `ADAPTER_SDK_FROZEN_VERSION`,
`ADAPTER_SDK_EXTENSIONS_VERSION`, `ADAPTER_SDK_SURFACE`,
`ADAPTER_FROZEN_CORE_METADATA`).

## Authority invariant

The adapter surface is a **write surface**, not an authority surface.
Approve, publish, and rollback are system-side and never delegated to
adapter paths. The SDK enforces this by refusing to expose any
approve, publish, apply-on-behalf-of, or rollback primitive through
`apply`. Adapters expose only canonical write intent plus receipt
return; the system decides whether to gate, approve, publish, or
roll back.

Concretely:

- Service and agent identities are refused at `apply` with
  `E_AUTHORITY_FORBIDDEN`. The harness verifies this on a live
  adapter.
- Approve / publish / rollback are not adapter methods. They live
  on the system side of the boundary.
- `DeployCapability` is advisory. The capability may report a
  deploy receipt; it may not claim authority over the apply,
  publish, or rollback beats.

Source: `packages/adapter-sdk/src/index.ts:46-52`,
`packages/adapter-sdk/src/conformance.ts:660-694`.

## Adapter identity

Adapters identify themselves with a namespaced `AdapterId` string of
the shape `@cms/adapters/<host>`. The system never pattern-matches
on the host segment for security decisions; the host segment is
informational and used only for routing.

```ts
import { brandAdapterId, type AdapterId } from '@cms/adapter-sdk';

const adapterId: AdapterId = brandAdapterId('@cms/adapter-cerafica');
```

The brand constructor is a `string & { readonly __brand: 'AdapterId' }`
that rejects empty strings at construction time. The contract version
field on the adapter is the single frozen-core declaration:

```ts
import {
  ADAPTER_SDK_VERSION,
  type Adapter,
  type AdapterContractVersion,
} from '@cms/adapter-sdk';

const contract: AdapterContractVersion = ADAPTER_SDK_VERSION;
```

Source: `packages/adapter-sdk/src/index.ts:135-147`.

## Frozen `RegionBinding` contract

The frozen `RegionBinding` from `@cms/core` is the only descriptor an
adapter receives. The SDK re-exports its three frozen fields
verbatim:

| Field (canonical / JSON) | Field (TS) | Frozen | Notes |
| --- | --- | --- | --- |
| `canonical_source` | `canonicalSource` | yes | Single host path the binding targets |
| `derived_artifacts` | `derivedArtifacts` | yes | Non-empty closed list of served paths |
| `regeneration_contract` | `regenerationContract` | yes | One mode today: `alias_symlink` |

`ADAPTER_FROZEN_CORE_METADATA` publishes the closed list of
`regionBindingContractFields`, `typeScriptProperties`, and
`regenerationModes` so downstream tools can introspect the frozen
surface without parsing TypeScript.

Source: `packages/adapter-sdk/src/index.ts:115-129`,
`packages/core/src/domain.ts`.

## Capability discovery (read-only)

Discovery is a **read-only advertisement**. The adapter answers two
questions: which frozen and provisional capabilities this host
implementation reliably supports, and for each binding, whether the
binding is unambiguous in this environment.

### Frozen capabilities (`AdapterCapability`)

The frozen capability set is closed. Anything outside it fails closed
at activation.

```ts
export type AdapterCapability =
  | 'canonical.read'
  | 'canonical.write'
  | 'derived.regenerate'
  | 'media.alias_symlink'
  | 'media.transcode'
  | 'binding.discover'
  | 'binding.activate'
  | 'binding.reconcile'
  | 'binding.apply';
```

### Provisional capabilities (`ProvisionalCapability`)

The provisional set is also closed. The harness reports these as
provisional, and the system treats any side effect they unlock as
experimental.

```ts
export type ProvisionalCapability =
  | 'field.capabilities.read'
  | 'field.capabilities.write'
  | 'deploy.receipt';
```

### Discovery result

`discover(input)` returns an `AdapterDiscovery`:

| Field | Type | Meaning |
| --- | --- | --- |
| `adapterId` | `AdapterId` | The adapter identity |
| `contract` | `AdapterContractVersion` | The frozen / extensions / surface declaration |
| `frozenCapabilities` | `readonly AdapterCapability[]` | Closed-set subset the host reliably supports |
| `provisionalCapabilities` | `readonly ProvisionalCapability[]` | Closed-set subset the host supports, marked provisional |
| `candidates` | `readonly AdapterDiscoveryCandidate[]` | Per-binding activation readiness |

A `candidate` with an empty `issues` array means the binding is
unambiguous and may proceed to activation. A non-empty `issues`
array means the harness MUST refuse activation.

Source: `packages/adapter-sdk/src/index.ts:149-216`.

## Activation

Activation turns a discovered binding into a live, unambiguous
adapter instance. The harness requires `ok === true` to consider
activation complete.

`AdapterActivation` fields:

| Field | Meaning |
| --- | --- |
| `adapterId`, `bindingId`, `tenantId`, `environment` | Identity echoed from the binding |
| `ok` | `true` when activation succeeded |
| `refusalReasons` | Human-readable refusal reasons; empty when `ok === true` |
| `enabledCapabilities` | Closed-set capabilities the activation enabled for this binding |
| `contract` | `AdapterActivationContract` snapshot of the resolved regeneration contract |

An `AdapterActivationContract` carries the resolved alias path,
alias targets, regeneration mode, and canonical repo path. When
`ok === false`, this field still reflects the contract the adapter
would have used so the harness can audit ambiguity.

Activation is refused when:

- `derived_artifacts[]` is empty.
- `regeneration_contract.mode` is not `alias_symlink`.
- A derived artifact collides with the canonical source path.
- Alias targets collide with the canonical source path more than
  once.
- The alias path is self-referential or escapes the repository root.

Source: `packages/adapter-sdk/src/index.ts:218-250`,
`packages/adapter-sdk/src/conformance.ts:413-492`.

## Reconciliation (idempotent drift check, no writes)

Reconcile compares the canonical source against the served or
derived artifacts and reports whether they are in sync. Reconcile
**MUST NOT** mutate host state. The receipt is the only thing it
returns.

`AdapterReconcileReceipt`:

| Field | Meaning |
| --- | --- |
| `adapterId`, `bindingId`, `tenantId`, `environment` | Identity echoed from the binding |
| `observedAt` | `Iso8601` timestamp of the observation |
| `inSync` | `true` iff every derived artifact matches the canonical state |
| `drift` | `readonly AdapterDriftEntry[]` — per-artifact declared-vs-observed hash deltas |

A `drift` entry describes one artifact whose current hash differs
from the hash the binding declared. Reconcile is observational; the
adapter never attempts to repair drift from this call.

Reconcile is the upstream precondition for `apply`: apply refuses to
run before reconcile has observed the latest canonical state.

Source: `packages/adapter-sdk/src/index.ts:252-282`.

## Apply (canonical-only write intent)

Apply is the **canonical-only** write intent. The SDK defines the
shape; the adapter performs the host work.

`CanonicalWrite`:

| Field | Meaning |
| --- | --- |
| `adapterId`, `bindingId`, `tenantId`, `environment` | Identity echoed from the binding |
| `target.repoPath` | The canonical source path. **MUST NOT** be a derived artifact or the alias path |
| `target.contract` | `AdapterActivationContract` the adapter must obey |
| `bytes` | `AdapterWritePayload` (`utf8` text or `base64` data) |
| `actor` | `Identity` driving the write |
| `contentHash?` | Optional content hash captured by the host |

`AdapterApplyReceipt` echoes the contract that was applied, the
canonical repo path that was materialised, the canonical hash, the
applied timestamp, and the actor. The system audits this receipt;
the adapter never returns authority decisions from this call.

The frozen rule: `target.repoPath` MUST be the canonical source
path. Any request whose target is a derived artifact path is refused
with `E_DERIVED_WRITE_FORBIDDEN`; any request whose target is the
alias path is refused with `E_ALIAS_WRITE_FORBIDDEN`. Both are
rejected before any host work happens.

Source: `packages/adapter-sdk/src/index.ts:284-345`.

## Adapter interface

Every host implementation satisfies the same `Adapter` shape:

```ts
export interface Adapter {
  readonly id: AdapterId;
  readonly contract: AdapterContractVersion;
  discover(input: DiscoverInput): Promise<AdapterDiscovery>;
  activate(input: ActivateInput): Promise<AdapterActivation>;
  reconcile(input: ReconcileInput): Promise<AdapterReconcileReceipt>;
  apply(input: CanonicalWrite): Promise<AdapterApplyReceipt>;
}
```

Product-specific behaviour lives in the implementation, not in the
contract. The harness treats any deviation as a contract failure.

Source: `packages/adapter-sdk/src/index.ts:347-388`.

## Provisional extensions (`1.0.0-rc.1`)

Two host-specific surfaces are provisional and may move within the
`1.0.0` major line.

### Field capability gating

`FieldCapabilityValue` is a closed literal set:

| Value | Meaning |
| --- | --- |
| `read_only` | Field is exposed for display; no edits through the authoring surface |
| `coordinator_gated` | Edits gated by a host-specific coordinator; the system only forwards the intent |
| `free_edit` | Edits flow through the canonical write path with no additional host coordination |

`FieldCapabilitiesSnapshot` is what an adapter returns from the
provisional `field.capabilities.read` capability. The frozen core
does not interpret these values; the system reads the value to
choose the entry point; the adapter enforces the enforcement.

### Deploy capability

`DeployCapabilityKind` is a closed literal set:

| Value | Meaning |
| --- | --- |
| `cdn.purge` | CDN purge integration |
| `search.reindex` | Search index reindex |
| `marketing.notify` | Marketing-system notification |
| `cache.invalidate` | Cache invalidation |

`DeployCapability` is purely advisory. The system owns approve,
publish, and rollback; an adapter that exposes this capability MUST
NOT use it to claim authority over those actions. Disabled
capabilities are still advertised so the system can reason about
parity, but they are no-ops.

Source: `packages/adapter-sdk/src/index.ts:390-470`.

## Closed refusal-code union

The SDK exposes a closed union of refusal codes through the runtime
constant `ADAPTER_REFUSAL_CODES`. Callers pattern-match on `code`;
`message` is for humans only. The closed union is the
machine-readable contract; the type alias `AdapterRefusalCode` is
derived from the runtime constant via `typeof
ADAPTER_REFUSAL_CODES[number]`.

| Code | When the SDK returns it |
| --- | --- |
| `E_AMBIGUOUS_BINDING` | Activation refused because the binding is ambiguous (more than one canonical pointer to the same path, self-referential alias target, alias target that collides with the canonical source path, empty derived artifacts, or a regenerated contract that does not echo the binding) |
| `E_DERIVED_WRITE_FORBIDDEN` | `apply` refused because the write target is a derived artifact path or escapes the repository root |
| `E_ALIAS_WRITE_FORBIDDEN` | `apply` refused because the write target is the alias path |
| `E_UNSUPPORTED_CAPABILITY` | Activation refused because the adapter advertised a capability outside the closed frozen set |
| `E_CONTRACT_VERSION_MISMATCH` | Activation refused because the adapter's frozen major does not match the SDK's frozen major |
| `E_PROVISIONAL_OUT_OF_SCOPE` | Activation refused because the adapter advertised a provisional capability it has not explicitly enabled |
| `E_AUTHORITY_FORBIDDEN` | `apply` refused because the actor is a service or agent identity |
| `E_BINDING_NOT_FOUND` | `apply` refused because the binding was not discovered or activated, or the manifest / canonical source could not be read |
| `E_ENVIRONMENT_MISMATCH` | `apply` refused because the write's environment does not match the binding's environment |

`AdapterContractError` carries `code`, `message`, and `details`. The
`code` is the machine-readable refusal; `message` is human prose;
`details` is a frozen `Record<string, unknown>` for diagnostic
metadata (e.g. `repoPath`, `symlinkCode`, `bindingId`).

Source: `packages/adapter-sdk/src/index.ts:472-505`.

## Conformance harness

The SDK ships an independent, reusable conformance harness so
adapter authors and system integrators can verify, without any
product-specific knowledge, that an adapter:

1. Declares a contract version compatible with the SDK's frozen
   major and reports the provisional extension range explicitly.
2. Does not allow alias writes to be requested (alias paths and
   alias targets are derived artifacts, not canonical sources).
3. Refuses to activate ambiguous bindings.
4. Fails closed on unsupported capabilities.
5. Refuses to represent approval or publication authority through
   any service or agent path.

The harness is intentionally product-agnostic. It works on the
shapes declared in `index.ts` and on `RegionBinding` from
`@cms/core`. The fixture builder `makeConformanceFixtures()`
constructs a valid binding plus four ambiguous bindings — one whose
alias targets collide with the canonical source path twice, one
self-alias, one relative-escaping alias, and one with empty derived
artifacts — and three identities: a human, a service, and an
agent-shaped MCP identity.

```ts
import { makeConformanceFixtures, runConformance } from '@cms/adapter-sdk';

const report = await runConformance(adapter, makeConformanceFixtures());
if (!report.ok) {
  // inspect report.checks for the failing probe
}
```

`ConformanceCheck` carries `name`, `ok`, and `details`. The harness
names include `contract.version`, `discovery`, `activation.valid`,
`activation.ambiguous_refused`, `reconcile`, `apply.canonical`,
`apply.derived_refused`, `apply.alias_refused`,
`apply.service_refused`, `apply.agent_refused`,
`apply.environment_refused`, and `capability.fail_closed`.

Source: `packages/adapter-sdk/src/conformance.ts:1-160`,
`packages/adapter-sdk/src/conformance.ts:181-305`.

## Frozen-core evidence anchors

- `packages/adapter-sdk/src/index.ts` — frozen
  `canonical_source` / `derived_artifacts` / `regeneration_contract`
  contract; `alias_symlink` is the only frozen mode; reconcile is
  read-only, apply is canonical-only; closed `ADAPTER_REFUSAL_CODES`
  union.
- `packages/adapter-sdk/src/conformance.ts` — refusal harness for
  service / agent apply paths; read-only probes and adversarial
  apply probes; closed-set capability advertisement check.
- `packages/core/src/domain.ts` — `RegionBinding`,
  `CanonicalSource`, `DerivedArtifact`, `RegenerationContract`,
  `assertRegionBinding`.
- `packages/adapter-cerafica/src/index.ts` — first reference
  implementation; see [`docs/adapters/cerafica.md`](../adapters/cerafica.md) ·
  [`.es`](../adapters/cerafica.es.md).
- `packages/adapter-cerafica/src/symlink.ts` — single point at
  which an adapter inspects a verified filesystem alias.

## Open constraints

The second adapter is the **v1.1 conformance gate**, not a V1
completion claim. The SDK's host-specific extension fields remain
provisional until a second adapter exercises them; see
[`docs/overview.md`](../overview.md) · [`.es`](../overview.es.md) and
[`docs/evidence/limitations.md`](../evidence/limitations.md). The closed union
documented above is what V1 ships.