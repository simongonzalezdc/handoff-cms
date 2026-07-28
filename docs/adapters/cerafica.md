# Cerafica reference adapter

> **Audience:** integrators and adapter builders. This page is the
> reference companion to [`docs/reference/adapter-sdk.md`](../reference/adapter-sdk.md) ·
> [`.es`](../reference/adapter-sdk.es.md) for the Cerafica host
> repository. It documents the Cerafica adapter surface as it ships
> today: the `website/cms-regions.json` manifest, the
> `inventory/products.json` canonical product inventory, the
> verified symlink alias at `website/data/products.json`, the
> commerce mapping, the coordinator gating, and the dogfood mapping
> from the cerafica host surface to `@cms/adapter-cerafica` exports.

> [Versión en español](cerafica.es.md) · English and Spanish are
> peer locales. Both siblings ship in the same pull request (zero-lag
> rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## Manifest

The cerafica adapter reads a single manifest file at
`website/cms-regions.json` at adapter construction time. The
manifest is the closed contract the host ships; the adapter refuses
to load any value that does not match the shape exactly.

### Manifest shape (locked: `cms-regions/v1`, version `1`)

| Field | Literal | Meaning |
| --- | --- | --- |
| `version` | `1` | The only accepted manifest version |
| `manifestSchema` | `"cms-regions/v1"` | The only accepted manifest schema |
| `host.repo` | `"cerafica"` | Host identifier |
| `host.deployMode` | `"github_pages"` | The only accepted deploy mode today |
| `host.canonicalProductPath` | non-empty string | Repository-relative path of the canonical products file |
| `host.servedProductPath` | non-empty string | Repository-relative path of the served alias |
| `regeneration.mode` | `"alias_symlink"` | The only accepted regeneration mode |
| `regeneration.source` | non-empty string | Repository-relative path the served alias resolves to (typically the canonical path) |
| `regeneration.target` | non-empty string | Repository-relative path the served alias points at (resolved against the alias directory) |
| `regeneration.readonly` | `true` | The only accepted value |
| `capabilities.journal.provider` | non-empty string | Journal provider identifier |
| `capabilities.journal.mode` | `"readonly"` | The only accepted mode |
| `capabilities.journal.source` | `"discovered"` | The only accepted source |
| `capabilities.journal.module` | non-empty string | Repository-relative path of the journal module the adapter can discover |
| `capabilities.fields` | object keyed by commerce field | Each entry MUST have `mode: "readonly"` |
| `capabilities.coordinator` | `"readonly"` | The only accepted value |
| `capabilities.failClosed` | `true` | The only accepted value |
| `localization.altPolicy.mode` | `"peer-required"` | The only accepted mode |
| `localization.altPolicy.languages` | `["en", "es"]` | The only accepted ordered pair |
| `localization.altPolicy.hostCopyLanguage` | `"en"` | The only accepted value |
| `anchors.home.heroText` | non-empty string | Hero copy on the home page |
| `anchors.home.featuredImage.id` | non-empty string | Featured image asset id |
| `anchors.home.featuredImage.alt` | non-empty string | Featured image alt text |
| `anchors.home.sections.container` | non-empty string | Selector of the sections container |
| `anchors.home.sections.section` | non-empty string | Selector of an individual section |
| `anchors.shop.productCollection.container` | non-empty string | Selector of the product collection container |

`parseManifest(value)` rejects any value whose shape, keys, or
literals do not match. The validator surfaces errors as
`ManifestValidationError(field, message)`; the adapter wraps manifest
load failures as `AdapterContractError` with `E_BINDING_NOT_FOUND`
and `details.manifestPath`.

Source: `packages/adapter-cerafica/src/index.ts:126-573`.

## Canonical product inventory

The cerafica adapter's only editable surface is the canonical
products file. The shipped cerafica repo stores it at
`inventory/products.json`; the manifest's
`host.canonicalProductPath` declares this path and the adapter
treats it as the single source of truth.

The file's shape is a top-level JSON array of product records.
Each record carries at minimum:

- `id` — a unique, non-empty string. The id is the join key used by
  the id-matched commerce gating check. Duplicate or missing ids fail
  closed with `E_BINDING_NOT_FOUND` and
  `details.repoPath === <canonicalRelPath>`.
- `stripe_payment_link`, `price`, `available`, `coming_soon`,
  `one_of_one` — the closed set of commerce fields. The adapter
  enforces these as coordinator-gated at the apply boundary.

Safe descriptive and image fields remain writable: title, slug,
description, image ids, alt text, sort order, taxonomy, and any
host-defined metadata that does not overlap the closed commerce
set.

The adapter materializes the approved payload into a `Buffer` and writes those
bytes verbatim to the canonical file; it does not parse and reserialize JSON
during the write. Commerce and confinement checks run before the write. A
successful apply returns the sha256 digest of the same materialized bytes,
which the system audits as the canonical hash.

Source: `packages/adapter-cerafica/src/index.ts:1227-1246`,
`packages/adapter-cerafica/src/index.ts:1392-1395`, and
[`docs/concepts/content-boundary.md`](../concepts/content-boundary.md).

## Verified symlink alias

`website/data/products.json` is a **filesystem symlink**, not a
regular file. The cerafica repo ships it pointing at
`../../inventory/products.json` (resolved against the alias
directory). At activation and at every reconcile, the adapter
verifies the alias through `verifyAlias`
(`packages/adapter-cerafica/src/symlink.ts`).

The verifier performs, in order:

1. `lstat` the alias path. A missing entry fails with
   `E_ALIAS_MISSING`; a non-symlink entry fails with
   `E_ALIAS_NOT_SYMLINK`.
2. `readlink` the alias path and capture the chain.
3. Walk the chain via real `readlink` calls, detecting loops with a
   bounded hop counter (`MAX_SYMLINK_HOPS = 40`) and detecting
   escaping paths via realpath.
4. Compare the resolved canonical absolute path to the declared
   target. A mismatch fails with `E_ALIAS_RETARGETED`.
5. `readFile` the canonical path and compute its sha256 hex digest.
   The digest is exposed so reconcile can re-check it without
   re-reading the bytes.

The verifier refuses any of the following shapes:

| Shape | Symlink refusal code |
| --- | --- |
| Alias entry does not exist | `E_ALIAS_MISSING` |
| Alias entry exists but is not a symlink | `E_ALIAS_NOT_SYMLINK` |
| A `readlink` call or `realpath` call fails | `E_ALIAS_BROKEN` |
| Alias resolves to a different path than the declared target | `E_ALIAS_RETARGETED` |
| Alias chain resolves outside the repository root | `E_ALIAS_ESCAPING` |
| Alias chain exceeds `MAX_SYMLINK_HOPS` or forms a loop | `E_ALIAS_LOOPED` |
| Canonical file is missing or unreadable | `E_CANONICAL_MISSING` |

These are the symlink-specific refusal codes exported by the
constant `SYMLINK_REFUSAL_CODES` from
`packages/adapter-cerafica/src/symlink.ts`. The adapter maps each
symlink refusal to a closed SDK-level refusal code through
`mapSymlinkRefusalToAdapterCode`. Today the mapping is closed and
exhaustive: every symlink refusal maps to `E_AMBIGUOUS_BINDING`,
and the original symlink code is preserved on
`AdapterContractError.details.symlinkCode`. There is intentionally
**no** `E_ALIAS_HASH_MISMATCH` code in either union: the declared
verifier contract supplies no expected hash, so a refusal code of
that name can never be produced. Leaving it would either be a dead
string or a programmer error.

The closed `SYMLINK_REFUSAL_CODES` union is:

```ts
export const SYMLINK_REFUSAL_CODES = [
  'E_ALIAS_MISSING',
  'E_ALIAS_BROKEN',
  'E_ALIAS_NOT_SYMLINK',
  'E_ALIAS_RETARGETED',
  'E_ALIAS_ESCAPING',
  'E_ALIAS_LOOPED',
  'E_CANONICAL_MISSING',
] as const;
```

Source: `packages/adapter-cerafica/src/symlink.ts:33-58`,
`packages/adapter-cerafica/src/symlink.ts:340-368`.

## Symlink refusal codes by `SYMLINK_REFUSAL_CODES` symbol

The cerafica adapter exposes the symlink-specific refusal union
through the runtime constant `SYMLINK_REFUSAL_CODES` and the type
alias `SymlinkRefusalCode` derived from it. The harness and the
adapter consult this union directly. The mapping from symlink
refusal to SDK refusal is the closed function
`mapSymlinkRefusalToAdapterCode`:

| Symlink refusal (`SYMLINK_REFUSAL_CODES`) | SDK refusal (`ADAPTER_REFUSAL_CODES`) |
| --- | --- |
| `E_ALIAS_MISSING` | `E_AMBIGUOUS_BINDING` |
| `E_ALIAS_BROKEN` | `E_AMBIGUOUS_BINDING` |
| `E_ALIAS_NOT_SYMLINK` | `E_AMBIGUOUS_BINDING` |
| `E_ALIAS_RETARGETED` | `E_AMBIGUOUS_BINDING` |
| `E_ALIAS_ESCAPING` | `E_AMBIGUOUS_BINDING` |
| `E_ALIAS_LOOPED` | `E_AMBIGUOUS_BINDING` |
| `E_CANONICAL_MISSING` | `E_AMBIGUOUS_BINDING` |

`AdapterContractError` carries the symlink code in
`details.symlinkCode` and the SDK code as `code`. The mapping is
the single closed translation between the symlink-specific and the
SDK-wide closed refusal-code unions.

Source: `packages/adapter-cerafica/src/symlink.ts:340-368`.

## Canonical-only writes

The cerafica adapter writes **only** to the canonical path declared
by the manifest's `host.canonicalProductPath`. The system never
writes through the symlink alias. At apply time, the adapter
refuses any write whose target is:

- The alias path (`website/data/products.json`) —
  `E_ALIAS_WRITE_FORBIDDEN`.
- Any entry in the binding's `derived_artifacts[]` —
  `E_DERIVED_WRITE_FORBIDDEN`.
- A path that is not the manifest's `regeneration.source` —
  `E_DERIVED_WRITE_FORBIDDEN`.
- An absolute path or a path containing `..` segments — the adapter
  rejects them before any host work happens
  (`E_DERIVED_WRITE_FORBIDDEN`).

The apply boundary further enforces the binding-id and environment
match:

- A write whose `bindingId` does not match the activated binding is
  refused with `E_BINDING_NOT_FOUND`.
- A write whose `environment` does not match the binding's
  environment is refused with `E_ENVIRONMENT_MISMATCH`.
- A write whose `actor` is a service or agent identity is refused
  with `E_AUTHORITY_FORBIDDEN`. The cerafica adapter consults
  `isServiceIdentity` from `@cms/core` for this check; both
  service and agent-shaped MCP identities are refused.

Source: `packages/adapter-cerafica/src/index.ts:1183-1244`,
`docs/reference/adapter-sdk.md` ·
[`.es`](../reference/adapter-sdk.es.md).

## Commerce mapping

The cerafica adapter advertises a closed set of commerce fields
derived from the manifest's `capabilities.fields` object. The
mapping is the single source of truth for what the host calls each
commerce field and what the adapter enforces.

| Advertised label | Host JSON keys (in canonical `inventory/products.json`) |
| --- | --- |
| `stripe` | `stripe_payment_link` |
| `payment` | `stripe_payment_link` |
| `price` | `price` |
| `availability` | `available`, `coming_soon` |
| `one_of_one` | `one_of_one` |

The advertised `CommerceField` set (manifest `capabilities.fields`,
the `fieldCapabilities()` snapshot, and the
`enforceCommerceFieldGating` iteration) is derived from this
mapping. There is no divergent schema-key list anywhere else in the
adapter; the host schema is authoritative and this mapping only
names the slice the adapter gates.

The closed `ENFORCED_HOST_KEYS` set, deduplicated in first-seen
order, is:

```
stripe_payment_link, price, available, coming_soon, one_of_one
```

(`stripe` and `payment` both map to `stripe_payment_link`; the
adapter dedupes while preserving stable order so refusal messages
remain stable across runs.)

Source: `packages/adapter-cerafica/src/index.ts:188-250`,
`packages/adapter-cerafica/src/index.ts:1467-1582`.

## Commerce coordinator gating

The cerafica adapter enforces commerce gating at the canonical
write boundary through an **id-matched** check:

1. The adapter reads the existing canonical file (or treats it as
   empty if absent).
2. The adapter parses the proposed bytes as JSON.
3. The adapter matches products by id. Duplicate or missing ids
   fail closed with `E_BINDING_NOT_FOUND`.
4. Any id in the proposed set that is not in the existing set
   (`added`) is refused. Any id in the existing set that is not in
   the proposed set (`removed`) is refused. The first write, when
   the canonical file does not yet exist, is treated as "no
   products may be introduced" — adding a product is refused.
5. For each matched id, mutations to the closed `ENFORCED_HOST_KEYS`
   set are refused.

Refusal codes:

| Condition | Code |
| --- | --- |
| Added or removed product ids | `E_DERIVED_WRITE_FORBIDDEN` (`details.commerceGating === 'add_remove'`) |
| Mutation of any commerce field on a matched id | `E_DERIVED_WRITE_FORBIDDEN` (`details.commerceGating === 'field'`) |
| First write with no existing file and any product in the proposed bytes | `E_DERIVED_WRITE_FORBIDDEN` (treated as add/remove) |

Safe descriptive and image fields remain writable. The commerce
coordinator remains the authority for commerce mutations; the CMS
surfaces the failure mode but does not become a coordinator itself.

The same gating runs before the rollback writer commits any bytes
through the `RollbackSafetyOptions.safetyCheck` hook, so a rollback
cannot become a bypass hatch against coordinator-gated authority.
Repository confinement on the rollback path mirrors the apply path
through `isConfined` (a lexical duplicate of `joinInsideRepo`):
when a `repoRoot` is configured, the rollback refuses a
`canonicalPath` that resolves outside the repository root.

Source: `packages/adapter-cerafica/src/index.ts:683-873`,
`packages/adapter-cerafica/src/index.ts:1467-1582`,
`docs/concepts/content-boundary.md`.

## Deploy capability (advisory)

The cerafica adapter exposes a `DeployCapability` of kind
`cache.invalidate`, enabled when the manifest's `host.deployMode`
is `github_pages`. The capability is **advisory**: it triggers a
host-injected `GitHubPagesDeployClient` and reports receipt state,
but it never claims authority over apply, publish, or rollback.

Deploy-capability state machine:

| State | When observed |
| --- | --- |
| `canonical_written` | Trigger returns immediately and the receipt is non-terminal; the proposal is at `canonical_written` |
| `awaiting_receipt` | Reconcile polled a non-terminal receipt |
| `succeeded` | Terminal receipt with `status: "succeeded"`, `finishedAt`, and `url` |
| `failed` | Terminal receipt with `status: "failed"` or `"cancelled"`, `finishedAt`, and `message`; cancelled receipts map to the `failed` capability state |

A `failed` or `cancelled` receipt at trigger time is surfaced
**directly** — the trigger does not hide it behind a
`canonical_written` return. A malformed terminal receipt observed
at trigger or reconcile throws via `receiptToState`. A trigger-time throw leaves
no pending or terminal state. A reconcile-time throw retains the pending receipt
so the next reconcile polls and validates it again; neither path fabricates success.

The cerafica adapter does not call a network directly. The deploy
client is injected at adapter construction time; there is no
network fallback.

Source: `packages/adapter-cerafica/src/index.ts:604-873`.

## Rollback completes at `canonical_written`

The cerafica adapter's rollback path writes the canonical bytes and
returns `{ kind: 'canonical_written' }`. The governed proposal
lifecycle transitions to terminal `rolled_back` and is audited as
`proposal.rolled_back`; asynchronous deploy reconciliation follows
the canonical write and does not claim `live`. A rollback also
resets any stale `pending` / `terminal` deploy state because the
canonical bytes are no longer authoritative for the live
deployment.

Rollback safety is enforced by:

- A repository-confinement check on `canonicalPath` against the
  configured `repoRoot`.
- The same `enforceCommerceFieldGating` check the apply path
  enforces, installed via `RollbackSafetyOptions.safetyCheck`.
- A sha256 hex digest comparison of the approval bytes against
  `RollbackInput.approvalHash`. A mismatch throws
  `RollbackApprovalHashMismatchError` and the writer is not invoked.

Source: `packages/adapter-cerafica/src/index.ts:677-873`,
`docs/concepts/content-boundary.md`.

## Journal (read-only discovery, no writes)

The cerafica adapter exposes the journal through discovery only.
The adapter returns the journal provider, the module
repository-relative and absolute paths, and the `readonly: true`
literal from `discoverJournal()`. The adapter never writes the
journal: `journalWrite()` rejects with `JournalWriteUnsupportedError`.
Any attempt to use the journal as a write surface is a programmer
error, and the adapter's refusal is the only correct response.

Source: `packages/adapter-cerafica/src/index.ts:1297-1316`.

## Dogfood mapping: host surface to `@cms/adapter-cerafica`

The cerafica repo is also the documentation system's reference
dogfood deployment. The mapping below lists every cerafica host
surface mediated today and the implementation symbols involved. Symbols may be
public exports or private implementation helpers; the table describes code
ownership, not a public API. Anything not listed is out of scope for V1.

| Host surface | Mediating symbol(s) | Behaviour |
| --- | --- | --- |
| `website/cms-regions.json` | `loadManifest`, `parseManifest`, `manifestToActivationContract` | Read at adapter construction; the closed manifest is the contract the adapter enforces |
| `inventory/products.json` (canonical) | `apply`, `reconcile`, `materialiseBytes`, `enforceCommerceFieldGating` | The only writable canonical path. Writes are gated by id-matched commerce enforcement |
| `website/data/products.json` (verified symlink alias) | `verifyAlias`, `walkChain`, `SYMLINK_REFUSAL_CODES` | Verified, never written. Any of the seven symlink refusal codes closes activation |
| Kyanite journal API | `discoverJournal`, `journalWrite` | Discovery only; writes refused with `JournalWriteUnsupportedError` |
| GitHub Pages deployment | `createGitHubPagesDeployCapability`, `deployCapabilitySnapshot`, `DeployCapabilityState` | Advisory deploy capability; `cache.invalidate` enabled when `host.deployMode === 'github_pages'` |
| Commerce fields (`stripe`, `payment`, `price`, `availability`, `one_of_one`) | `COMMERCE_FIELD_HOST_KEYS`, `ENFORCED_HOST_KEYS`, `enforceCommerceFieldGating` | Coordinator-gated; id-matched refusal codes carry `details.commerceGating` |
| HTML pages (`index.html`, `pages/*.html`) | not in scope for V1 | Static host surfaces; no canonical write path |
| Bilingual anchors (`altPolicy: peer-required`) | `localization.altPolicy` | Manifest-declared; the adapter surfaces but does not translate |

A cerafica adapter is constructed with
`createCeraficaAdapter(options)`. The required options are
`repoRoot`, `manifestPath`, `deployClient`, and `rollbackWriter`;
optional fields override `tenantId`, `environment`, and `locale`.
The adapter exposes `fieldCapabilities()`, `deployCapability()`, and
`deployCapabilitySnapshot()` as provisional extensions.

Source: `packages/adapter-cerafica/src/index.ts:914-1053`,
`packages/adapter-cerafica/src/index.ts:1596-1619`.

## Open constraints

The second adapter is the **v1.1 conformance gate**, not a V1
completion claim. The cerafica adapter is the single reference
implementation V1 ships. The SDK's host-specific extension fields
remain provisional (`1.0.0-rc.1`) until a second adapter exercises
them; the cerafica adapter exercises them, but a single host is
not enough to graduate the extensions out of `1.0.0-rc.1` per the
SDK contract. See [`docs/overview.md`](../overview.md) ·
[`.es`](../overview.es.md) and
[`docs/evidence/limitations.md`](../evidence/limitations.md).

The cerafica adapter never writes through the symlink alias. It
never approves, publishes, or rolls back. The deploy capability is
advisory and operates against an injected client; there is no
network fallback. Commerce fields are coordinator-gated; the CMS
surfaces the failure mode but does not become a coordinator itself.