# Threat model

> **Audience:** security reviewers. This page is the closed V1 threat model for Handoff CMS. It maps every threat to a closed refusal-code union, a peer page, or an exact source location the system uses to detect or contain it. Primary OWASP citations are inline (retrieved 2026-07-28). The operator counterpart is [`hardening.md`](hardening.md) · [`.es`](hardening.es.md); the reviewer index is [`reviewer-on-ramp.md`](reviewer-on-ramp.md) · [`.es`](reviewer-on-ramp.es.md).

> [Versión en español](threat-model.es.md) · English and Spanish are peer locales. Both ship in the same pull request. See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## What this model covers

Handoff CMS is a self-hosted, governed content-handoff projection between an OIDC-authenticated author surface and a host repository that remains canonical. The system does not become a source of truth; the only bytes it writes are canonical writes authorised by a current human decision against the host `canonical_source`, plus the audit trail.

This page enumerates threats, the closed response already in code, and the residual operator obligation. Each entry is `STRIDE`-tagged and matches at least one of: a refusal-code union, a closed capability list, a peer page, or an exact source location. The page introduces no new behaviour, guarantees, or surfaces; it documents what is enforced.

Out of scope: host-side threats, the OIDC issuer's identity proofing, and browser-side accessibility attacks (see [`../accessibility/statement.md`](../accessibility/statement.md) · [`.es`](../accessibility/statement.es.md)).

## Trust zones

| Zone | Trust assumption | Source owner |
| --- | --- | --- |
| Operator workstation | `.env` and Docker secret delivery. | Operator |
| Server network | `cms_data` (internal) and `cms_egress` (only egress). | `compose.yaml` |
| Authoring client | Browser reached through OIDC bearer. | `@cms/web`, `@cms/api` |
| MCP / service clients | Tool-name and argument firewall; no approve / publish / apply. | `@cms/mcp`, `@cms/server` |
| Host repository | Filesystem alias and canonical binding; reconcile is read-only. | Adapter + host |

The OIDC issuer is trusted to assert `iss`, `aud`, `exp`, `nbf`, `tenantId`, `actorId`, `kind`, `scope`. Everything below that bar is server-validated against the closed `SERVER_AUTH_ERROR_CODES` union ([`packages/server/src/auth.ts`](../../packages/server/src/auth.ts) · [`../reference/error-codes.md`](../reference/error-codes.md) · [`.es`](../reference/error-codes.es.md)).

## Closed refusal-code unions

| Union | Package | Cited in |
| --- | --- | --- |
| `SERVER_AUTH_ERROR_CODES` | `@cms/server` | §1, §2, §3 |
| `API_ERROR_CODES` | `@cms/api` | §2, §4 |
| `ADAPTER_REFUSAL_CODES` | `@cms/adapter-sdk` | §5, §6 |
| `SYMLINK_REFUSAL_CODES` | `@cms/adapter-cerafica` | §5, §6 |
| `MEDIA_PIPELINE_ERROR_CODES` | `@cms/media` | §7 |
| `BLOB_STORE_ERROR_CODES` | `@cms/media` | §5, §7 |
| `SERVER_CONFIG_ERROR_CODES` | `@cms/server` | §9 |
| Core `ERROR_CODES` | `@cms/core` | §5, §6, §8 |

Membership is closed; a literal not in the runtime tuple is not a refusal the system can produce.

## 1. Identity

*STRIDE: Spoofing / Elevation.* A non-human identity tries to authenticate as a human author or approver.

