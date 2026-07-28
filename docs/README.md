# Documentation

This directory is the authoritative map of every prose page the project ships. Use it as the front door to the documentation system; the README is the front door to the project.

> [Versión en español](README.es.md) · The English and Spanish peers ship in the same pull request (zero-lag rule). See [Same-PR EN/ES zero-lag](#same-pr-enes-zero-lag) below.

## Source / claim discipline

Every claim on every page traces to one of three sources:

1. **Source code under `packages/*/src/**`.** Reference pages name the exact union they mirror (`API_ERROR_CODES` at `packages/api/src/problem.ts:38-62`, `STORE_ERROR_CODES` at `packages/web/src/model.ts:111-133`, etc.). The discovery-sweep parity lint scans `packages/**/src/**/*.ts` for exported closed `*_ERROR_CODES` / `*_REFUSAL_CODES` runtime arrays and `*ErrorCode` / `*RefusalCode` type aliases, dedupes them, and asserts that **every** discovered closed union is documented here and that the documented membership deep-equals the source.
2. **The evidence artifact `artifacts/g008/workspace-test-report.json`.** Any sentence beginning with "verified", "passing", or "tested" either cites this report inline or points at the documentation evidence page. Capability claims match the report. The seven verified commands appear verbatim on the quickstart page.
3. **The limitations ledger `docs/evidence/limitations.md`.** The three limitations are stated everywhere a claim would otherwise overreach — Docker daemon not executed, neurodivergent-accessible by design (external validation v1.1), second adapter is the v1.1 conformance gate.

Pages do not invent capabilities, contracts, code locations, or audit error codes. Marketing-rot adjectives ("production-hardened", "fully validated", "deployed at scale") are absent by convention; a docs-QA lint forbids them.

## Audience → section matrix

Six disjoint audiences map onto the documentation tree. Each page declares one audience in its header; the README never mixes audiences on a single page.

| Audience | Primary entry | Supporting pages |
| --- | --- | --- |
| Client / end user (Handoff Beat author) | [`docs/concepts/handoff-beat.md`](concepts/handoff-beat.md) · [`.es`](concepts/handoff-beat.es.md) | [`docs/how-to/authoring.md`](how-to/authoring.md) · [`.es`](how-to/authoring.es.md) |
| Agency operator (managed compose stack) | [`docs/how-to/self-host.md`](how-to/self-host.md) · [`.es`](how-to/self-host.es.md) | [`docs/how-to/configure.md`](how-to/configure.md) · [`.es`](how-to/configure.es.md), [`docs/how-to/operate.md`](how-to/operate.md) · [`.es`](how-to/operate.es.md) |
| Self-hoster (full bring-up + hardening) | [`docs/how-to/self-host.md`](how-to/self-host.md) · [`.es`](how-to/self-host.es.md) | [`docs/security/hardening.md`](security/hardening.md) · [`.es`](security/hardening.es.md), [`docs/how-to/migrate.md`](how-to/migrate.md) · [`.es`](how-to/migrate.es.md), [`docs/how-to/backup-restore.md`](how-to/backup-restore.md) · [`.es`](how-to/backup-restore.es.md) |
| Integrator / adapter builder (frozen `@cms/adapter-sdk`) | [`docs/reference/adapter-sdk.md`](reference/adapter-sdk.md) · [`.es`](reference/adapter-sdk.es.md) | [`docs/adapters/cerafica.md`](adapters/cerafica.md) · [`.es`](adapters/cerafica.es.md) |
| Contributor (Forgejo canonical) | [`docs/project/contributing.md`](project/contributing.md) · [`.es`](project/contributing.es.md) | [`docs/project/docs-qa.md`](project/docs-qa.md) · [`.es`](project/docs-qa.es.md), [`docs/project/glossary.md`](project/glossary.md) |
| Security reviewer (authority proofs) | [`docs/security/reviewer-on-ramp.md`](security/reviewer-on-ramp.md) · [`.es`](security/reviewer-on-ramp.es.md) | [`docs/security/threat-model.md`](security/threat-model.md) · [`.es`](security/threat-model.es.md), [`docs/security/hardening.md`](security/hardening.md) · [`.es`](security/hardening.es.md), [`docs/reference/audit-envelope.md`](reference/audit-envelope.md) · [`.es`](reference/audit-envelope.es.md), [`docs/reference/media-pipeline.md`](reference/media-pipeline.md) · [`.es`](reference/media-pipeline.es.md) |

Audience segmentation is enforced: a page may only be tagged with **one** of the six. The README does the cross-audience routing at the top of the project; pages below the README stay narrow.

## Diátaxis legend

The documentation tree follows [Diátaxis](https://diataxis.fr/) (retrieved 2026-07-28). Four directories carry the four modes:

- [`docs/overview.md`](overview.md) · [`.es`](overview.es.md) — orientation; what Handoff CMS is, where the content boundary lives, what the monorepo contains.
- [`docs/concepts/`](concepts/) — explanatory material; the why behind the architecture, governance, accessibility, the Handoff Beat, and the eight product invariants.
- [`docs/how-to/`](how-to/) — task-oriented guides; quickstart, authoring, self-hosting, configuring, operating, migrating, backup / restore.
- [`docs/reference/`](reference/) — information-oriented material: closed error-code unions, API / CLI / MCP surfaces, the adapter SDK, media pipeline, audit envelope, configuration, state machine, and observability.

Three directories are **not** Diátaxis lanes but track concerns that span all four modes:

- [`docs/security/`](security/) — authority proofs, threat model, hardening, secrets-in-docs policy, and reviewer on-ramp.
- [`docs/adapters/`](adapters/) — Cerafica reference-adapter documentation and its relationship to [`docs/reference/adapter-sdk.md`](reference/adapter-sdk.md).
- [`docs/project/`](project/) — community health: contributing, code of conduct, security policy, support, release / versioning / licensing, docs QA, glossary.

[`docs/evidence/`](evidence/) and [`docs/accessibility/`](accessibility/) carry the evidence ledger (verification and limitations) and accessibility statement respectively.

A page is never more than one mode. A "concept" page does not become a "how-to"; a "how-to" does not turn into a "reference".

## Same-PR EN/ES zero-lag

English and Spanish are **peer locales**. The rule:

1. Every user-facing prose page exists as `*.md` + `*.es.md` siblings. Reference pages may share code blocks but translate prose.
2. Both siblings ship in the **same pull request**. Spanish is a co-authored peer, never an after-the-fact translation.
3. A parity lint mirrors the runtime `@cms/i18n` parity check (`assertCatalogParity`). Failing the lint blocks the PR.
4. Each lane in [`docs/project/docs-qa.md`](project/docs-qa.md) · [`.es`](project/docs-qa.es.md) names one owner accountable for both the EN and ES peer. A Spanish-reading reviewer signs off on neutral-Spanish glossary use.

If you change the EN page, change the ES page in the same commit. If you translate a new concept, file both pages together.

## Best-practice citation table

The documentation tree leans on a small set of named primary sources. Citations are inline with retrieval date 2026-07-28.

| Page area | Source | URL |
| --- | --- | --- |
| Diátaxis legend, docs layout | Diátaxis | <https://diataxis.fr/> |
| README purpose and audience orientation | GitHub Docs — About READMEs | <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes> |
| WCAG 2.2 conformance | W3C — Web Content Accessibility Guidelines (WCAG) 2.2 | <https://www.w3.org/TR/WCAG22/> |
| Authoring-tool accessibility (Handoff Beat) | W3C — Authoring Tool Accessibility Guidelines (ATAG) 2.0 | <https://www.w3.org/TR/ATAG20/> |
| Cognitive accessibility design patterns | W3C — Making Content Usable for People with Cognitive and Learning Disabilities (COGA) | <https://www.w3.org/TR/coga-usable/> |
| API error format (RFC 9457 Problem Details) | IETF — RFC 9457 | <https://www.rfc-editor.org/rfc/rfc9457> |
| Secrets-in-docs contributor policy | OWASP — Secrets Management Cheat Sheet | <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html> |

A claim that depends on a primary source but does not cite it is a docs-QA failure.

## Where to go next

- New to the project: [`overview.md`](overview.md) · [`.es`](overview.es.md), then the README front door.
- Picking an audience path: see the [README audience matrix](../README.md#who-this-is-for--pick-one-path).
- Editing documentation: [`project/contributing.md`](project/contributing.md) · [`.es`](project/contributing.es.md) and [`project/docs-qa.md`](project/docs-qa.md) · [`.es`](project/docs-qa.es.md).
- Auditing the documentation system: [`evidence/verification.md`](evidence/verification.md) and [`evidence/limitations.md`](evidence/limitations.md) distinguish executed evidence from explicit limitations.
