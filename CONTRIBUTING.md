# Contributing to Handoff CMS

> **Audience:** contributors changing the codebase, the documentation, or the
> reviewer artifacts. This page is the entry point. The detailed contributing
> guide lives at [`docs/project/contributing.md`](docs/project/contributing.md)
> and its Spanish peer [`docs/project/contributing.es.md`](docs/project/contributing.es.md);
> the docs QA rules live at [`docs/project/docs-qa.md`](docs/project/docs-qa.md)
> and its Spanish peer [`docs/project/docs-qa.es.md`](docs/project/docs-qa.es.md).
> English and Spanish are **peer locales**. Both siblings ship in the same
> pull request. See [`docs/README.md`](docs/README.md) §"Same-PR EN/ES zero-lag".

Thank you for your interest in Handoff CMS. Contributions of all sizes are
welcome: a typo fix, a new reference page, an adapter conformance test, a
hardening note. This page is the short contract; the linked guides above are
the detailed contract.

## Code of conduct

Everyone who participates in this project is expected to follow
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). The covenant is adapted from
Contributor Covenant 2.1 with the project's bilingual EN/ES peer policy, the
human-approval governance invariant, and the host-canonical-truth invariant
written into the enforcement section. By signing off on a pull request you
confirm that you have read it.

## Canonical repository and mirror

| Role | Location |
| --- | --- |
| Canonical repository (issues, pull requests, releases) | <https://git.kyanitelabs.tech/simon/handoff-cms> |
| Public mirror (read-only reference) | <https://github.com/simongonzalezdc/handoff-cms> |

All pull requests — including documentation, security, and English-only
process changes — are opened on the canonical Forgejo instance. The GitHub
repository is a discoverability mirror; it receives changes by push from
Forgejo and is not used as an issue tracker. Branches, tags, and release notes
are cut on Forgejo. The discoverability surfaces throughout the repository
label the GitHub URL as a mirror; please do the same when you write a new page
or amend a status badge.

## The non-negotiable invariants

Every change, however small, must respect the eight invariants in
[`docs/concepts/governance-and-human-authority.md`](docs/concepts/governance-and-human-authority.md) ·
[`.es.md`](docs/concepts/governance-and-human-authority.es.md). Three of them
constrain contributions directly:

1. **Host stays canonical.** The CMS never writes to a served alias. New code
   paths that propose, approve, publish, or roll back must reuse the canonical
   path and the closed `*_ERROR_CODES` / `*_REFUSAL_CODES` unions in
   `packages/*/src/**`. A change that introduces a new error code without
   naming the runtime union it belongs to is a docs-QA failure.
2. **Agents propose; humans approve.** No new capability may let a service,
   agent, or MCP identity approve, publish, apply, or roll back. Adding such
   a capability is out of scope; if you believe you need one, open an issue
   on the canonical repository and tag the security reviewer audience.
3. **Localized values require both `en` and `es`.** Every prose page in the
   documentation tree is a `*.md` + `*.es.md` peer pair. Reference pages may
   share code blocks but translate prose. Both peers ship in the same pull
   request; the parity lint mirrors the runtime `@cms/i18n`
   `assertCatalogParity` check and a failure blocks the pull request.

## Same-PR EN/ES peers (zero-lag rule)

For every user-facing prose page you change or add:

- Touch the English page (`*.md`) **and** its Spanish peer (`*.es.md`) in the
  same commit and the same pull request. The Spanish peer is a co-authored
  peer, never an after-the-fact translation.
- Use neutral Spanish. The Spanish-reading reviewer who approves the pull
  request signs off on glossary use; do not invent a regional register that
  the glossary does not cover.
- Do not fall back silently. If the Spanish peer cannot ship in the same
  pull request for a reason that is not "the page does not yet have a peer",
  open the question on the canonical repository before the change is merged.

The parity lint scope and discovery-sweep rules live at
[`docs/project/docs-qa.md`](docs/project/docs-qa.md) ·
[`.es.md`](docs/project/docs-qa.es.md) and the parity rationale is documented
in [`docs/README.md`](docs/README.md) §"Same-PR EN/ES zero-lag" and
§"Source / claim discipline".

## Independent reviewer distinct from the author

Every pull request — including one-commit documentation fixes — requires an
**independent reviewer** who is **not the author**. The reviewer may be a human
or an approved review agent, but must evaluate the actual diff and return
traceable findings. Self-review is not independent review.

For documentation changes, review must also cover both English and Spanish:
heading and link parity are mechanical gates, while a Spanish-reading reviewer
checks neutral-Spanish meaning and glossary use. Automated or agent review
never replaces the explicit human approval required to merge.

## Explicit human merge approval

