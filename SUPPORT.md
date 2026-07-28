# Support

> **Audience:** self-hosters, agency operators, integrators, end users on
> Handoff Beat, and anyone who needs help with Handoff CMS but is not filing
> a vulnerability report. The detailed operator quickstart is at
> [`docs/how-to/quickstart.md`](docs/how-to/quickstart.md) ·
> [`docs/how-to/quickstart.es.md`](docs/how-to/quickstart.es.md); the
> bring-up / configuration / day-2 guides live under
> [`docs/how-to/`](docs/how-to/); the troubleshooting index is at
> [`docs/troubleshooting.md`](docs/troubleshooting.md) ·
> [`docs/troubleshooting.es.md`](docs/troubleshooting.es.md).

## Before you open a request

Handoff CMS is a self-hosted, governed content-handoff projection. Most
questions are already answered in the documentation tree. Before opening a
request, please check the relevant audience page in
[`README.md`](README.md) §"Who this is for — pick one path" and the linked
entry in the table below.

| If you are… | Start here |
| --- | --- |
| A client / end user authoring in Handoff Beat | [`docs/concepts/handoff-beat.md`](docs/concepts/handoff-beat.md) · [`.es.md`](docs/concepts/handoff-beat.es.md) and [`docs/how-to/authoring.md`](docs/how-to/authoring.md) · [`.es.md`](docs/how-to/authoring.es.md) |
| An agency operator running the managed Compose stack | [`docs/how-to/self-host.md`](docs/how-to/self-host.md) · [`.es.md`](docs/how-to/self-host.es.md), [`docs/how-to/configure.md`](docs/how-to/configure.md) · [`.es.md`](docs/how-to/configure.es.md), [`docs/how-to/operate.md`](docs/how-to/operate.md) · [`.es.md`](docs/how-to/operate.es.md) |
| A self-hoster standing up the full stack and hardening it | [`docs/how-to/self-host.md`](docs/how-to/self-host.md) · [`.es.md`](docs/how-to/self-host.es.md), [`docs/security/hardening.md`](docs/security/hardening.md) · [`.es.md`](docs/security/hardening.es.md), [`docs/how-to/migrate.md`](docs/how-to/migrate.md) · [`.es.md`](docs/how-to/migrate.es.md), [`docs/how-to/backup-restore.md`](docs/how-to/backup-restore.md) · [`.es.md`](docs/how-to/backup-restore.es.md) |
| An integrator writing a host adapter against `@cms/adapter-sdk` | [`docs/reference/adapter-sdk.md`](docs/reference/adapter-sdk.md) · [`.es.md`](docs/reference/adapter-sdk.es.md), [`docs/concepts/architecture.md`](docs/concepts/architecture.md) · [`.es.md`](docs/concepts/architecture.es.md), [`docs/adapters/cerafica.md`](docs/adapters/cerafica.md) · [`.es.md`](docs/adapters/cerafica.es.md) |
| A contributor changing the codebase or documentation | [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/project/contributing.md`](docs/project/contributing.md) · [`.es.md`](docs/project/contributing.es.md), [`docs/project/docs-qa.md`](docs/project/docs-qa.md) · [`.es.md`](docs/project/docs-qa.es.md) |
| A security reviewer auditing the system | [`docs/security/reviewer-on-ramp.md`](docs/security/reviewer-on-ramp.md) · [`.es.md`](docs/security/reviewer-on-ramp.es.md), [`docs/security/threat-model.md`](docs/security/threat-model.md) · [`.es.md`](docs/security/threat-model.es.md), [`docs/security/hardening.md`](docs/security/hardening.md) · [`.es.md`](docs/security/hardening.es.md) |

The three documented limitations — Docker daemon not executed,
neurodivergent-accessible by design with external participant validation
deferred to v1.1, the second independent adapter is the v1.1 conformance
gate — are recorded in
[`docs/evidence/limitations.md`](docs/evidence/limitations.md) and are
visible on the relevant audience pages. They are part of the supported
contract, not a quirk to be discovered mid-support.

## How to get support

Support for Handoff CMS is community-driven and the project does not
advertise a paid support tier or a guaranteed response time. Two channels
are available; pick the one that fits the question.

### 1. Public issue tracker (canonical)

Open an issue on the canonical Forgejo repository at
<https://git.kyanitelabs.tech/simon/handoff-cms/issues> with one of:

- `support` — usage, configuration, deployment, or workflow question.
- `docs` — documentation request, ambiguity, or missing peer.
- `bug` — reproducible misbehaviour against the documented contract.
- `question` — anything that does not fit the labels above.

The public GitHub repository at
<https://github.com/simongonzalezdc/handoff-cms> is a mirror; it does not
host the issue tracker. Please open issues on the canonical instance so the
report reaches the human maintainers who triage them. The same-PR EN/ES
zero-lag rule in [`CONTRIBUTING.md`](CONTRIBUTING.md) applies to issue
reports where a translation is needed: an issue written in one locale is
welcome and the project does not translate it in place.

### 2. Community discussion (where one exists)

If the project operates a community discussion space, it is linked from
the canonical repository's README. A discussion thread is appropriate for
design questions, share-pattern questions, and "is anyone else seeing
this?" questions. A discussion thread is **not** the right place for a
vulnerability, a credential exposure, or an operational incident — see
[`SECURITY.md`](SECURITY.md) and §"Operational escalation" below.

## What to include in a support request

A useful support request includes:

1. **The audience role.** Client / end user, agency operator, self-hoster,
   integrator, contributor, or security reviewer.
2. **The deployment shape.** Self-hosted, agency-managed, reference
   deployment, or local development; the relevant `compose.yaml` /
   `Dockerfile` / package version you are running; whether you are behind
   a reverse proxy.
3. **The documented command or page you were following.** A link to the
   audience page, the how-to, or the reference page that the question is
   about helps the maintainer route the request.
4. **The observed behaviour and the expected behaviour.** Both, in plain
   prose, with the closed refusal code if one was returned. Closed
   refusal codes come from `packages/*/src/**` and are documented at
   [`docs/reference/error-codes.md`](docs/reference/error-codes.md) ·
   [`docs/reference/error-codes.es.md`](docs/reference/error-codes.es.md).
5. **The relevant log or trace, redacted.** The runtime redacts
   `accessKeyId`, `secretAccessKey`, and the database URL password before
   any operator logging, but a clean request is a clean request: please do
   not paste bearer tokens, OIDC or database credentials, object-store
   keys, private keys, cookies, signed URLs, tenant or customer
   identifiers, account identifiers, proposal identifiers, UUIDs, or
   copied request or log values. The source-safe policy is at
   [`docs/security/secrets-in-docs.md`](docs/security/secrets-in-docs.md)
   and applies to support requests in full.

A support request is **not** an SLA. The project does not commit to a
first-response window, a resolution window, or an on-call rotation here;
a maintainer's reply is on a best-effort basis.

## Operational escalation

If you are running Handoff CMS in production and an incident is in
progress — a deployment is stuck in `canonical_written`, a media upload is
failing in quarantine, an OIDC verifier is rejecting every token, or a
host adapter reports an `ADAPTER_REFUSAL_CODES` / `SYMLINK_REFUSAL_CODES`
value you cannot resolve from the documentation — the steps are:

1. Open a public issue with the `support` label and the audience role.
   Mark the title with `[incident]` so a maintainer can spot it.
2. Cross-link the closed refusal-code union that is being returned (see
   [`docs/reference/error-codes.md`](docs/reference/error-codes.md) ·
   [`docs/reference/error-codes.es.md`](docs/reference/error-codes.es.md)).
3. If the incident is a security concern — a suspected unauthorized
   write, a leaked credential, an unexpected identity, an audit-envelope
   verification failure — **stop opening a public issue** and follow
   [`SECURITY.md`](SECURITY.md) §"Reporting a vulnerability privately"
   instead. The boundary between "support" and "vulnerability" is
   documented at [`SECURITY.md`](SECURITY.md) §"Distinguishing support
   from vulnerability reporting".
4. If the incident is operational but not security-sensitive — for
   example, the Docker daemon limitation in
   [`docs/evidence/limitations.md`](docs/evidence/limitations.md) prevents
   a bring-up — the support channel is the right place. The incident is
   documented, not exploited.

The project does not commit to an incident-response window here. If your
deployment requires a contractual SLA, that is an operator-side obligation
to instrument, not a project-side guarantee.

## Community conduct reports

Behaviour in community spaces — the canonical Forgejo issue tracker, the
public GitHub mirror, the discussion channels, the pull-request review
surface — is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
Reports of behaviour that violates the covenant are **not** support
requests and **not** vulnerability reports:

- They are not filed as a `support` issue on the public tracker.
- They are not filed through the private disclosure channel in
  [`SECURITY.md`](SECURITY.md); a conduct report is not a security
  report.
- They are not filed in a pull-request review thread, an issue comment,
  or a code review comment. Those surfaces are not appropriate for
  conduct escalation.

The community-conduct channel is documented in
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) §"Enforcement". A human
maintainer who is not the reporter triages every conduct report; a service
or MCP identity may not triage, sanction, or close a conduct report on
behalf of the project. The triage step does not invent a target response
time; the acknowledgement step confirms the report has reached a human.

## What the project does not provide here

This page does not invent the following:

- **No SLA.** No first-response window, no resolution window, no on-call
  rotation. The project is volunteer-run on the Apache-2.0 open core; if
  you need a contractual SLA, that is an operator-side obligation.
- **No paid support tier.** The project does not advertise a paid support
  channel; if a paid support tier exists it is offered by a third party,
  not by the project, and is out of scope for this page.
- **No CVE / bounty.** CVE assignment and bounty programmes are not run
  by the project. See [`SECURITY.md`](SECURITY.md) §"Reporting a
  vulnerability privately".
- **No live-chat escalation.** If a live-chat channel exists in the
  community it is best-effort and may be unmonitored; do not use it for
  a security report.
- **No second license for support content.** This page is licensed under
  the same Apache License, Version 2.0 as the rest of the project; the
  project does not add a second license for support content. See
  [`LICENSE`](LICENSE).

## Related pages

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the contributor workflow, the
  same-PR EN/ES rule, and the explicit human merge approval requirement.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — community standards and the
  conduct-report channel.
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting, supported
  versions, and the source-safe policy.
- [`LICENSE`](LICENSE) — Apache License, Version 2.0.
- [`docs/README.md`](docs/README.md) — the documentation map and the
  same-PR EN/ES zero-lag rule.