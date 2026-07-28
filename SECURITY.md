# Security policy

> **Audience:** self-hosters, agency operators, integrators, security
> reviewers, and anyone with a vulnerability report. This page is the
> project's security contact surface. The closed V1 threat model is at
> [`docs/security/threat-model.md`](docs/security/threat-model.md) ·
> [`.es.md`](docs/security/threat-model.es.md); the operator-facing
> hardening checklist is at [`docs/security/hardening.md`](docs/security/hardening.md) ·
> [`.es.md`](docs/security/hardening.es.md); the navigable index of
> authority proofs is at [`docs/security/reviewer-on-ramp.md`](docs/security/reviewer-on-ramp.md) ·
> [`.es.md`](docs/security/reviewer-on-ramp.es.md); the source-safe
> documentation policy is at
> [`docs/security/secrets-in-docs.md`](docs/security/secrets-in-docs.md).

## Supported versions and 0.x policy

Handoff CMS is currently on a **0.x release line**. The supported surface is
the documentation, the source code, the evidence artifact, and the
verification record on the canonical Forgejo repository at
<https://git.kyanitelabs.tech/simon/handoff-cms>. Patches are accepted
against the **latest 0.x release tag** on the canonical repository. The
project does not maintain older 0.x branches in parallel: a 0.x.y release
is the supported branch until a 0.x.(y+1) release supersedes it.

This 0.x policy is deliberate and visible. The repository's three recorded
limitations in [`docs/evidence/limitations.md`](docs/evidence/limitations.md)
(Docker daemon not executed, neurodivergent-accessible by design with
external participant validation deferred to v1.1, the second independent
adapter is the v1.1 conformance gate) are part of the supported contract and
are not weakened or summarized away. The exact verified scope — typecheck
across 13 package projects, 27 test files / 899 tests, build across 13
projects, a 14-package licensing-guard scan with zero findings, a 6-test
Playwright e2e suite passing in English and Spanish across desktop / tablet
/ mobile Chromium with zero axe violations, a clean Compose config
validation, and a clean self-host healthcheck syntax check — comes verbatim
from `artifacts/g008/workspace-test-report.json`. Anything beyond that
record is not a "supported" claim.

When a 1.0 release is cut, the supported-versions table below will be filled
out for the 1.x line; until then, the 0.x latest-release rule is the entire
support policy.

| Release line | Supported | Where to report |
| --- | --- | --- |
| 0.x (latest release tag only) | Yes | This page, via the channel below |
| Older 0.x | No — please upgrade | This page, via the channel below |

## Reporting a vulnerability privately

**Do not** file a vulnerability report in a public issue, a public pull
request comment, a public discussion thread, or any community channel
operated under the project's name. A vulnerability report is private by
default. Opening it in a public surface may put downstream operators at
risk and may delay a coordinated response.

The project security owner is reachable privately through the encrypted
contact documented in
[`docs/security/reviewer-on-ramp.md`](docs/security/reviewer-on-ramp.md) ·
[`.es.md`](docs/security/reviewer-on-ramp.es.md) §"Contact". That page is
the single source of truth for the contact address; this page does not
re-publish or invent a separate address so that stale mirrors and cached
forks do not silently leak a key into a public surface. If the reviewer
on-ramp page is unreachable, follow the operational escalation path in
[`SUPPORT.md`](SUPPORT.md) §"Operational escalation" and the project
security owner will be looped in by a human maintainer.

What the private channel guarantees:

- **Private by default.** The initial report is visible to the project
  security owner and to the reporter. It is not forwarded to a public
  tracker, a vendor advisory service, or a third party without the
  reporter's consent.
- **Human triage.** A human maintainer acknowledges receipt within a
  reasonable window. The acknowledgement does not invent a service-level
  agreement; it confirms the report has reached a human and explains the
  next investigative step.
- **Coordinated disclosure.** The reporter and the project security owner
  agree on an embargo window that fits the difficulty of the fix. The
  default expectation is **90 days** from the acknowledgement, with
  reasonable extension on request when a fix requires coordination with a
  host operator or a downstream deployment.
- **Embargo respect.** Until coordinated disclosure, the project does not
  publish a CVE, a security advisory, a patch commit message that names
  the report, or a release note that names the report.

What the private channel does **not** claim:

- It does not commit to a fix-by date, a patch-on-day-N schedule, or a
  public advisory template beyond the project's existing release notes.
- It does not commit to a CVE assignment; CVE assignment is the reporter's
  and the downstream operator's decision, and the project will not request
  one on the reporter's behalf without consent.
- It does not commit to a bounty. The project is volunteer-run on the
  Apache-2.0 open core and has not stood up a bounty programme; a bounty
  is not invented here.

## What to put in a report

A useful report includes:

1. **A reproducer.** The smallest operator scenario that demonstrates the
   issue. A failing command, a payload, a request trace, or a deployment
   topology is appropriate. The reproducer is for the project security
   owner only; it is not published.
2. **The affected surface.** The package (`@cms/core`, `@cms/api`,
   `@cms/server`, `@cms/adapter-sdk`, `@cms/media`, `@cms/audit`, ...), the
   refusal-code union or capability name, and the source location if you
   have one.
3. **The impact class.** STRIDE category, OWASP Top 10 reference where
   applicable (retrieved 2026-07-28), and the affected trust zone from
   [`docs/security/threat-model.md`](docs/security/threat-model.md) ·
   [`.es.md`](docs/security/threat-model.es.md) §"Trust zones".
4. **The deployer context.** Self-hosted, agency-managed, or reference
   deployment; whether the deployment is internet-exposed; whether the
   report was found in production or in a test environment.