No bot, automation, or merge-on-green policy may merge a pull request into a
release branch. The merge button is a **fresh human authorization event**
recorded against the reviewer identity. The reviewer who clicks the merge
button is the same human who is named on the pull request review; the merge
event and the review event are linked. This matches the eight approved
invariants in
[`docs/concepts/governance-and-human-authority.md`](docs/concepts/governance-and-human-authority.md) ·
[`.es.md`](docs/concepts/governance-and-human-authority.es.md), where
self-approval is allowed only when current policy permits it and is never
inferred.

If you have automation rights on the canonical repository, do not configure
an auto-merge for branches that touch governance code, audit code, or the
authority facade. If a hot-fix appears to require auto-merge, treat it as a
security incident under [`SECURITY.md`](SECURITY.md).

## Supported versions and version policy

Handoff CMS is on a **0.x release line**. The supported surface is documented
in [`README.md`](README.md) and is verified end-to-end against
`artifacts/g008/workspace-test-report.json`. The three limitations recorded in
[`docs/evidence/limitations.md`](docs/evidence/limitations.md) (Docker daemon
not executed, neurodivergent-accessible by design with external participant
validation deferred to v1.1, second independent adapter is the v1.1
conformance gate) are part of the supported contract; they are not weakened
or summarized away.

Patches are accepted against the **latest 0.x release tag** on the canonical
repository. The repository does not maintain older 0.x branches in parallel.
A change to behaviour must include the parity update in both `en` and `es`
peers, the change to the relevant closed union if it touches a refusal code,
and the docs-QA evidence page.

## Secrets and sensitive material

Pull requests must not contain a real secret or a value that could identify
a real deployment: bearer tokens, OIDC or database credentials, object-store
keys, private keys, cookies, signed URLs, tenant or customer identifiers,
account identifiers, proposal identifiers, UUIDs, or copied request or log
values. The closed source-safe policy is in
[`docs/security/secrets-in-docs.md`](docs/security/secrets-in-docs.md); the
runtime redacts `accessKeyId`, `secretAccessKey`, and the database URL
password before any operator logging, but the documentation boundary is not
a claim that the runtime can detect every secret in prose. Authors and
reviewers are responsible for keeping the source safe before publication.

If a real value is found during review, stop the change, remove the value
from the working copy and review artifacts, and notify the repository
security owner through the operator's established credential-response
process described in [`SECURITY.md`](SECURITY.md).

## Before you open a pull request

1. Read [`docs/README.md`](docs/README.md) and the relevant audience page in
   [`README.md`](README.md) §"Who this is for — pick one path".
2. Read the detailed guide:
   [`docs/project/contributing.md`](docs/project/contributing.md) ·
   [`docs/project/contributing.es.md`](docs/project/contributing.es.md)
   for the workflow, branch model, and commit conventions.
3. Read the docs QA guide:
   [`docs/project/docs-qa.md`](docs/project/docs-qa.md) ·
   [`docs/project/docs-qa.es.md`](docs/project/docs-qa.es.md) for the
   parity lint, the discovery-sweep rules, the source/claim discipline,
   and the disallowed marketing adjectives.
4. Read [`docs/security/secrets-in-docs.md`](docs/security/secrets-in-docs.md)
   and the source-safe review checklist inside it.
5. For governance, audit, or adapter-SDK changes, also read
   [`docs/security/reviewer-on-ramp.md`](docs/security/reviewer-on-ramp.md) ·
   [`.es.md`](docs/security/reviewer-on-ramp.es.md) and
   [`docs/security/threat-model.md`](docs/security/threat-model.md) ·
   [`.es.md`](docs/security/threat-model.es.md) before drafting.

## Reporting problems

- **Bugs and feature requests** — open an issue on the canonical Forgejo
  repository at <https://git.kyanitelabs.tech/simon/handoff-cms/issues>.
- **Security vulnerabilities** — follow the private disclosure process in
  [`SECURITY.md`](SECURITY.md). Do not open a public issue.
- **Documentation and process questions** — open an issue on the canonical
  Forgejo repository and tag the docs / community label.
- **Support questions** — follow [`SUPPORT.md`](SUPPORT.md).

## License

Handoff CMS is licensed under the Apache License, Version 2.0. By submitting
a contribution you agree that your contribution is licensed under the same
Apache-2.0 license and that you have the right to submit it under those
terms. See [`LICENSE`](LICENSE). A separate Contributor License Agreement is
not required.

## Attribution

Adapted from the Contributor Covenant 2.1 with the following project-specific
additions written into the enforcement language: the bilingual EN/ES
peer policy and the same-pull-request zero-lag rule, the
independent-reviewer and explicit-human-merge-approval requirements derived
from the eight approved governance-and-human-authority invariants, and the
canonical-repository / mirror labelling convention. The covenant text is at
<https://www.contributor-covenant.org/version/2/1/code_of_conduct/> and the
project's adaptation is in [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).