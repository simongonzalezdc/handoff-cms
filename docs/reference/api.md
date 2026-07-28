# API reference

> [Versión en español](api.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

The HTTP API is the **authority surface** of Handoff CMS. It is the only transport that can move a proposal through `proposed → approved → canonical_written → live`. The CLI and the MCP server are projections on top of this surface; the adapter SDK is a frozen contract for the host-side projection. The host stays canonical: nothing inside the API edits the canonical repository directly. The live propagation beat is recorded separately via deploy receipts and is never conflated with the canonical write.

The authoritative machine-readable document is [`openapi.json`](openapi.json) of this directory. TypeScript is canonical: the JSON document is generated deterministically from `openApiDocument` in `packages/api/src/openapi.ts` and **must** deep-equal the source on every change. Do not hand-edit the JSON; regenerate from the exported constant.

## Endpoints (exactly eight)

Every non-2xx response is `application/problem+json` (RFC 9457). The eight endpoints, in the order they appear in `openApiDocument`, are:

| # | Method | Path | Auth | `Idempotency-Key` | `If-Match` | operationId |
| - | --- | --- | --- | --- | --- | --- |
| 1 | `GET` | `/v1/health` | none | — | — | `getHealth` |
| 2 | `POST` | `/v1/proposals` | bearer | required | — | `createProposal` |
| 3 | `GET` | `/v1/proposals/{id}` | bearer | — | — | `getProposal` |
| 4 | `POST` | `/v1/proposals/{id}/approve` | bearer | required | required | `approveProposal` |
| 5 | `POST` | `/v1/proposals/{id}/publish` | bearer | required | required | `publishProposal` |
| 6 | `POST` | `/v1/proposals/{id}/rollback` | bearer | required | required | `rollbackProposal` |
| 7 | `POST` | `/v1/publications/{id}/deploy-receipts` | bearer | required | — | `recordDeployReceipt` |
| 8 | `POST` | `/v1/proposals/{id}/reconcile` | bearer | required | required | `reconcileProposal` |

These eight endpoints are the entire `/v1` surface; the API does not register any other `v1` paths. The discovery-sweep parity lint scans `packages/api/src/index.ts` and rejects any route registered outside the eight above.

## Request headers

`openapi.json` declares the following reusable components:

| Header | Required on | Profile |
| --- | --- | --- |
| `Authorization` | every endpoint except `GET /v1/health` | `Bearer <token>`; the token is audience-bound, tenant-bound, and expiry-checked. The verifier rejects `none` and `HS*` algorithms via the configured `CMS_OIDC_ALGORITHMS` allow-list. |
| `X-Tenant-Id` | every endpoint except `GET /v1/health` | UUID. The token's `tenantId` claim must match the header value; mismatches return `E_TENANT_FORBIDDEN` (403). |
| `Idempotency-Key` | every write endpoint (rows 2, 4, 5, 6, 7, 8) | Opaque token, max 200 chars, pattern `^[A-Za-z0-9._:-]+$`. Replays with a different fingerprint return `E_IDEMPOTENCY_REPLAY_MISMATCH` (409); concurrent attempts return `E_IDEMPOTENCY_IN_PROGRESS` (409). |
| `If-Match` | every state-transition endpoint (rows 4, 5, 6, 8) | Expected current `version` of the proposal. Missing header returns `E_VERSION_HEADER_REQUIRED` (428); stale version returns `E_OPTIMISTIC_CONCURRENCY_CONFLICT` (409). |
| `Accept-Language` | optional on every endpoint | Peer locale preference. Omitted defaults to `en`; a non-empty value with no supported `en` or `es` language range returns `E_BAD_LOCALE` (400). |

The `Content-Type` for write requests is `application/json`. Non-JSON bodies return `E_UNSUPPORTED_MEDIA_TYPE` (415); bodies larger than `CMS_QUOTA_REQUEST_BYTES_CAP` return `E_PAYLOAD_TOO_LARGE` (413).

`GET /v1/health` is the only route that does not require `Authorization` or `X-Tenant-Id`. It is registered first and short-circuits before every other middleware, so it remains available even when the verifier or database are unreachable. It returns `200` with the negotiated peer locale, or an RFC 9457 `400 E_BAD_LOCALE` problem for a non-empty unsupported language preference.

## Bearer token contract (OIDC)

The bearer token is verified by a pluggable `TokenVerifier` (see `packages/api/src/auth.ts`). The host wires a real implementation (JWT verify, DPoP, mTLS, etc.) and the API surface treats it as a pure function: present the raw `Authorization` header, get a `VerifiedToken` or throw. After verification, the API checks the following claims:

| Claim | Condition | Failure code |
| --- | --- | --- |
| `aud` | audience must equal the API's configured audience | `E_TOKEN_AUDIENCE_MISMATCH` (401) |
| `exp` | current time in seconds must be strictly less than `exp` | `E_TOKEN_EXPIRED` (401) |
| `iat` | current time in seconds must be greater than or equal to `iat` | `E_TOKEN_MALFORMED` (401) |
| `actorId` | non-empty | `E_TOKEN_MALFORMED` (401) |
| `tenantId` | non-empty | `E_TOKEN_MALFORMED` (401) |
| `kind` | `human` or `service` | `E_TOKEN_MALFORMED` (401) |
| `tenantId` | must equal `X-Tenant-Id` header | `E_TENANT_FORBIDDEN` (403) |

The `openapi.json` security component declares a single `bearerAuth` scheme: `http`, `scheme: bearer`, `bearerFormat: JWT`, with the description *“Audience-bound and tenant-bound bearer token. MCP delegated sessions are valid.”* Every protected path defaults to `security: [{ bearerAuth: [] }]`; `GET /v1/health` overrides with `security: []`.

The verifier is **not** the same as the server-side OIDC verifier described in `docs/reference/configuration.md` (the `CMS_OIDC_*` settings). The server-side verifier sits at the boot strap and validates the underlying OIDC issuer fetch and algorithm allow-list; the API-side verifier is the contract every request runs through. The two share the same `ServerAuthErrorCode` vocabulary for the token cases, plus `E_UNAUTHORIZED` (401) at the API surface for the actor-lookup failure.

## RFC 9457 problem responses

Every non-2xx response body is a `Problem` object with the exact eight required fields:

| Field | Type | Description |
| --- | --- | --- |
| `type` | string | Stable URN `urn:cms:problem:<scope>:<code>` |
| `title` | string | Short, locale-localized |
| `status` | integer | HTTP status, mirrored in the response line |
| `detail` | string | Human-readable, locale-localized |
| `instance` | string | The request URL |
| `code` | string | Stable machine code from the closed union |
| `locale` | string | The resolved peer locale (`en` or `es`) |
| `extensions` | object | Opaque pass-through; `errors[]` for per-field validation |

The `type` field encodes the problem scope via `problemCodeScope`. `ProblemCode` has 58 distinct literals: the raw declarations contain 60 entries across core (27), storage (13), and API (20), with two authority literals shared by core and API. The `extensions` object carries identifiers (`tenantId`, `proposalId`, `approvalId`, `publicationId`, `deployReceiptId`, `revisionId`, `idempotencyKey`), locale hints, the `selfApproved` flag, the `traceId`, and a per-field `errors[]` array whose `code` is again a `ProblemCode`. Caller data is carried in `errors[]`, never interpolated into catalog `detail`.

The error response uses `application/problem+json`; `openapi.json` reuses `components.responses.Problem` across path operations. `POST /v1/proposals` returns `201` on success. Recording a pending deployment receipt returns `202`; terminal deployment receipts and every other successful operation return `200`.

## `API_ERROR_CODES` and the `ProblemCode` relationship

`API_ERROR_CODES` is the closed union of HTTP-layer codes the API surface emits. It is exported from `packages/api/src/problem.ts:38-59` and contains exactly **20** literals. The union is the API half of the `ProblemCode` aggregator:

```ts
// packages/api/src/problem.ts:68-69
export type ProblemCode = CoreErrorCode | StorageErrorCode | ApiErrorCode;
export type ProblemCodeScope = 'core' | 'storage' | 'api';
```

The full 20-code API table (with the HTTP status `statusFor` returns):

| Code | Status | Meaning |
| --- | --- | --- |
| `E_BAD_REQUEST` | 400 | The request body or query parameters are malformed. |
| `E_UNSUPPORTED_MEDIA_TYPE` | 415 | The request `Content-Type` is not accepted on this endpoint. |
| `E_PAYLOAD_TOO_LARGE` | 413 | The request body exceeds the configured maximum size. |
| `E_IDEMPOTENCY_KEY_REQUIRED` | 400 | Writes require an `Idempotency-Key` header. |
| `E_IDEMPOTENCY_KEY_MALFORMED` | 400 | The `Idempotency-Key` header is not a well-formed opaque token. |
| `E_IDEMPOTENCY_REPLAY_MISMATCH` | 409 | The same `Idempotency-Key` was replayed with a different request fingerprint. |
| `E_IDEMPOTENCY_IN_PROGRESS` | 409 | A previous attempt with this `Idempotency-Key` is still in progress. |
| `E_OPTIMISTIC_CONCURRENCY_CONFLICT` | 409 | The expected `If-Match` version is stale; re-read the resource and retry. |
| `E_VERSION_HEADER_REQUIRED` | 428 | This endpoint requires an `If-Match` header for optimistic concurrency. |
| `E_UNAUTHORIZED` | 401 | The request did not present a valid credential. |
| `E_TOKEN_MISSING` | 401 | The `Authorization` header is missing or empty. |
| `E_TOKEN_MALFORMED` | 401 | The bearer token could not be verified. |
| `E_TOKEN_EXPIRED` | 401 | The bearer token is past its `exp` claim; refresh and retry. |
| `E_TOKEN_AUDIENCE_MISMATCH` | 401 | The token audience does not match the API audience. |
| `E_SERVICE_APPROVAL_FORBIDDEN` | 403 | Service identity cannot approve, publish, or rollback. |
| `E_MCP_APPROVAL_FORBIDDEN` | 403 | MCP-capable identities are agents and may not approve or publish. |
| `E_DELEGATION_EXPIRED` | 403 | The delegating human session has expired; obtain a fresh delegation. |
| `E_TENANT_HEADER_REQUIRED` | 400 | The `X-Tenant-Id` header is required for every multi-tenant request. |
| `E_TENANT_FORBIDDEN` | 403 | The resolved identity is not authorized to operate on the requested tenant. |
| `E_INTERNAL` | 500 | An unexpected error occurred; the trace identifier is in the response extension. |

Two API literals also appear in core (`E_SERVICE_APPROVAL_FORBIDDEN`, `E_MCP_APPROVAL_FORBIDDEN`). `problemCodeScope` checks core first, then storage, then API. The raw declarations therefore total 60 entries while the deduplicated `ProblemCode` union contains 58 distinct literals. See [`error-codes.md`](error-codes.md) for the complete overlap record.

Both `en` and `es` peers carry reviewed `title` and `detail` messages for every code. An omitted `Accept-Language` header has the explicit protocol default `en`; a non-empty header with no supported `en` or `es` peer is rejected with `E_BAD_LOCALE` rather than silently falling back.

## `SERVER_AUTH` diagnostics

`SERVER_AUTH_ERROR_CODES` is the server-side OIDC diagnostic union. It shares three literals with the API union (`E_TOKEN_MISSING`, `E_TOKEN_MALFORMED`, `E_TOKEN_EXPIRED`) and adds six verifier/JWKS diagnostics. Audience mismatch uses different literals at the two layers: API `E_TOKEN_AUDIENCE_MISMATCH` versus server `E_TOKEN_BAD_AUDIENCE`.

| Server auth code | When it fires | API surface it maps to |
| --- | --- | --- |
| `E_TOKEN_MISSING` | Server-side token header missing or empty | `E_TOKEN_MISSING` (401) |
| `E_TOKEN_MALFORMED` | Server-side token cannot be parsed | `E_TOKEN_MALFORMED` (401) |
| `E_TOKEN_BAD_SIGNATURE` | Server-side signature check fails | `E_TOKEN_MALFORMED` (401) |
| `E_TOKEN_BAD_AUDIENCE` | Server-side audience mismatch | `E_TOKEN_AUDIENCE_MISMATCH` (401) |
| `E_TOKEN_BAD_ISSUER` | Server-side issuer mismatch | `E_TOKEN_MALFORMED` (401) |
| `E_TOKEN_EXPIRED` | Server-side `exp` check fails | `E_TOKEN_EXPIRED` (401) |
| `E_TOKEN_NOT_YET_VALID` | Server-side `nbf` check fails | `E_TOKEN_MALFORMED` (401) |
| `E_TOKEN_BAD_ALGORITHM` | Server-side algorithm not in `CMS_OIDC_ALGORITHMS` allow-list | `E_TOKEN_MALFORMED` (401) |
| `E_OIDC_JWKS_UNAVAILABLE` | JWKS fetch fails or is unreachable | `E_INTERNAL` (500) |

The server-side union is **never** emitted over the API surface; the API surface always normalizes transient OIDC failures into the appropriate API HTTP status. The API-side codes are the only ones the caller ever sees. Operator diagnostics (incident-channel paste) use the server-side codes because they carry issuer, audience, and algorithm context that the API response intentionally withholds.

## Proposal lifecycle touchpoints

The eight endpoints cover the entire state machine on the API side:

| Beat | API endpoint | Resulting proposal state |
| --- | --- | --- |
| Propose | `POST /v1/proposals` | `proposed` |
| Read | `GET /v1/proposals/{id}` | unchanged |
| Approve | `POST /v1/proposals/{id}/approve` | `approved` |
| Publish | `POST /v1/proposals/{id}/publish` | `canonical_written` |
| Rollback | `POST /v1/proposals/{id}/rollback` | `rolled_back` |
| Deploy receipt | `POST /v1/publications/{id}/deploy-receipts` | pending → `propagating`; succeeded → `live`; failed → `canonical_written` or `deploy_failed` depending on the pre-receipt state |
| Reconcile | `POST /v1/proposals/{id}/reconcile` | `reconciled` (or `reconcile_pending`) |

`canonical_written` and `live` are distinct beats. Publish performs the canonical write; deploy receipts report asynchronous propagation. A governed rollback performs a compensating canonical write and records the proposal terminal as `rolled_back`; it never fabricates a `live` result.

The `Proposal.state` schema enumerates the 16 persisted states the API actually emits: `draft`, `proposed`, `validated`, `previewing`, `approved`, `applying`, `canonical_written`, `propagating`, `live`, `reconciled`, `apply_failed`, `deploy_pending`, `deploy_failed`, `reconcile_pending`, `rolled_back`, and `refused`.

## Authorization filters

The API rejects service and MCP identities before the policy engine runs on the three human-required actions (`approve`, `publish`, `rollback`). The corresponding codes are `E_SERVICE_APPROVAL_FORBIDDEN` and `E_MCP_APPROVAL_FORBIDDEN`. The `Deploy receipts` endpoint requires `identity.id === adapterId` and the narrowly scoped provisional `deploy.receipt` capability; it is **not** an approve, publish, apply, or rollback authority. The `Reconcile` endpoint requires a current human identity; per-publication ownership is an explicit integration blocker (the storage schema must grow a `publication_owner_actor_id` column and a corresponding `IdentityResolver.loadPublicationOwner` hook before per-publication ownership can be enforced).

Self-approval is recorded but not categorically refused: when the proposer actor id equals the clicking actor id, `selfApproved: true` is stamped on the response and the policy engine decides whether the same human is allowed to perform the second transition.

## Discovery sweep

The parity lint in `docs/README.md` scans `packages/api/src/index.ts` for the registered routes and asserts that the eight endpoints above are the only routes. The lint also scans `packages/api/src/openapi.ts` for the exported `openApiDocument` and asserts that:

1. Every path in `openApiDocument` matches a registered route in `index.ts`.
2. Every registered route in `index.ts` is documented in `openApiDocument`.
3. The `openapi.json` file in this directory deep-equals the source on every change.

Adding a new endpoint is a contract change: the route, the OpenAPI definition, the operation contract, and the EN/ES peer docs must all ship in the same pull request.
