# Error code catalog

> **Audience:** integrators and operators who need a stable, exhaustive
> list of the closed machine-readable error code unions shipped across
> every `@cms/*` package. This page is information-oriented
> (Diátaxis reference). The runtime arrays are the source of truth;
> the unions below are mirrored from
> `packages/**/src/**/*.ts` and verified by the discovery-sweep parity
> lint described in [`docs/README.md`](../README.md).

> [Versión en español](error-codes.es.md) · English and Spanish are
> peer locales. Both siblings ship in the same pull request (zero-lag
> rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## How to read this page

The CMS exposes exactly **twelve** closed error-code unions plus the
derived `ProblemCode` aggregator. Every union is a `readonly` array
literal paired with a literal-union type alias of the form
`(typeof UNION)[number]`. The runtime arrays are frozen with
`Object.freeze`; nothing extends them at runtime. Adding a code to
any union is a contract change: both `en` and `es` peer locales ship
in the same pull request, and the discovery-sweep parity lint
re-runs over `packages/**/src/**/*.ts` to confirm membership.

The unions group by **package boundary**, not by HTTP status, because
each package owns its own error vocabulary. Two unions may surface the
same literal string when the same condition lives in two packages; the
catalog records that overlap explicitly so callers can disambiguate
with `problemCodeScope`.

| # | Union | Package | Source symbol | Count |
| --- | --- | --- | --- | --- |
| 1 | Core | `@cms/core` | `ERROR_CODES` | 27 |
| 2 | Storage | `@cms/storage` | `StorageErrorCode` | 13 |
| 3 | API | `@cms/api` | `API_ERROR_CODES` | 20 |
| 4 | CLI | `@cms/cli` | `CliErrorCode` | 8 |
| 5 | Web store | `@cms/web` | `STORE_ERROR_CODES` | 21 |
| 6 | Media blob store | `@cms/media` | `BLOB_STORE_ERROR_CODES` | 9 |
| 7 | Media pipeline | `@cms/media` | `MEDIA_PIPELINE_ERROR_CODES` | 18 |
| 8 | Server runtime | `@cms/server` | `SERVER_ERROR_CODES` | 5 |
| 9 | Server config | `@cms/server` | `SERVER_CONFIG_ERROR_CODES` | 5 |
| 10 | Server auth | `@cms/server` | `SERVER_AUTH_ERROR_CODES` | 9 |
| 11 | Adapter SDK | `@cms/adapter-sdk` | `ADAPTER_REFUSAL_CODES` | 9 |
| 12 | Cerafica symlink | `@cms/adapter-cerafica` | `SYMLINK_REFUSAL_CODES` | 7 |
| — | Aggregator | `@cms/api` | `ProblemCode` | 60 |

Total closed-union members: 151. The aggregator row is **derived**,
not a thirteenth union: `ProblemCode` is the union of the Core,
Storage, and API unions only.

## 1. Core — `ERROR_CODES` (27)

Source: `packages/core/src/domain.ts:86-114`.

| Code | Group |
| --- | --- |
| `E_BAD_TIMESTAMP` | Inputs |
| `E_BAD_HASH` | Inputs |
| `E_BAD_LOCALE` | Inputs |
| `E_BAD_PATH` | Paths |
| `E_ABSOLUTE_PATH` | Paths |
| `E_ESCAPING_PATH` | Paths |
| `E_SELF_ALIAS` | Aliases |
| `E_CYCLIC_ALIAS` | Aliases |
| `E_AMBIGUOUS_CANONICAL` | Aliases |
| `E_BAD_REGENERATION_MODE` | Aliases |
| `E_EMPTY_DERIVED_ARTIFACTS` | Aliases |
| `E_INVALID_IDENTITY` | Identities |
| `E_SERVICE_APPROVAL_FORBIDDEN` | Authority |
| `E_MCP_APPROVAL_FORBIDDEN` | Authority |
| `E_SELF_APPROVAL_FORBIDDEN` | Authority |
| `E_INSUFFICIENT_AUTHORITY` | Authority |
| `E_FIELD_CAPABILITY_MISSING` | Authority |
| `E_ROLE_MISMATCH` | Authority |
| `E_CONTENT_TYPE_MISMATCH` | Authority |
| `E_ENVIRONMENT_MISMATCH` | Authority |
| `E_ACTION_FORBIDDEN` | Authority |
| `E_INVALID_TRANSITION` | State machine |
| `E_ROLLBACK_WINDOW_EXPIRED` | State machine |
| `E_FROZEN_VIOLATION` | State machine |
| `E_MISSING_LOCALE` | i18n |
| `E_INVALID_PROPOSAL` | Proposals |
| `E_INVALID_REVISION` | Proposals |

## 2. Storage — `StorageErrorCode` (13)

Source: `packages/storage/src/index.ts:333-346`. Localize via
`@cms/i18n`; never match the human-readable `message` string.

| Code |
| --- |
| `not_found` |
| `tenant_disabled` |
| `idempotency_replay_mismatch` |
| `idempotency_in_progress` |
| `optimistic_concurrency_conflict` |
| `unique_violation` |
| `foreign_key_violation` |
| `check_violation` |
| `append_only_violation` |
| `invalid_input` |
| `transaction_aborted` |
| `connection_failed` |
| `unsupported` |

## 3. API — `API_ERROR_CODES` (20)

Source: `packages/api/src/problem.ts:38-59`.

| Code |
| --- |
| `E_BAD_REQUEST` |
| `E_UNSUPPORTED_MEDIA_TYPE` |
| `E_PAYLOAD_TOO_LARGE` |
| `E_IDEMPOTENCY_KEY_REQUIRED` |
| `E_IDEMPOTENCY_KEY_MALFORMED` |
| `E_IDEMPOTENCY_REPLAY_MISMATCH` |
| `E_IDEMPOTENCY_IN_PROGRESS` |
| `E_OPTIMISTIC_CONCURRENCY_CONFLICT` |
| `E_VERSION_HEADER_REQUIRED` |
| `E_UNAUTHORIZED` |
| `E_TOKEN_MISSING` |
| `E_TOKEN_MALFORMED` |
| `E_TOKEN_EXPIRED` |
| `E_TOKEN_AUDIENCE_MISMATCH` |
| `E_SERVICE_APPROVAL_FORBIDDEN` |
| `E_MCP_APPROVAL_FORBIDDEN` |
| `E_DELEGATION_EXPIRED` |
| `E_TENANT_HEADER_REQUIRED` |
| `E_TENANT_FORBIDDEN` |
| `E_INTERNAL` |

## 4. CLI — `CliErrorCode` (8)

Source: `packages/cli/src/index.ts:179-188`.

| Code |
| --- |
| `usage` |
| `credential_forbidden` |
| `network` |
| `problem` |
| `unexpected` |
| `conflict` |
| `not_found` |
| `validation` |

## 5. Web store — `STORE_ERROR_CODES` (21)

Source: `packages/web/src/model.ts:111-133`.

| Code |
| --- |
| `E_BAD_BLOCK_ID` |
| `E_BAD_LOCALE` |
| `E_BAD_INDEX` |
| `E_BAD_CROP` |
| `E_BAD_FOCAL` |
| `E_BAD_BYTES` |
| `E_MISSING_ALT` |
| `E_EMPTY_ALT` |
| `E_MISSING_ALT_LOCALE` |
| `E_SERVICE_APPROVAL_FORBIDDEN` |
| `E_MCP_APPROVAL_FORBIDDEN` |
| `E_NO_PROPOSAL` |
| `E_NOT_PREVIEW_READY` |
| `E_NOT_APPROVED` |
| `E_NOT_LIVE` |
| `E_API_ERROR` |
| `E_INVALID_SNAPSHOT` |
| `E_FROZEN_BLOCK` |
| `E_NOT_REVERSIBLE` |
| `E_NOT_DEPLOY_READY` |
| `E_RECONCILE_FORBIDDEN` |

## 6. Media blob store — `BLOB_STORE_ERROR_CODES` (9)

Source: `packages/media/src/blob-store.ts:244-266`.

| Code |
| --- |
| `E_INVALID_KEY` |
| `E_CROSS_TENANT` |
| `E_NOT_FOUND` |
| `E_TRAVERSAL` |
| `E_SYMLINK_ESCAPE` |
| `E_BYTES_EXCEEDED` |
| `E_NOT_IMPLEMENTED` |
| `E_BACKEND_FAILURE` |
| `E_VIDEO_WRITE_FORBIDDEN` |

## 7. Media pipeline — `MEDIA_PIPELINE_ERROR_CODES` (18)

Source: `packages/media/src/blob-store.ts:1226-1266`.

| Code |
| --- |
| `E_AUTH_REQUIRED` |
| `E_CROSS_TENANT` |
| `E_FILENAME_UNSAFE` |
| `E_MIME_SPOOFED` |
| `E_SIGNATURE_MISMATCH` |
| `E_BYTES_EXCEEDED` |
| `E_DECOMPRESSION_BOMB` |
| `E_MALWARE_DETECTED` |
| `E_MALWARE_SCAN_UNAVAILABLE` |
| `E_ALT_MISSING_PEER_LOCALE` |
| `E_CROP_OUT_OF_BOUNDS` |
| `E_FOCAL_OUT_OF_BOUNDS` |
| `E_ICC_ATTESTATION_MISSING` |
| `E_EXIF_ATTESTATION_MISSING` |
| `E_VIDEO_MUTATION_FORBIDDEN` |
| `E_PROCESSOR_DECODE_FAILED` |
| `E_PROCESSOR_ENCODE_FAILED` |
| `E_INVALID_INPUT` |

## 8. Server runtime — `SERVER_ERROR_CODES` (5)

Source: `packages/server/src/index.ts:127-134`.

| Code |
| --- |
| `E_SERVER_NOT_READY` |
| `E_SERVER_ALREADY_LISTENING` |
| `E_SERVER_QUOTA_BYTES` |
| `E_SERVER_QUOTA_RATE` |
| `E_SERVER_INTERNAL` |

## 9. Server config — `SERVER_CONFIG_ERROR_CODES` (5)

Source: `packages/server/src/config.ts:23-30`.

| Code |
| --- |
| `E_CONFIG_MISSING_REQUIRED` |
| `E_CONFIG_INVALID_TYPE` |
| `E_CONFIG_OUT_OF_RANGE` |
| `E_CONFIG_INVALID_URL` |
| `E_CONFIG_INVALID_LOG_LEVEL` |

## 10. Server auth — `SERVER_AUTH_ERROR_CODES` (9)

Source: `packages/server/src/auth.ts:42-52`. Never embeds the raw
token; `extensions` carries redacted, non-PII diagnostics.

| Code |
| --- |
| `E_TOKEN_MISSING` |
| `E_TOKEN_MALFORMED` |
| `E_TOKEN_BAD_SIGNATURE` |
| `E_TOKEN_BAD_AUDIENCE` |
| `E_TOKEN_BAD_ISSUER` |
| `E_TOKEN_EXPIRED` |
| `E_TOKEN_NOT_YET_VALID` |
| `E_TOKEN_BAD_ALGORITHM` |
| `E_OIDC_JWKS_UNAVAILABLE` |

## 11. Adapter SDK — `ADAPTER_REFUSAL_CODES` (9)

Source: `packages/adapter-sdk/src/index.ts:481-491`. Callers
pattern-match on `code`; `message` is for humans only.

| Code |
| --- |
| `E_AMBIGUOUS_BINDING` |
| `E_DERIVED_WRITE_FORBIDDEN` |
| `E_ALIAS_WRITE_FORBIDDEN` |
| `E_UNSUPPORTED_CAPABILITY` |
| `E_CONTRACT_VERSION_MISMATCH` |
| `E_PROVISIONAL_OUT_OF_SCOPE` |
| `E_AUTHORITY_FORBIDDEN` |
| `E_BINDING_NOT_FOUND` |
| `E_ENVIRONMENT_MISMATCH` |

## 12. Cerafica symlink — `SYMLINK_REFUSAL_CODES` (7)

Source: `packages/adapter-cerafica/src/symlink.ts:50-58`.

| Code |
| --- |
| `E_ALIAS_MISSING` |
| `E_ALIAS_BROKEN` |
| `E_ALIAS_NOT_SYMLINK` |
| `E_ALIAS_RETARGETED` |
| `E_ALIAS_ESCAPING` |
| `E_ALIAS_LOOPED` |
| `E_CANONICAL_MISSING` |

## Derived `ProblemCode` aggregator

`ProblemCode` is not a thirteenth union. It is the type-level
aggregator that the `@cms/api` problem emitter uses to constrain the
machine code on every RFC 9457 response body.

Source: `packages/api/src/problem.ts:68-69`.

```ts
export type ProblemCode = CoreErrorCode | StorageErrorCode | ApiErrorCode;
export type ProblemCodeScope = 'core' | 'storage' | 'api';
```

Membership: 27 (core) + 13 (storage) + 20 (api) = **60 literals**.
The aggregator does not include the CLI, web store, media, server,
or adapter unions because those packages are downstream clients or
alternate surfaces of the same authoritative API; they translate
their own codes into the aggregator through `problemFromError`
(`packages/api/src/problem.ts:384-419`).

## Overlap and deduplication

The discovery-sweep parity lint scans
`packages/**/src/**/*.ts` for exported `*_ERROR_CODES` /
`*_REFUSAL_CODES` runtime arrays and `*ErrorCode` / `*RefusalCode`
type aliases. It dedupes by literal string and asserts that every
discovered closed union is documented above.

Two literals appear in more than one union:

| Literal | Unions | Resolution |
| --- | --- | --- |
| `E_SERVICE_APPROVAL_FORBIDDEN` | Core (1), API (3) | `problemCodeScope` returns `'core'` first; the API union re-declares it for HTTP-status mapping. |
| `E_MCP_APPROVAL_FORBIDDEN` | Core (1), API (3) | Same precedence rule as above. |

`problemCodeScope` (`packages/api/src/problem.ts:88-92`) resolves
the scope by checking the core set first, then the storage set, then
falling back to `'api'`. The API union duplicates the two authority
codes so that the HTTP status table (`STATUS_FOR_API`,
`packages/api/src/problem.ts:323-344`) can map them to 403 without
shadowing the core catalogue. The literal string is identical; the
two declarations are dedupes for catalog-routing reasons only.

This table scopes the duplicate authority literals that affect
`problemCodeScope`; the source-derived parity check remains authoritative for
the complete cross-union membership and fails when the documented snapshot drifts.

## Audit has no stable error code union

`@cms/audit` ships `HostResultStatus` (`'committed' | 'skipped' | 'failed'`,
`packages/audit/src/index.ts:69`) for adapter-reported deploy
verdicts, but it does **not** export a closed error code union.
Audit does not raise recoverable errors at runtime; every audit
envelope is either written or its write attempt failed at the
transport layer, and the failure is reported through the same
`StorageError` / `ApiErrorCode` machinery as any other storage or
API failure. The JWS verifier (`packages/audit/src/jws.ts`) and the
canonical envelope (`packages/audit/src/canonical.ts`) carry no
error vocabulary of their own — they accept or reject the entire
envelope, and the rejection path returns `false` rather than a
machine code.

If a future audit feature needs a stable code, it must add a
thirteenth union, document it here, and ship the `en`/`es` peer pair
in the same pull request.

## How the catalog stays in sync

The discovery-sweep parity lint described in
[`docs/README.md`](../README.md) enforces three properties:

1. Every exported closed union listed above is present in this page.
2. Every membership literal here deep-equals the runtime array.
3. No exported closed union exists outside this catalog.

A change to any source array is a documentation change; this page
updates in the same PR. The catalog never carries invented codes,
fabricated descriptions, or codes lifted from a different package's
vocabulary. If a code is missing from this page, the source array
is incomplete, not the documentation.
