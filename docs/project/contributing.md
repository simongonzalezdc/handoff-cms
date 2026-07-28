# Contributing

> [Versión en español](contributing.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).
>
> **Audience:** contributors opening pull requests against the canonical Forgejo repository. This page extends the short contract at [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) with the workflow detail — branch model, commit conventions, the independent-reviewer rule, and the explicit human merge-approval rule — that the root file summarises. Where the two pages overlap, the root file is the short contract and this page is the detail.

This page does not introduce new policy. It points at the source-of-truth pages the contributor workflow already inherits from: the eight approved invariants in [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es.md`](../concepts/governance-and-human-authority.es.md), the source / claim discipline in [`../README.md`](../README.md), the secret-safe policy in [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md), and the documentation quality contract in [`docs-qa.md`](docs-qa.md) · [`.es.md`](docs-qa.es.md).

## Canonical repository and mirror

| Role | Location |
| --- | --- |
| Canonical repository (issues, pull requests, releases) | <https://git.kyanitelabs.tech/simon/handoff-cms> |
| Public mirror (read-only reference) | <https://github.com/simongonzalezdc/handoff-cms> |

All pull requests — including documentation, security, and English-only process changes — are opened on the canonical Forgejo instance. The GitHub repository is a discoverability mirror; it receives changes by push from Forgejo and is not used as an issue tracker. Branches, tags, and release notes are cut on Forgejo. The discoverability surfaces throughout the repository label the GitHub URL as a mirror; please do the same when you write a new page or amend a status badge.

## Workflow overview

1. Open an issue on the canonical Forgejo repository describing the change. Tag the audience (`docs`, `security`, `integrator`, `operator`, `self-hoster`, `client`) so the right reviewer watches the thread.
2. Fork the canonical repository and cut a topic branch. Branch names are `topic/<short-kebab-description>` for documentation and `feat/<short-kebab-description>` or `fix/<short-kebab-description>` for code; release branches carry a `release/<version>` prefix and are cut by a maintainer with release authority.
3. Make the change in atomic commits. One commit = one logical change. A pull request that mixes a refactor with a behavior change is not atomic and the reviewer will ask for a split.
4. Open a pull request against `main` on the canonical repository. The pull request body links the issue, names the audience, and lists the eight invariants the change touches (if any). The discovery-sweep parity lint runs on the pull request before reviewer assignment.
5. An independent human reviewer — distinct from the author — reviews the change and the parity lint output. The review records the reviewer identity and the timestamp.
6. The merge button is a **fresh human authorization event** recorded against the reviewer identity. No bot, automation, or merge-on-green policy may merge a pull request into a release branch.

## Same-PR EN/ES zero-lag

For every user-facing prose page you change or add:

- Touch the English page (`*.md`) **and** its Spanish peer (`*.es.md`) in the same commit and the same pull request. The Spanish peer is a co-authored peer, never an after-the-fact translation.
- Use neutral Spanish. The Spanish-reading reviewer who approves the pull request signs off on glossary use; do not invent a regional register that the glossary does not cover. The neutral-Spanish convention is recorded at [`../project/glossary.md`](../project/glossary.md) · [`.es.md`](../project/glossary.es.md).
- Do not fall back silently. If the Spanish peer cannot ship in the same pull request for a reason that is not "the page does not yet have a peer", open the question on the canonical repository before the change is merged.

The parity lint scope and discovery-sweep rules live at [`docs-qa.md`](docs-qa.md) · [`.es.md`](docs-qa.es.md); the parity rationale is documented in [`../README.md`](../README.md) §"Same-PR EN/ES zero-lag" and §"Source / claim discipline". The runtime `@cms/i18n` parity check `assertCatalogParity` is the contract the lint mirrors.

## Independent reviewer distinct from the author

Every pull request — including one-commit documentation fixes — requires an **independent reviewer** who is **not the author**. The reviewer may be a human or an approved review agent, but must inspect the actual diff and return traceable findings. Self-review is not independent review.

Documentation review covers both English and Spanish. Mechanical parity gates verify structure and links; a Spanish-reading reviewer verifies neutral-Spanish meaning and glossary use. Automated or agent review never replaces the explicit human authorization required to merge.

## Atomic pull requests

A pull request is atomic when the reviewer can merge it without partial state. The project rejects:

- A pull request that mixes a refactor with a behavior change.
- A pull request that touches governance code, audit code, or the authority facade together with a docs-only change.
- A pull request that introduces a new closed union without updating the documented inventory at the same time.
- A pull request that touches the English peer without touching the Spanish peer.

The atomicity rule is fail-closed: a reviewer who is asked to merge a non-atomic change must request a split before the merge button is enabled. The rationale is recorded at [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es.md`](../concepts/governance-and-human-authority.es.md): the eight invariants assume a single human authorization event per apply / publish / rollback, and a mixed change is harder to reason about under audit.

## Explicit human merge approval

