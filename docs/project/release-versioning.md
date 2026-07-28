# Release and versioning

> [Versión en español](release-versioning.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).
>
> **Audience:** contributors cutting a release, operators planning an upgrade, and integrators tracking a host-adapter contract version. This page is information-oriented (Diátaxis project). The release line is 0.x, the project is pre-1.0, and the page records the published shape of the version line, the rules for cutting a release tag, and the support window.

This page is grounded in the canonical evidence on the repository: the V1 verification report at `artifacts/g008/workspace-test-report.json`, the three limitations in [`../evidence/limitations.md`](../evidence/limitations.md), the closed unions and contract versions in the source code, and the adapter contract at [`../../packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts). It does not invent a wider support policy than the source supports.

## Release line (0.x, pre-1.0)

Handoff CMS is on a **0.x release line** and is **pre-1.0**. The 0.x line is the V1 dogfood; the Cerafica reference deployment is the V1 evidence. The line ships with three deliberate limitations recorded in [`../evidence/limitations.md`](../evidence/limitations.md):

1. **Docker daemon execution was unavailable.** Compose interpolation / config validation, runtime package tests, and healthcheck syntax passed. A live Docker daemon-backed build / run is not part of V1.
2. **Accessibility is "neurodivergent-accessible by design."** Internal V1 design stance (WCAG 2.2 AA + ATAG 2.0 + COGA patterns); external participant validation is a v1.1 goal.
3. **A second independent adapter is the v1.1 conformance gate.** V1 ships one reference adapter; the adapter contract's host-specific extension / capability fields remain provisional (1.0-beta / RC) until a second adapter exercises them.

A 1.0 release will be cut when the second-adapter gate closes and the wider Docker-runtime claim is supported by a daemon-backed run recorded in the evidence artifact. Until then, the 0.x latest-release rule is the entire support policy.

## Versioning rules (0.x → 1.x)

The 0.x line follows pre-1.0 semantics: the leading `0` signals an in-development surface. Within the line, the project uses the shape `0.x.y` where:

- **0.x** — a minor bump (e.g. `0.1.0` → `0.2.0`) is a release that adds capability behind an existing contract, opens a new contract that does not break the frozen core, or ships a verified evidence revision. A minor bump is allowed to change behaviour behind a closed union and to mark a previously provisional extension as stable.
- **0.x.y** — a patch bump (e.g. `0.1.0` → `0.1.1`) is a release that fixes behaviour inside the existing contract without changing any closed union, removes a documented limitation, or refreshes the V1 evidence artifact.
- **1.0.0** — a major bump is a release that freezes the 0.x contract as 1.0, marks the second-adapter gate as closed, and ships a Docker-runtime evidence artifact. The major bump is the first release where the project is not pre-1.0.

The 0.x line is permissive on minor bumps and restrictive on patch bumps: a minor bump is allowed to introduce a new closed union (the discovery sweep at [`docs-qa.md`](docs-qa.md) §"Discovery contract" audits the new row in the same pull request) and to mark a provisional extension as frozen. A patch bump must not introduce a new closed union and must not change the discovery-sweep inventory.

The pre-1.0 status means the project is allowed to ship breaking changes inside a minor bump. The breaking-change inventory is the closed union table at [`docs-qa.md`](docs-qa.md) §"The exact twelve unions"; a reviewer who approves a minor bump is implicitly approving a change to that table when one occurs.

## Support window

Patches are accepted against the **latest 0.x release tag** on the canonical Forgejo repository at <https://git.kyanitelabs.tech/simon/handoff-cms>. The repository does not maintain older 0.x branches in parallel: a 0.x.y release is the supported branch until a 0.x.(y+1) release supersedes it. The same policy is recorded at [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) §"Supported versions and version policy" and at [`../../SECURITY.md`](../../SECURITY.md) §"Supported versions and 0.x policy".

| Release line | Supported | Where to report |
| --- | --- | --- |
| 0.x (latest release tag only) | Yes | This page, via the channel in [`../../SECURITY.md`](../../SECURITY.md) |
| Older 0.x | No — please upgrade | This page, via the channel in [`../../SECURITY.md`](../../SECURITY.md) |

The supported surface on the latest 0.x release tag is the documentation, the source code, the evidence artifact, and the verification record. The exact verified scope is recorded in [`../evidence/verification.md`](../evidence/verification.md) and reproduced verbatim from `artifacts/g008/workspace-test-report.json`. Anything beyond that record is not a "supported" claim.

## Cutting a release tag

Release tags are cut on the canonical Forgejo repository. The release flow is:

1. **Freeze.** A maintainer with release authority opens a `release/<next-version>` branch off the latest `main` that passes the V1 verification. The release branch is cut from the verified tip of `main`; the verification report at `artifacts/g008/workspace-test-report.json` is the source of truth for the supported surface.
2. **Refresh the V1 evidence.** The V1 verification (the seven commands in [`../how-to/quickstart.md`](../how-to/quickstart.md)) is re-run on the release branch. The report replaces the prior `artifacts/g008/workspace-test-report.json`. The release notes quote the seven commands verbatim and record the verified-at timestamp.
3. **Update the version.** Each `package.json` in `packages/*/` is bumped to the new `0.x.y` version. The root `package.json` does not track a release version (it is `0.0.0` and `private: true`); the release version lives in the workspace package versions. The commit is a single atomic commit on the release branch.
4. **Update the closed unions and the docs-QA evidence.** If a new closed union is introduced, the discovery-sweep parity lint at [`docs-qa.md`](docs-qa.md) §"Discovery contract" regenerates the union table; the docs-QA page and the catalog at [`../reference/error-codes.md`](../reference/error-codes.md) are updated in the same pull request. Hand edits to the inventory are forbidden.
5. **Tag and publish.** A maintainer with release authority signs the tag using the canonical Forgejo SSH key. The tag message records the seven verified commands, the limitations carried forward from [`../evidence/limitations.md`](../evidence/limitations.md), and the version bump. The release notes are a verbatim copy of the tag message plus the per-package version diff.
6. **Mirror.** The mirror at <https://github.com/simongonzalezdc/handoff-cms> receives the tag and the release notes by push from Forgejo. The mirror is read-only and does not cut tags.

A release that touches governance code, audit code, or the authority facade carries the explicit human merge-approval rule recorded in [`contributing.md`](contributing.md) §"Explicit human merge approval". No bot, automation, or merge-on-green policy may merge a release branch.

## The frozen core versus provisional extensions

The adapter contract is the clearest example of the pre-1.0 split between a frozen core and provisional extensions. From [`../../packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts):

- **Frozen core (`ADAPTER_SDK_FROZEN_VERSION = "1.0.0"`).** The `RegionBinding` contract fields `canonical_source`, `derived_artifacts[]`, and `regeneration_contract`, the regeneration mode `'alias_symlink'`, and the nine `AdapterCapability` strings. A change to the frozen core is a major bump.
- **Provisional extensions (`ADAPTER_SDK_EXTENSIONS_VERSION = "1.0.0-rc.1"`).** The `FieldCapability` and `DeployCapability` extensions are marked `1.0-beta/RC` and may move within the `1.0.0` major line. A change that promotes a provisional extension to the frozen core is a minor bump on the SDK and a minor bump on the project.

The same split is reflected in the runtime packages: the governance kernel at `@cms/core` ships at `0.1.0` and the API transport at `@cms/api` ships at `0.1.0`. A change to the governance kernel is a minor bump; a change to the closed `ERROR_CODES` union is a contract change and a minor bump. The audit package at `@cms/audit` ships the immutable audit envelope and is not allowed to widen the audit-event shape without a major bump.

## Apache-2.0 open implementation versus non-paywallable guarantees

The V1 release is the **Apache-2.0 open implementation** of the system. The Apache-2.0 license covers the code under `packages/*/src/**`, the documentation under `docs/`, the `LICENSE` file, and the configuration under `compose.yaml` and `Dockerfile`. The `LICENSE` file is the authoritative copy; the project does not ship a second license for the open implementation. The license is documented in detail at [`licensing.md`](licensing.md) · [`.es.md`](licensing.es.md).

Three guarantees in the V1 release are **not paywalled** and are not separable from the Apache-2.0 open implementation:

1. **Human approval.** The eight invariants in [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es.md`](../concepts/governance-and-human-authority.es.md) require a fresh human authorization event for every apply, publish, and rollback. A future release may add paid conveniences around the human workflow, but the requirement that approve / publish / rollback be human-only is a property of the open implementation and is not separable from it.
2. **Governance.** The lifecycle `propose → validate → approve → publish → canonical_written → (optional) live propagation → rollback`, the eight invariants, and the policy / state-machine engine at `@cms/core` are part of the open implementation. A future release may add paid conveniences around governance, but the lifecycle, the policy gates, and the state machine are not separable from it.
3. **Audit.** The `@cms/audit` package, the canonical NDJSON export, and the detached Ed25519 JWS envelope are part of the open implementation. The audit envelope is documented at [`../reference/audit-envelope.md`](../reference/audit-envelope.md) · [`.es.md`](../reference/audit-envelope.es.md). A future release may add paid conveniences around audit analysis, but the immutable audit guarantee and the offline-verifiable signature are not separable from it.

The three guarantees are not an exception list. They are the property the open implementation protects; the open core ships with the protections, not behind an opt-in. The README at [`../../README.md`](../../README.md) §"License" carries the same wording: human approval, governance, and audit are not paywalled.

## Upgrade and rollback

An upgrade is a release-line bump: 0.x.y → 0.x.(y+1). The supported upgrade path is a fresh `pnpm install` against the new tag, a re-run of the V1 verification, and a manual cutover documented in [`../how-to/operate.md`](../how-to/operate.md) · [`.es.md`](../how-to/operate.es.md). The supported downgrade path is to revert the release tag; the durable state under `cms_postgres_data` and `cms_minio_data` is independent of the application version and is preserved across the bump. Backup and restore are documented at [`../how-to/backup-restore.md`](../how-to/backup-restore.md) · [`.es.md`](../how-to/backup-restore.es.md).

A governed rollback of a published proposal is distinct from a release-line rollback. The governed rollback completes at `canonical_written` (the adapter's write boundary), transitions the governed proposal lifecycle to terminal `rolled_back`, and is audited as `proposal.rolled_back`. The boundary is documented in [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es.md`](../concepts/content-boundary.es.md) and the Cerafica adapter-specific path is documented in [`../adapters/cerafica.md`](../adapters/cerafica.md) · [`.es.md`](../adapters/cerafica.es.md).

## Limitations

The release policy on this page is bounded. The page does not claim:

- A 1.0 release date. The 1.0 cut is gated on the second-adapter conformance gate and a Docker-runtime evidence artifact.
- A long-term support line older than the latest 0.x. The repository does not maintain older 0.x branches in parallel.
- An SLA, a fix-by date, or a patch-on-day-N schedule. Vulnerability reporting is private and is documented at [`../../SECURITY.md`](../../SECURITY.md) §"Reporting a vulnerability privately".
- A commercial support contract. The project ships the Apache-2.0 open implementation; commercial conveniences around it are out of scope for this page.

The three recorded limitations in [`../evidence/limitations.md`](../evidence/limitations.md) are part of the release policy. They are not weakened or summarized away by the 0.x line.

## Primary citations (retrieved 2026-07-28)

| Topic | Source | URL |
| --- | --- | --- |
| Pre-1.0 semantics | Semantic Versioning 2.0.0 | <https://semver.org/spec/v2.0.0.html> |
| Adapter contract versions | `@cms/adapter-sdk` package metadata | [`../../packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts) |
| V1 verified scope | `artifacts/g008/workspace-test-report.json` | committed artifact at the repository root |
| Three recorded limitations | [`../evidence/limitations.md`](../evidence/limitations.md) | |
| Human-only enforcement | [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es.md`](../concepts/governance-and-human-authority.es.md) | |
| Audit envelope | [`../reference/audit-envelope.md`](../reference/audit-envelope.md) · [`.es.md`](../reference/audit-envelope.es.md) | |
| Discovery-sweep union table | [`docs-qa.md`](docs-qa.md) §"The exact twelve unions" | |
| License | [`../../LICENSE`](../../LICENSE); [`licensing.md`](licensing.md) · [`.es.md`](licensing.es.md) | |

A claim that depends on a primary source but does not cite it is a docs-QA failure (DR5).

## Where to go next

- Cutting a release: this page, the version-bump workflow, and the discovery-sweep parity contract at [`docs-qa.md`](docs-qa.md) §"Discovery contract".
- Auditing the evidence: [`../evidence/verification.md`](../evidence/verification.md) and [`../evidence/limitations.md`](../evidence/limitations.md) for the seven verified commands and the three limitations.
- License details: [`licensing.md`](licensing.md) · [`.es.md`](licensing.es.md) for the exact allowlist, the guard command, the dev-only MPL-2.0 axe exceptions, and the Apache-2.0 open-implementation boundary.
- Reporting a vulnerability: [`../../SECURITY.md`](../../SECURITY.md).
