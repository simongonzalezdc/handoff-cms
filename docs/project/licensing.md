# Licensing

> [Versión en español](licensing.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).
>
> **Audience:** operators, integrators, security reviewers, and contributors who need the exact license boundary, the allowlist the workspace enforces, the licensing-guard command that enforces it, and the documented dev-only exceptions. This page is information-oriented (Diátaxis project). The authoritative copy of the open-core license is the [`../../LICENSE`](../../LICENSE) file at the repository root; this page summarises the boundary and points at the allowlist and the guard.

The page is grounded in three source-of-truth artefacts:

- The Apache-2.0 text at [`../../LICENSE`](../../LICENSE).
- The shipped allowlist at [`../../packages/licensing-guard/allowlist.json`](../../packages/licensing-guard/allowlist.json), loaded at runtime as the single authoritative policy source by [`../../packages/licensing-guard/src/index.ts`](../../packages/licensing-guard/src/index.ts).
- The licensing-guard command and its verified scope in `artifacts/g008/workspace-test-report.json` and [`../how-to/quickstart.md`](../how-to/quickstart.md) §"The seven verified commands".

The page does not invent a wider allowlist, a wider exception list, or a different guard command. The shipped allowlist, the guard command, and the dev-only axe exceptions are the contract.

## Open-core license (Apache-2.0)

Handoff CMS is licensed under the Apache License, Version 2.0. The authoritative text is [`../../LICENSE`](../../LICENSE); the project does not ship a second license for the open implementation. The Apache-2.0 license covers the code under `packages/*/src/**`, the documentation under `docs/`, the `LICENSE` file itself, and the configuration under `compose.yaml` and `Dockerfile`. Every `package.json` under `packages/*/package.json` declares `"license": "Apache-2.0"` (the relevant lines are at `packages/*/package.json:6`); the root `package.json` declares the same license at line 6. The Dockerfile labels the runtime image with `org.opencontainers.image.licenses="Apache-2.0"` (see `Dockerfile:158-159`).

The README at [`../../README.md`](../../README.md) §"License" carries the same wording: the Apache-2.0 core bundles the API, CLI, MCP, self-hosting, Handoff Beat, accessibility, propose / approve governance, and audit. Human approval, governance, and audit are **not** paywalled; the open core ships with the protections, not behind an opt-in. The same statement is restated at [`release-versioning.md`](release-versioning.md) §"Apache-2.0 open implementation versus non-paywallable guarantees" with a per-guarantee explanation.

The Contributor License Agreement question is answered at [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) §"License": a separate CLA is not required, and by submitting a contribution the contributor agrees that the contribution is licensed under the same Apache-2.0 terms. The same wording is mirrored at [`contributing.md`](contributing.md) §"License".

## The exact allowlist

The runtime license allowlist is the closed set of SPDX identifiers the licensing guard accepts. The authoritative list is the JSON file at [`../../packages/licensing-guard/allowlist.json`](../../packages/licensing-guard/allowlist.json), shipped with the guard and loaded as the single source of truth. The current allowlist (committed to the repository) is:

| SPDX identifier | Notes |
| --- | --- |
| `Apache-2.0` | The project license and the dominant runtime license. |
| `MIT` | Permitted for runtime dependencies. |
| `BSD-2-Clause` | Permitted for runtime dependencies. |
| `BSD-3-Clause` | Permitted for runtime dependencies. |
| `ISC` | Permitted for runtime dependencies. |

The allowlist is a closed set. The guard's documented conservative default is that any `SPDX-WITH` exception whose exception identifier is not in the `withExceptions` array makes the package denied; the shipped `withExceptions` array is `[]` (empty). Adding a new entry to the `allowed` array or to the `withExceptions` array is a content change that lands in the same pull request as the change that requires it. The runtime contract is enforced at [`../../packages/licensing-guard/src/index.ts`](../../packages/licensing-guard/src/index.ts) `loadAllowlist` and `expressionAllowed`; the test at [`../../packages/licensing-guard/test/license.test.ts`](../../packages/licensing-guard/test/license.test.ts) §"ships a conservative empty WITH exception list that pins documented rejection" asserts the empty `withExceptions` invariant.

The guard's deny-list is the conservative set the open-core policy refuses by default, even when the allowlist is widened by mistake. The deny-list is the closed set declared in [`../../packages/licensing-guard/src/index.ts`](../../packages/licensing-guard/src/index.ts) and reproduced here:

- `GPL-2.0-only`, `GPL-2.0-or-later`
- `GPL-3.0-only`, `GPL-3.0-or-later`
- `AGPL-3.0-only`, `AGPL-3.0-or-later`
- `SSPL-1.0`
- `Proprietary`