What the system does. The `kind` claim is parsed against `'human' | 'service'` ([`packages/server/src/auth.ts`](../../packages/server/src/auth.ts)); anything else throws `E_TOKEN_MALFORMED` with redacted `extensions`. The authority facade refuses service and MCP identities on `approve`, `publish`, and `rollback` with `E_SERVICE_APPROVAL_FORBIDDEN` and `E_MCP_APPROVAL_FORBIDDEN` ([`packages/api/src/auth.ts`](../../packages/api/src/auth.ts) · [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es`](../concepts/governance-and-human-authority.es.md)).

Residual obligation. OIDC identity proofing is the issuer's contract; the system consumes `kind`. Cite: OWASP ASVS V2; OWASP Top 10 A07:2021.

## 2. Token

*STRIDE: Spoofing / Replay / Tampering.* A forged, replayed, or substituted bearer.

What the system does. Asymmetric-only verifier (`none` and `HS*` are refused). `iss`, `aud`, `exp`, `nbf` checked with bounded clock skew, bounded JWKS cache, and bounded fetch timeout ([`packages/server/src/auth.ts`](../../packages/server/src/auth.ts) · [`packages/server/src/config.ts`](../../packages/server/src/config.ts)). Failures map to `E_TOKEN_BAD_SIGNATURE`, `E_TOKEN_BAD_AUDIENCE`, `E_TOKEN_BAD_ISSUER`, `E_TOKEN_EXPIRED`, `E_TOKEN_NOT_YET_VALID`, `E_TOKEN_BAD_ALGORITHM`, or `E_OIDC_JWKS_UNAVAILABLE`. The verifier never logs the bearer.

Residual obligation. JWKS reachability, key rotation, and naming hygiene are operator concerns; 30 s clock skew is the design tolerance. Cite: OWASP ASVS V3; RFC 8725.

## 3. Audience

*STRIDE: Information disclosure.* A token for audience A is presented against audience B.

What the system does. `aud` and `iss` are checked before any authority decision ([`packages/server/src/auth.ts`](../../packages/server/src/auth.ts)); string and array `aud` are treated symmetrically. Failures throw `E_TOKEN_BAD_AUDIENCE` or `E_TOKEN_BAD_ISSUER`.

Residual obligation. One audience per deployment; do not share `CMS_OIDC_AUDIENCE` across tenants. Cite: OWASP ASVS V2.5; RFC 8725 §3.11.

## 4. Tenant binding

*STRIDE: Spoofing / Elevation.* An `X-Tenant-Id` header does not match the verified token.

What the system does. Every protected `@cms/api` request requires `X-Tenant-Id === token.tenantId` ([`packages/api/src/index.ts`](../../packages/api/src/index.ts)). Missing or mismatched headers throw `E_TENANT_HEADER_REQUIRED` or `E_TENANT_FORBIDDEN`. Every write requires `Idempotency-Key`; approve, publish, rollback, and reconcile additionally require `If-Match`.

Residual obligation. Tenant-key provenance is the operator's contract. Cite: OWASP Top 10 A01:2021.

## 5. Path and alias confinement

*STRIDE: Tampering / Repudiation.* Path traversal, symlink escape, served-alias write, derived-artifact write, alias loop, or canonical / alias confusion.

What the system does. `LocalBlobStore` resolves every key with `realpath`-based containment and refuses `..` and symlink escapes with `E_TRAVERSAL` and `E_SYMLINK_ESCAPE` ([`packages/media/src/blob-store.ts`](../../packages/media/src/blob-store.ts)). Cross-tenant access raises `E_CROSS_TENANT`; `video/` writes raise `E_VIDEO_WRITE_FORBIDDEN`. The adapter SDK refuses any `apply` to a derived artifact (`E_DERIVED_WRITE_FORBIDDEN`) or to the alias (`E_ALIAS_WRITE_FORBIDDEN`); ambiguous or cyclic bindings raise `E_AMBIGUOUS_BINDING` ([`packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts) · [`packages/adapter-sdk/src/conformance.ts`](../../packages/adapter-sdk/src/conformance.ts)). The Cerafica symlink surface refuses missing, broken, retargeted, escaping, looped, or replaced alias paths ([`packages/adapter-cerafica/src/symlink.ts`](../../packages/adapter-cerafica/src/symlink.ts)). Core path errors raise `E_BAD_PATH`, `E_ABSOLUTE_PATH`, `E_ESCAPING_PATH`, `E_SELF_ALIAS`, `E_CYCLIC_ALIAS`, `E_AMBIGUOUS_CANONICAL`, `E_BAD_REGENERATION_MODE`, and `E_EMPTY_DERIVED_ARTIFACTS` ([`packages/core/src/domain.ts`](../../packages/core/src/domain.ts)).

Residual obligation. The host filesystem is a real filesystem; the alias is a verified handle. Move the canonical file or alias only with re-activation. Cite: OWASP Top 10 A03:2021; OWASP Top 10 A04:2021.

## 6. Service / MCP firewall

*STRIDE: Elevation / Tampering.* MCP tool-name smuggling, argument-routing override, or service-path impersonation of governance primitives.