No bot, automation, or merge-on-green policy may merge a pull request into a release branch. The merge button is a **fresh human authorization event** recorded against the reviewer identity. The reviewer who clicks the merge button is the same human who is named on the pull request review; the merge event and the review event are linked. This matches the eight approved invariants in [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es.md`](../concepts/governance-and-human-authority.es.md), where self-approval is allowed only when current policy permits it and is never inferred.

If you have automation rights on the canonical repository, do not configure an auto-merge for branches that touch governance code, audit code, or the authority facade. If a hot-fix appears to require auto-merge, treat it as a security incident under [`../../SECURITY.md`](../../SECURITY.md).

## Source / claim discipline

Every claim on a page you add or change cites one of three sources:

1. Source code under `packages/*/src/**`. The closed `*_ERROR_CODES` and `*_REFUSAL_CODES` unions are the source of truth for the error-code catalog; a change that introduces a new code without naming the runtime union it belongs to is a docs-QA failure. The discovery-sweep contract is recorded at [`docs-qa.md`](docs-qa.md) §"Discovery contract".
2. The evidence artifact `artifacts/g008/workspace-test-report.json`. A sentence beginning with "verified", "passing", or "tested" cites this report inline or points at [`../evidence/verification.md`](../evidence/verification.md).
3. The limitations ledger [`../evidence/limitations.md`](../evidence/limitations.md). The three limitations are restated wherever a claim would otherwise overreach — Docker daemon not executed, neurodivergent-accessible by design with external participant validation deferred to v1.1, second independent adapter is the v1.1 conformance gate.

Marketing-rot adjectives are forbidden by the docs-QA lint: `production-hardened`, `fully validated`, `deployed at scale`, `battle-tested`, `enterprise-grade`, `mission-critical`. A page that uses one of them fails DR4. The closed list lives at [`docs-qa.md`](docs-qa.md) §"DR4 — Forbidden phrases".

## Secrets and source-safe review

Pull requests must not contain a real secret or a value that could identify a real deployment: bearer tokens, OIDC or database credentials, object-store keys, private keys, cookies, signed URLs, tenant or customer identifiers, account identifiers, proposal identifiers, UUIDs, or copied request or log values. The closed source-safe policy is [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md); the runtime redacts `accessKeyId`, `secretAccessKey`, and the database URL password before any operator logging (see [`../../packages/server/src/config.ts`](../../packages/server/src/config.ts)), but the documentation boundary is not a claim that the runtime can detect every secret in prose. Authors and reviewers are responsible for keeping the source safe before publication.

Examples use `replace-with-*` placeholders. The docs-QA lint (DR6) flags Bearer / JWT / AWS / Database-URL / UUID-ish literals that are not `replace-with-*` placeholders; the closed source-safe checklist is the reviewer-facing version of the same rule.

If a real value is found during review, stop the change, remove the value from the working copy and review artifacts, and notify the repository security owner through the operator's established credential-response process described in [`../../SECURITY.md`](../../SECURITY.md).

## Tests and verification

The V1 verification runs the seven commands in [`../how-to/quickstart.md`](../how-to/quickstart.md) · [`.es.md`](../how-to/quickstart.es.md) and records them verbatim in `artifacts/g008/workspace-test-report.json`. A change that affects the verified scope is expected to update the relevant closed union, the docs-QA evidence page, and the seven-command citation when the next verification run completes. The seven commands are not a target to add to; they are the canonical execution trace the project cites, and a pull request that introduces a new claim about runtime behaviour must come with the next g00x report.

The Docker daemon was not executed during V1 verification. A pull request that depends on a live Docker daemon-backed run is not eligible for V1.

## Supported versions and version policy

Handoff CMS is on a **0.x release line**. The supported surface is documented in [`../../README.md`](../../README.md) and is verified end-to-end against `artifacts/g008/workspace-test-report.json`. The three limitations recorded in [`../evidence/limitations.md`](../evidence/limitations.md) (Docker daemon not executed, neurodivergent-accessible by design with external participant validation deferred to v1.1, second independent adapter is the v1.1 conformance gate) are part of the supported contract; they are not weakened or summarized away. The 0.x pre-1.0 semantics are documented at [`release-versioning.md`](release-versioning.md) · [`.es.md`](release-versioning.es.md).

Patches are accepted against the **latest 0.x release tag** on the canonical repository. The repository does not maintain older 0.x branches in parallel. A change to behaviour must include the parity update in both `en` and `es` peers, the change to the relevant closed union if it touches a refusal code, and the docs-QA evidence page.

## Reporting problems

- **Bugs and feature requests** — open an issue on the canonical Forgejo repository at <https://git.kyanitelabs.tech/simon/handoff-cms/issues>.
- **Security vulnerabilities** — follow the private disclosure process in [`../../SECURITY.md`](../../SECURITY.md). Do not open a public issue.
- **Documentation and process questions** — open an issue on the canonical Forgejo repository and tag the `docs` / community label.
- **Support questions** — follow [`../../SUPPORT.md`](../../SUPPORT.md).

## Before you open a pull request

1. Read [`../../README.md`](../../README.md) and the relevant audience page under §"Who this is for — pick one path".
2. Read this page and the short contract at [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
3. Read the docs QA guide: [`docs-qa.md`](docs-qa.md) · [`.es.md`](docs-qa.es.md) for the parity lint, the discovery-sweep rules, the source / claim discipline, and the disallowed marketing adjectives.
4. Read [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md) and the source-safe review checklist inside it.
5. For governance, audit, or adapter-SDK changes, also read [`../security/reviewer-on-ramp.md`](../security/reviewer-on-ramp.md) · [`.es.md`](../security/reviewer-on-ramp.es.md) and [`../security/threat-model.md`](../security/threat-model.md) · [`.es.md`](../security/threat-model.es.md) before drafting.

## License

Handoff CMS is licensed under the Apache License, Version 2.0. By submitting a contribution you agree that your contribution is licensed under the same Apache-2.0 license and that you have the right to submit it under those terms. See [`../../LICENSE`](../../LICENSE) and [`licensing.md`](licensing.md) · [`.es.md`](licensing.es.md). A separate Contributor License Agreement is not required.

## Attribution

This page extends the short contract at [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) with the workflow detail. The eight invariants and the explicit human merge-approval rule are recorded in [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es.md`](../concepts/governance-and-human-authority.es.md). The bilingual EN/ES peer policy and the same-pull-request zero-lag rule are recorded in [`../README.md`](../README.md).