5. **Suggested remediation.** If you have one. The project will weigh the
   suggestion against the eight approved invariants in
   [`docs/concepts/governance-and-human-authority.md`](docs/concepts/governance-and-human-authority.md) ·
   [`.es.md`](docs/concepts/governance-and-human-authority.es.md) before
   accepting it.

## What NOT to put in a report

A vulnerability report **must not** contain a real secret or a value that
could identify a real deployment, even when the report is private. The
source-safe policy is at
[`docs/security/secrets-in-docs.md`](docs/security/secrets-in-docs.md) and
applies to vulnerability reports in full:

- No bearer tokens, OIDC or database credentials, object-store keys,
  private keys, cookies, signed URLs, tenant or customer identifiers,
  account identifiers, proposal identifiers, UUIDs, or copied request or
  log values.
- No real operator hostnames, IPs, or DNS names. Use `replace-with-*`
  placeholders or a sanitized topology diagram.
- No screenshots, screen recordings, browser exports, or `.env` excerpts
  from a real deployment. Crop or replace sensitive fields before they
  enter the report; the report will be redacted on receipt otherwise.
- No paste of a production config, CI variable dump, or `docker inspect`
  output that contains a live value. If you must show a redacted shape,
  show the redacted shape only.
- No claim that a control is present when the source does not implement
  it. Cite the refusing source location or omit the claim; the reviewer
  on-ramp is the navigation index for that.

The runtime redacts `accessKeyId`, `secretAccessKey`, and the database URL
password before any operator logging; that redaction is a defence in depth,
not a substitute for sending a clean report. A report that arrives with a
real secret triggers a credential-response coordination step that delays
the investigation and is documented in
[`docs/security/secrets-in-docs.md`](docs/security/secrets-in-docs.md)
§"Source-safe review checklist".

## Distinguishing support from vulnerability reporting

A support question is **not** a vulnerability report. If you cannot tell
which one your situation is, the rule is:

- If a third party could observe the same condition on a fresh deployment
  with the same configuration, it is a **support question**. Use
  [`SUPPORT.md`](SUPPORT.md).
- If a third party could exploit the condition against a deployment that
  is otherwise configured as documented, it is a **vulnerability report**.
  Use this page.
- If you are unsure, open a **support request** first under
  [`SUPPORT.md`](SUPPORT.md) §"Operational escalation". A human maintainer
  will route the report to the security owner if it crosses the line; the
  escalation does not require you to identify the right channel up front
  and does not force you to disclose the situation publicly in the
  process.

## Threat, hardening, and reviewer references

The detail behind the policy above lives in the security section of the
documentation tree. Every enforcement decision in this policy is anchored
in one of those pages; this page does not duplicate them.

- **Threat model** — [`docs/security/threat-model.md`](docs/security/threat-model.md) ·
  [`.es.md`](docs/security/threat-model.es.md). The closed V1 threat model,
  the trust zones, the closed refusal-code unions, and the residual
  operator obligations. The enumeration is exhaustive for V1; out-of-scope
  items are listed under "Out of scope".
- **Hardening** — [`docs/security/hardening.md`](docs/security/hardening.md) ·
  [`.es.md`](docs/security/hardening.es.md). The operator-facing checklist
  that turns the threat model into deployable configuration. Covers secret
  ownership, the rotation schedule, non-root and capability drop, network
  split, and the OIDC verifier hardening.
- **Reviewer on-ramp** — [`docs/security/reviewer-on-ramp.md`](docs/security/reviewer-on-ramp.md) ·
  [`.es.md`](docs/security/reviewer-on-ramp.es.md). The navigable index of
  authority proofs. Each proof points at the source location that
  implements it and the peer reference page that documents it. The
  on-ramp is the source of truth for the private contact address; this
  policy page does not invent a separate address.
- **Secrets in documentation** — [`docs/security/secrets-in-docs.md`](docs/security/secrets-in-docs.md).
  The source-safe policy that applies to vulnerability reports, support
  requests, and pull requests in equal measure.
- **Limitations ledger** — [`docs/evidence/limitations.md`](docs/evidence/limitations.md).
  The three recorded limitations that bound the supported surface and the
  verifier-recorded scope. The verified scope comes verbatim from
  `artifacts/g008/workspace-test-report.json`.

## After a fix is shipped

When a coordinated disclosure window closes, the project publishes:

- A release note on the canonical Forgejo repository that names the
  affected surface and the closed refusal-code union or capability, and
  references the change log. The release note does not reproduce the
  report or the reproducer.
- An update to the relevant peer page (`threat-model.md`, `hardening.md`,
  `reviewer-on-ramp.md`, or a new page) where the fix changes a documented
  contract.
- An `es.md` peer update in the **same** pull request, per the same-PR
  EN/ES zero-lag rule in [`docs/README.md`](docs/README.md)
  §"Same-PR EN/ES zero-lag" and the detailed guide at
  [`docs/project/contributing.md`](docs/project/contributing.md) ·
  [`docs/project/contributing.es.md`](docs/project/contributing.es.md).

The reporter is credited in the release note if they have given consent;
otherwise the acknowledgement is generic. The reporter's identity is not
published without consent.

## Acknowledgements

The project thanks the operators and reviewers who report privately. The
acknowledgement policy above is the entire recognition programme; the
project does not run a public hall-of-fame on its own, and does not invent
one here.

## Related pages

- [`SUPPORT.md`](SUPPORT.md) — support requests, operational escalation, and
  community conduct reports.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the contributor workflow, the
  same-PR EN/ES rule, and the explicit human merge approval requirement.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — community standards and
  enforcement ladder.
- [`LICENSE`](LICENSE) — Apache License, Version 2.0.