What the system does. The MCP inventory is closed ([`../reference/mcp.md`](../reference/mcp.md) · [`.es`](../reference/mcp.es.md)): five tools, two resources; no approve, publish, apply, rollback, or deploy tool. Tool names are normalised case-insensitively after collapsing separators; empty and forbidden names are refused at registration and call. Argument keys that could override the descriptor or smuggle a transition are refused; the method and path always come from the closed descriptor. The adapter harness refuses service / agent identities on `apply` with `E_AUTHORITY_FORBIDDEN`.

Residual obligation. Keep the MCP surface firewalled to the trusted network; do not register MCP-relay bridges that bypass the closed inventory. Cite: OWASP LLM Top 10 LLM06:2025.

## 7. Media — fail-closed

*STRIDE: Tampering / Information disclosure.* Malware-laden or poisoned media enters the projection.

What the system does. The pipeline is fail-closed ([`packages/media/src/blob-store.ts`](../../packages/media/src/blob-store.ts) · [`packages/media/src/pipeline.ts`](../../packages/media/src/pipeline.ts)): three namespaces; `video/` is read-only in V1. Scan and quarantine run before any encode or promotion. An unavailable scanner throws `E_MALWARE_SCAN_UNAVAILABLE`; a finding throws `E_MALWARE_DETECTED`. Magic-byte detection refuses `E_MIME_SPOOFED` and `E_SIGNATURE_MISMATCH`; byte and decompression budgets raise `E_BYTES_EXCEEDED` and `E_DECOMPRESSION_BOMB`. Peer-locale alt text is required (`E_ALT_MISSING_PEER_LOCALE`); ICC and privacy-EXIF attestations are independent (`E_ICC_ATTESTATION_MISSING`, `E_EXIF_ATTESTATION_MISSING`). Promotion is atomic per derivative; on partial failure the pipeline rolls back before surfacing the original code.

Residual obligation. The scanner is operator-deployed and operator-replaced; soften at the scanner, never in the pipeline. Cite: OWASP Top 10 A03:2021; OWASP ASVS V12.

## 8. Rollback and reconciliation

*STRIDE: Repudiation.* Rollback impersonates the original approver, or rollback is conflated with live propagation.

What the system does. A governed rollback is one compensating human-authorized action: it does not replay credentials, does not push a synthetic `live` receipt, and terminates at `canonical_written`. The proposal reaches terminal `rolled_back` and is audited as `proposal.rolled_back` ([`packages/core/src/state-machine.ts`](../../packages/core/src/state-machine.ts) · [`../reference/state-machine.md`](../reference/state-machine.md) · [`.es`](../reference/state-machine.es.md)). Asynchronous deploy reconciliation follows the canonical write and reports separately ([`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md)).

Residual obligation. Do not invent intermediate `propagating` or `live` states; let the adapter report receipts through the closed state machine. Cite: OWASP ASVS V7.3.

## 9. Configuration and secret hygiene

*STRIDE: Information disclosure / Tampering.* Operator secret leakage, missing-secret fallback, or weak quota posture.

What the system does. The server is fail-closed: required substitutions are enforced as `${VAR:?message}` in `compose.yaml`. `loadServerConfig` parses every value and throws a closed `SERVER_CONFIG_ERROR_CODES` code ([`packages/server/src/config.ts`](../../packages/server/src/config.ts)). `describeServerConfig` redacts `accessKeyId`, `secretAccessKey`, and the database URL password before logging. The build context excludes `.env`, `.env.*`, `*.pem`, `*.key`, `*.crt`, `*.p12` ([`.dockerignore`](../../.dockerignore)). The MinIO root credentials never reach the application; `minio-init` converges a bucket-scoped application user with the `cms-app` policy.

Residual obligation. Rotating a secret requires updating `.env` and any embedded URL together; the rotation checklist is on [`hardening.md`](hardening.md) · [`.es`](hardening.es.md). Cite: OWASP Secrets Management Cheat Sheet; OWASP Top 10 A02:2021.

## 10. Network split

*STRIDE: Information disclosure / Elevation.* East / west traffic to data services, or external egress from data services.

What the system does. Two compose networks ([`compose.yaml`](../../compose.yaml)): `cms_data` (internal, no ingress) hosts `postgres`, `migrations`, `minio`, `minio-init`; the server joins it for data access. `cms_egress` is the only network with external ingress; the server reaches the OIDC issuer and JWKS over it. The one-shots run with `read_only: true` and `no-new-privileges: true`. The application runs as `cms:cms` (UID / GID 10001) with `no-new-privileges: true` and `tini` PID-1 reaping. Healthchecks are loopback-only ([`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs)).