A package that declares any of the deny-list identifiers fails closed under the guard with `reason: "denied-license"`. A package that declares a license identifier the guard does not recognise fails closed with `reason: "unknown-license"`. A package with no license metadata fails closed with `reason: "missing-license"`. A package the guard cannot inspect fails closed under strict mode with `reason: "uninspectable"`. The four failure modes are the closed union declared in [`../../packages/licensing-guard/src/index.ts`](../../packages/licensing-guard/src/index.ts) as `FindingReason = "missing-license" | "unknown-license" | "denied-license" | "uninspectable"`.

## The exact guard command

The licensing-guard command is the verified seam between the shipped allowlist and the V1 release evidence. The exact command, copied verbatim from [`../how-to/quickstart.md`](../how-to/quickstart.md) §"The seven verified commands" and from `artifacts/g008/workspace-test-report.json` `results[3]`, is:

```sh
node packages/licensing-guard/dist/index.js --root . --json
```

The verified scope recorded in the V1 report is **14 packages, 0 findings**. The command runs from the repository root and writes a JSON report to stdout when the `--json` flag is set; without `--json` the guard writes a human-readable report. The guard exits with `0` on a clean run and `1` on a finding. The `--root` flag accepts a custom root directory; the default is the current working directory. The `--non-strict` flag disables the fail-closed `uninspectable` finding for declared but absent dependencies; the verified V1 run uses strict mode (the default).

The guard scans every workspace `package.json` reachable from the chosen root (including `packages/*/package.json`) and walks each package's `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies` closures. The walk resolves each declared dependency to its real `package.json` through pnpm-aware resolution (the same resolution rules the importer's `createRequire` would use) and inspects the manifest's `license` field against the allowlist. The walk is cycle-safe via a `visited` set keyed on the resolved manifest path; the test at [`../../packages/licensing-guard/test/license.test.ts`](../../packages/licensing-guard/test/license.test.ts) §"follows a workspace cycle A→B→A without infinite recursion" pins this behaviour.

## The dev-only MPL-2.0 axe exceptions

The runtime allowlist is Apache/MIT/BSD/ISC. Two packages in the workspace — `@axe-core/playwright` and `axe-core` — are admitted as documented **dev-only MPL-2.0** exceptions to that allowlist, on the exact rationale that the V1 accessibility statement records. The exception list is the `devToolExceptions` array at [`../../packages/licensing-guard/allowlist.json`](../../packages/licensing-guard/allowlist.json):

| Package | License | Rationale |
| --- | --- | --- |
| `@axe-core/playwright` | `MPL-2.0` | Test-only WCAG 2.2 AA browser audit tooling; not shipped in the functional core. |
| `axe-core` | `MPL-2.0` | Transitive engine for the test-only WCAG 2.2 AA browser audit; not shipped in the functional core. |

The exception is admitted only on the dev-only path. The guard recognises a dev-tool exception when three conditions hold: (a) the dependency is reachable exclusively through a workspace-owned `devDependencies` closure, (b) the declared license matches the exception's `license` field, and (c) the requested dependency name matches the exception's `package` field exactly. A wrong-license, lookalike-name, or promoted-to-runtime dep is denied (see the test cases at [`../../packages/licensing-guard/test/license.test.ts`](../../packages/licensing-guard/test/license.test.ts) §"rejects wrong-license and lookalike dev tools instead of broadening the exception" and §"rejects the audited Axe packages when promoted to a runtime dependency"). The exception is scoped to development; the production runtime does not include either package, and the deployed authoring client does not ship an MPL-2.0 dependency. The same wording is carried at [`../accessibility/statement.md`](../accessibility/statement.md) §"Browser evidence (axe)".

## Boundary between the open core and the project

The Apache-2.0 open implementation covers:

