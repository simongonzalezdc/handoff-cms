# Security reviewer on-ramp

> **Audience:** security reviewers. This page is a navigable index of the
> authority proofs and containment boundaries in Handoff CMS v1. It records
> source-backed contracts; it does not add controls or claim deployment
> validation.
>
> [Versión en español](reviewer-on-ramp.es.md) · English and Spanish are peer
> locales. Both siblings ship in the same pull request; neither locale falls
> back to the other. For the documentation source-safety rules, see
> [`secrets-in-docs.md`](secrets-in-docs.md). The secrets policy is
> published in English only; the ES on-ramp sibling links back to this
> English page so reviewers in both locales reach the same rule.


## Review order

Start with the [content boundary](../concepts/content-boundary.md) and the
[human-authority lifecycle](../concepts/governance-and-human-authority.md).
Then use the index below to inspect the owning source and its peer reference.
The host repository remains canonical: the system proposes, obtains a current
human decision, writes only `canonical_source`, records the result, and
coordinates a separate live-propagation beat. Commerce fields remain
coordinator-gated and client-read-only. Reconciliation is asynchronous and
read-only.

| Proof surface | What to establish | Source proof | Peer documentation |
| --- | --- | --- | --- |
| Authority index | A privileged transition is a current human-authorized system transition, not an adapter, service, agent, or MCP capability. | [`packages/api/src/auth.ts`](../../packages/api/src/auth.ts), [`packages/core/src/policy.ts`](../../packages/core/src/policy.ts), [`packages/core/src/state-machine.ts`](../../packages/core/src/state-machine.ts) | [`governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es`](../concepts/governance-and-human-authority.es.md), [`threat-model.md`](threat-model.md) · [`.es`](threat-model.es.md) |
| OIDC identity and codes | Verify asymmetric JWTs against the configured issuer, audience, expiry, and optional not-before claim; confirm the closed refusal vocabulary and redacted failure path. | [`packages/server/src/auth.ts`](../../packages/server/src/auth.ts), [`packages/server/src/config.ts`](../../packages/server/src/config.ts) | [`error-codes.md`](../reference/error-codes.md) · [`.es`](../reference/error-codes.es.md), [`threat-model.md#2-token`](threat-model.md#2-token) |
| MCP firewall | Confirm the closed tool/resource inventory and the name/argument firewall. MCP can propose or read, but has no approve, publish, apply, deploy, or rollback primitive. | [`packages/mcp/src/server.ts`](../../packages/mcp/src/server.ts), [`packages/api/src/auth.ts`](../../packages/api/src/auth.ts) | [`mcp.md`](../reference/mcp.md) · [`.es`](../reference/mcp.es.md), [`threat-model.md#6-service--mcp-firewall`](threat-model.md#6-service--mcp-firewall) |
| Audit envelope | Confirm canonical bytes, content-addressed event id, detached Ed25519 JWS, and malformed-input failure. Confirm that the envelope schema has no secret field. | [`packages/audit/src/index.ts`](../../packages/audit/src/index.ts), [`packages/audit/src/canonical.ts`](../../packages/audit/src/canonical.ts), [`packages/audit/src/jws.ts`](../../packages/audit/src/jws.ts) | [`audit-envelope.md`](../reference/audit-envelope.md) · [`.es`](../reference/audit-envelope.es.md), [`threat-model.md#11-audit`](threat-model.md#11-audit) |
| Media quarantine | Confirm inbound bytes are validated before promotion: structural checks, signature/MIME match, decode and pixel limits, malware scan fail-closed, then complete derivative attestation and atomic promotion. | [`packages/media/src/pipeline.ts`](../../packages/media/src/pipeline.ts), [`packages/media/src/blob-store.ts`](../../packages/media/src/blob-store.ts) | [`media-pipeline.md`](../reference/media-pipeline.md) · [`.es`](../reference/media-pipeline.es.md), [`threat-model.md#7-media--fail-closed`](threat-model.md#7-media--fail-closed) |
| Alias and path confinement | Confirm one canonical path, a closed derived-artifact list, `alias_symlink` only, repository containment, no traversal/escape/loop, and no direct alias or derived writes. | [`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts), [`packages/adapter-sdk/src/conformance.ts`](../../packages/adapter-sdk/src/conformance.ts), [`packages/adapter-cerafica/src/symlink.ts`](../../packages/adapter-cerafica/src/symlink.ts), [`packages/media/src/blob-store.ts`](../../packages/media/src/blob-store.ts) | [`content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md), [`adapter-sdk.md`](../reference/adapter-sdk.md) · [`.es`](../reference/adapter-sdk.es.md), [`threat-model.md#5-path-and-alias-confinement`](threat-model.md#5-path-and-alias-confinement) |
| Network split | Confirm data services are on an internal-only network, while only the server joins the egress network for OIDC/JWKS; inspect one-shot container restrictions. | [`compose.yaml`](../../compose.yaml), [`Dockerfile`](../../Dockerfile) | [`threat-model.md#10-network-split`](threat-model.md#10-network-split), [`hardening.md`](hardening.md) · [`.es`](hardening.es.md) |
| Runtime hardening | Confirm fail-closed configuration, bounded body/rate quotas, redacted diagnostics, PII-free logs, operator health/metrics boundaries, and build-context exclusions. | [`packages/server/src/config.ts`](../../packages/server/src/config.ts), [`packages/server/src/index.ts`](../../packages/server/src/index.ts), [`.dockerignore`](../../.dockerignore) | [`configure.md`](../how-to/configure.md) · [`.es`](../how-to/configure.es.md), [`observability.md`](../reference/observability.md) · [`.es`](../reference/observability.es.md), [`threat-model.md#9-configuration-and-secret-hygiene`](threat-model.md#9-configuration-and-secret-hygiene) |

The linked reference pages are evidence navigation, not a substitute for
reading the source. A page may say *verified* only when it cites the workspace
evidence artifact; this on-ramp uses *confirm* and *inspect* for review steps.

## Proof notes

### 1. Authority and state beats

The API is the sole authority transport over core and storage. The authority
facade refuses service identities and MCP-capable identities for `approve`,
`publish`, and `rollback` before policy evaluation, using
`E_SERVICE_APPROVAL_FORBIDDEN` and `E_MCP_APPROVAL_FORBIDDEN`. Policy still
checks grants, versions, roles, field capabilities, and self-approval rules.
A delegated-human identity carries a bounded delegation window that is checked
again at request time; delegation does not turn a service credential into a
human decision.

A publish transition writes the host canonical source and records
`canonical_written`. A deploy receipt is a separate asynchronous beat. A
failed propagation receipt leaves the proposal at `canonical_written`; it does
not invent `propagating` or `live`. A current human rollback is one policy-
checked action and terminates the proposal at `rolled_back`; it does not replay
a credential or impersonate the original approver. Inspect the state-machine
union and API route handling before treating any live receipt as proof of a
canonical write.

### 2. OIDC proof and closed codes

The verifier accepts only configured asymmetric algorithms (RS, ES, or PS
variants); `none` and `HS*` are refused. It checks `iss`, `aud`, `exp`, and
`nbf` through the JWKS-backed verifier, with bounded cache and fetch timeout.
The post-verification claims also require `sub`, `iat`, `tenantId`, `actorId`,
`kind`, and `scope`; `kind` is `human` or `service`. The verifier never logs
or echoes the bearer value.

Review the exact `SERVER_AUTH_ERROR_CODES` members in
[`error-codes.md`](../reference/error-codes.md) rather than accepting an
invented error name. The relevant closed values are
`E_TOKEN_MISSING`, `E_TOKEN_MALFORMED`, `E_TOKEN_BAD_SIGNATURE`,
`E_TOKEN_BAD_AUDIENCE`, `E_TOKEN_BAD_ISSUER`, `E_TOKEN_EXPIRED`,
`E_TOKEN_NOT_YET_VALID`, `E_TOKEN_BAD_ALGORITHM`, and
`E_OIDC_JWKS_UNAVAILABLE`. Issuer key rotation and identity proofing remain
operator/issuer responsibilities; the product consumes the validated claims
and does not overclaim upstream assurance.

### 3. MCP name and argument firewall

The MCP projection exposes exactly five tools (`proposeEdit`, `suggestAltText`,
`suggestCrop`, `generatePreview`, `submitApprovalRequest`) and two read
resources (`proposal://{id}`, `health://`). Registration and invocation reject
empty names and forbidden approval, publication, application, deployment,
rollback, force, admin, bypass, signing, arbitrary-request, proxy, fetch,
exec, run, invoke, and transition spellings after separator normalization.

Arguments are plain objects. Keys that could override a descriptor or smuggle a
route/action (`method`, `path`, `url`, `endpoint`, `target`, `action`, `op`,
`operation`, `verb`, `route`, `request`, `raw`, `override`, `bypass`, `force`,
`patch`, `transition`, `forward`, `proxy`, `exec`, `run`, `invoke`, `http`,
`fetch`, `send`, and privileged verb variants) are refused. Calls use the
registered method and path, never caller-supplied routing. The approval-request
tool only signals an out-of-band human; it does not transition approval.

### 4. Audit envelope and chain of custody

`AuditEvent` binds tenant, actor, optional delegated human, proposal and its
content hash, approval and self-approval flag, host result, deploy result, and
rollback lineage. Required IDs and artifact hashes are lowercase SHA-256
values. `buildEvent` validates and returns an immutable structural copy;
`signEvent` signs canonical bytes with a detached JWS; `verifyEnvelope` returns
`false` for malformed shape, mismatched hashes or IDs, bad protected headers,
or an invalid signature rather than accepting partial evidence. The envelope
contract explicitly says it never stores secrets. Storage's append-only
violation is a separate refusal recorded by the storage layer.

### 5. Media quarantine and promotion

The governed media pipeline validates structure before authorization clues,
then applies byte caps, magic-byte signature and declared-MIME matching,
decode/dimension/pixel limits, focal/crop validation, and malware scanning.
Scanner errors, an unavailable verdict, or a non-clean verdict remain in
`quarantine`; they do not silently promote. Every derivative is encoded and
attested before any published object is visible. Promotion is atomic per object
and partial promotion is cleaned up or returned as a quarantine outcome.
Success attests ICC preservation and privacy-EXIF stripping. Video mutation is
rejected in v1.1's read-only video namespace. Peer-locale alt text is required
unless the image is decorative; missing `en` or `es` is rejected, never
silently defaulted.

### 6. Alias and path confinement

A binding has exactly one `canonical_source`, a non-empty closed
`derived_artifacts[]`, and an explicit regeneration contract. v1 recognises
only `alias_symlink`. Activation rejects ambiguous canonical pointers, empty
derived artifacts, self aliases, alias targets that escape the repository,
cycles, and alias targets that collide with the canonical source. The
Cerafica verifier uses real filesystem inspection (`lstat`, `readlink`,
`realpath`) and refuses missing, broken, retargeted, escaping, looped, or
regular-file aliases.

`reconcile` re-verifies the alias and canonical hash and never writes. `apply`
can write only the canonical source; direct writes to an alias or derived
artifact are refused before host work. Media keys are tenant-bound and reject
absolute paths, traversal segments, NUL, symlink escape, and cross-tenant
operations. The host remains the source of truth; served aliases are verified
handles, not editable pointers.

### 7. Network and runtime hardening

In `compose.yaml`, `cms_data` is internal-only and carries Postgres, MinIO, and
one-shot initializers. `cms_egress` is the externally capable network and only
the server joins both networks so it can reach the configured OIDC/JWKS
endpoint. The migration and MinIO initializer are one-shot, read-only, and
use `no-new-privileges`; Postgres and MinIO data live in named volumes. A
reverse proxy and TLS termination are operator responsibilities, not implied
by this topology.

`loadServerConfig` requires the runtime's required values and rejects malformed
URLs, integers, locales, log levels, and JWS algorithm lists. Diagnostics redact
object-store credentials and database URL credentials/path/query. The Node
boundary enforces request-body and source-rate quotas before the API; logs are
structured and omit bearer values. `/health/live`, `/health/ready`, and
`/metrics` are operator surfaces with deliberately bounded output; keep them
on a trusted operator network. `.dockerignore` excludes environment files and
private-key extensions from the build context. The Docker daemon was not
executed for this documentation review, so this page makes no live-container
claim.

## Reviewer exit checklist

- [ ] The authority index above has a source link and a peer page for every
      proof surface under review.
- [ ] Every privileged transition is traced to a current human decision and a
      state-machine edge; adapters, services, agents, and MCP are not treated
      as authority.
- [ ] OIDC checks and the exact closed error union are reviewed without
      copying a token, issuer secret, tenant, or account value.
- [ ] MCP names and argument keys are tested against the closed firewall; no
      arbitrary routing seam is assumed.
- [ ] Audit verification covers canonical bytes, event id, signature, hash
      links, rollback lineage, and append-only persistence.
- [ ] Media failures remain quarantined and no derivative is served before
      complete validation and attestation.
- [ ] Alias, canonical, derived, and tenant paths are checked for confinement;
      reconcile is read-only and apply is canonical-only.
- [ ] Compose network membership, one-shot restrictions, config redaction,
      quotas, health/metrics exposure, and build-context exclusions are
      reviewed as operator controls, without claiming Docker execution.
- [ ] EN/ES pages are present as peers, all links are relative, and no page
      falls back silently to another locale.
- [ ] Documentation examples pass the [secrets policy](secrets-in-docs.md):
      only `replace-with-*` placeholders, never real identifiers or
      credentials. The secrets policy is published in English only; the ES
      on-ramp sibling links back to this page so reviewers in both locales
      reach the same rule without a silent fallback.

## Scope and limitations

This on-ramp is source-grounded. It does not prove the upstream OIDC issuer's
identity proofing, host repository branch protection, reverse-proxy TLS,
operator secret rotation cadence, or a live Docker deployment. See the
[threat-model limitations](threat-model.md#limitations) and the evidence
ledger when making a claim about execution rather than source shape.

## OWASP references

All external references in this section were retrieved on 2026-07-28.

- OWASP Top 10 A01:2021, [Broken Access Control](https://owasp.org/Top10/A01_2021-Broken_Access_Control/).
- OWASP Top 10 A02:2021, [Cryptographic Failures](https://owasp.org/Top10/A02_2021-Cryptographic_Failures/).
- OWASP Top 10 A03:2021, [Injection](https://owasp.org/Top10/A03_2021-Injection/).
- OWASP Top 10 A04:2021, [Insecure Design](https://owasp.org/Top10/A04_2021-Insecure_Design/).
- OWASP Top 10 A07:2021, [Identification and Authentication Failures](https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/).
- OWASP, [Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).
- OWASP LLM Top 10 LLM06:2025, [Excessive Agency](https://genai.owasp.org/llm-top-10/).
- OWASP ASVS, [V7 Error Handling and Logging](https://owasp.org/www-project-application-security-verification-standard/).