Residual obligation. Do not change network modes or publish data ports without a TLS-terminating reverse proxy. Cite: OWASP Docker Top 10; CIS Docker Benchmark §6.

## 11. Audit

*STRIDE: Repudiation / Tampering.* Audit log tampering or chain-of-custody break.

What the system does. Audit envelopes are content-addressable and detached-JWS-signed ([`packages/audit/src/index.ts`](../../packages/audit/src/index.ts) · [`packages/audit/src/canonical.ts`](../../packages/audit/src/canonical.ts) · [`packages/audit/src/jws.ts`](../../packages/audit/src/jws.ts) · [`../reference/audit-envelope.md`](../reference/audit-envelope.md) · [`.es`](../reference/audit-envelope.es.md)). Storage `append_only_violation` raises `StorageErrorCode('append_only_violation')`. Proposal lifecycle, state-machine rollback lineage, media transitions, deploy receipts, and adapter receipts are audited through the same envelope ([`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es`](../concepts/governance-and-human-authority.es.md) · [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md) · [`../reference/media-pipeline.md`](../reference/media-pipeline.md) · [`.es`](../reference/media-pipeline.es.md) · [`../reference/adapter-sdk.md`](../reference/adapter-sdk.md) · [`.es`](../reference/adapter-sdk.es.md)).

Residual obligation. Audit verification is offline and deterministic; operators own the JWS keys and the retention window. Cite: OWASP ASVS V7, V7.2, V7.3.

## 12. Health and metrics exposure

*STRIDE: Information disclosure.* Reconnaissance via `/health/*`, `/metrics`, or bearer traces.

What the system does. Four unauthenticated routes are mounted before tenant middleware ([`packages/server/src/index.ts`](../../packages/server/src/index.ts) · [`../reference/observability.md`](../reference/observability.md) · [`.es`](../reference/observability.es.md)): `GET /v1/health`, `GET /health/live`, `GET /health/ready`, `GET /metrics`. `/health/live` returns only `{ status, service, version, timestamp }`. `/health/ready` returns a `ReadinessReport` with three booleans and redacted detail; failures surface as the literals `database unavailable`, `object store unavailable`, `OIDC JWKS unavailable`. `/metrics` exposes exactly eight names with `status` as the only label; no `tenant_id`, `actor_id`, `route`, `method`, or `locale`. The Node adapter strips `cookie` and `proxy-authorization`.

Residual obligation. Keep these routes on the trusted operator network; do not proxy them through a public origin. Cite: OWASP API Security Top 10 API3; OWASP ASVS V8.

## Limitations

- **External participant accessibility testing.** External validation is a planned v1.1 goal ([`../accessibility/statement.md`](../accessibility/statement.md) · [`.es`](../accessibility/statement.es.md)).
- **Second independent adapter.** A second adapter is the v1.1 conformance gate ([`../reference/adapter-sdk.md`](../reference/adapter-sdk.md) · [`.es`](../reference/adapter-sdk.es.md)).
- **Docker daemon-backed deployment.** Compose was interpolation-only; no live daemon build or runtime was executed ([`../how-to/self-host.md`](../how-to/self-host.md) · [`.es`](../how-to/self-host.es.md)).
- **Secret-rotation calendar.** Rotation cadence is the operator's contract; the runtime does not publish one ([`hardening.md`](hardening.md) · [`.es`](hardening.es.md)).

## OWASP references

- Top 10 A01:2021 — <https://owasp.org/Top10/A01_2021-Broken_Access_Control/>
- Top 10 A02:2021 — <https://owasp.org/Top10/A02_2021-Cryptographic_Failures/>
- Top 10 A03:2021 — <https://owasp.org/Top10/A03_2021-Injection/>
- Top 10 A04:2021 — <https://owasp.org/Top10/A04_2021-Insecure_Design/>
- Top 10 A07:2021 — <https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/>
- API Security Top 10 — BOPLA — <https://owasp.org/API-Security/editions/2023/en/0xa3-excessive-data-exposure/>
- Secrets Management Cheat Sheet — <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html>
- LLM Top 10 LLM06:2025 — <https://genai.owasp.org/llm-top-10/>
- RFC 8725 — <https://datatracker.ietf.org/doc/html/rfc8725>
- RFC 9457 — <https://www.rfc-editor.org/rfc/rfc9457>