- The source code under `packages/*/src/**` and the workspace `tsconfig.json` settings.
- The test code under `packages/*/test/**` and the e2e harness under `packages/web/e2e/**`.
- The documentation under `docs/**` and the root `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and `SUPPORT.md`.
- The build configuration under `Dockerfile`, `compose.yaml`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and the root `package.json`.
- The licensing-guard itself: the allowlist, the guard source, and the guard test.

The following are outside the Apache-2.0 boundary and are not part of the V1 release:

- **Third-party websites.** The accessibility statement and the architecture page point at primary sources (W3C, IETF, Diátaxis, OWASP, RFC 9457); the project does not redistribute those sources and the Apache-2.0 license does not cover them.
- **Operator host deployments.** The deployment of the operator's host website / repository / database / downstream CMS is owned by the operator and is not part of the Apache-2.0 open core. The CMS ships the governance and audit guarantee; the canonical content stays on the host.
- **Non-Apache-2.0 modules.** A module that is not under Apache-2.0 is not part of the open core. The dev-only MPL-2.0 axe tooling is admitted under the `devToolExceptions` policy above and is absent from the production runtime.
- **Commercial conveniences around the open core.** A future release may add paid conveniences around human approval, governance, or audit, but the protections themselves — human-only approve / publish / rollback, the eight invariants, the immutable audit envelope — are properties of the open implementation and are not separable from it. The boundary is stated at [`../../README.md`](../../README.md) §"License" and at [`release-versioning.md`](release-versioning.md) §"Apache-2.0 open implementation versus non-paywallable guarantees".

## Verifying the license boundary

Run the licensing-guard command from the repository root and assert the result is `0 findings`:

```sh
node packages/licensing-guard/dist/index.js --root . --json
```

A clean run writes a JSON object with `ok: true`, `findings: []`, and `packages: 14` (the count of workspace `package.json` files reachable from the root). A non-clean run writes a JSON object with `ok: false` and a `findings` array; each finding carries `package`, `version`, `path`, `license` (when available), and `reason` (`missing-license`, `unknown-license`, `denied-license`, or `uninspectable`). The command's exit code is `0` on a clean run and `1` on a finding. The command is one of the seven verified commands recorded in [`../how-to/quickstart.md`](../how-to/quickstart.md) §"The seven verified commands" and in `artifacts/g008/workspace-test-report.json` `results[3]`. The same command runs in the seven-command quickstart sequence; the project does not ship a second licensing-verification script.

The guard's package-count and finding-count invariants are pinned by the test at [`../../packages/licensing-guard/test/license.test.ts`](../../packages/licensing-guard/test/license.test.ts) §"exposes the shipped allowlist as the authoritative policy source" (the allowlist is the single source of truth and the dev-only axe exceptions are the only exception shape). The V1 verified scope is `14 workspace packages, 0 findings`; any drift from that scope is a licensing-guard failure and a release-blocker.

## Source-safe boundary (no secrets, no claim)

The license boundary does not extend to operator secrets, operator hostnames, or copied runtime traces. The closed source-safe policy is [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md); the runtime redacts `accessKeyId`, `secretAccessKey`, and the database URL password before any operator logging (see [`../../packages/server/src/config.ts`](../../packages/server/src/config.ts) `describeServerConfig`). A page that ships a real credential, a real tenant id, or a copied log line is not a "license" violation but a source-safe violation, and the secret-safe gate ([`docs-qa.md`](docs-qa.md) §"DR6 — Secret-safe source") blocks the pull request.

## Primary citations (retrieved 2026-07-28)

| Topic | Source | URL |
| --- | --- | --- |
| Apache-2.0 text | [`../../LICENSE`](../../LICENSE) | <https://www.apache.org/licenses/LICENSE-2.0> |
| Shipped allowlist | [`../../packages/licensing-guard/allowlist.json`](../../packages/licensing-guard/allowlist.json) | |
| Guard source | [`../../packages/licensing-guard/src/index.ts`](../../packages/licensing-guard/src/index.ts) | |
| Guard tests | [`../../packages/licensing-guard/test/license.test.ts`](../../packages/licensing-guard/test/license.test.ts) | |
| V1 verified scope | `artifacts/g008/workspace-test-report.json` | committed artifact at the repository root |
| Dev-only axe rationale | [`../accessibility/statement.md`](../accessibility/statement.md) §"Browser evidence (axe)" | |
| Non-paywallable guarantees | [`../../README.md`](../../README.md) §"License" and [`release-versioning.md`](release-versioning.md) §"Apache-2.0 open implementation versus non-paywallable guarantees" | |
| Source-safe policy | [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md) | |
| Discoverability mirror | `LICENSE` and the canonical repository at <https://git.kyanitelabs.tech/simon/handoff-cms> | |

A claim that depends on a primary source but does not cite it is a docs-QA failure (DR5).

## Where to go next

- Verifying the boundary: run the guard command above and compare the result to the V1 verified scope of `14 packages, 0 findings`.
- Cutting a release: [`release-versioning.md`](release-versioning.md) for the version-bump workflow and the pre-1.0 semantics.
- Source-safe review: [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md) and the secret-safe review checklist inside it.
- Reporting a license question or a non-Apache-2.0 dependency: open an issue on the canonical Forgejo repository.
