# Configuration reference

> [Versión en español](configuration.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

The server is **operator-managed**. Every value comes from environment variables prefixed `CMS_`. `loadServerConfig(env)` (exported from `packages/server/src/config.ts`) returns an immutable `ServerConfig` or throws a `ServerConfigError`. The server is **fail-closed**: missing or malformed values produce a startup error, never a silent default. Diagnostic descriptions (`describeServerConfig`) redact secret values so the same error is safe to paste into an incident channel.

There are exactly **21** `CMS_*` environment variables. The matrix below is exhaustive; any future variable must be added here in the same pull request that adds it to `loadServerConfig`. The discovery-sweep parity lint scans `packages/server/src/config.ts` for the literal string `CMS_` and asserts that every variable referenced by the loader is documented.

## Required defaults and validation matrix

| Variable | Required | Default | Parser | Constraint | Failure code |
| --- | --- | --- | --- | --- | --- |
| `CMS_NODE_ENV` | yes | — | `parseNodeEnv` | one of `production`, `staging`, `development`, `test` | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_TYPE` if not in the enum |
| `CMS_PORT` | yes | — | `parsePort` | integer in `[1, 65535]`; rejects leading zeros and non-strict integer strings | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_TYPE` if out of range or non-integer |
| `CMS_HOSTNAME` | no | `0.0.0.0` | `getString` | non-empty after trim | n/a (defaults applied) |
| `CMS_PUBLIC_URL` | yes | — | `parseUrl` | `http://` or `https://`; URL-parseable | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_URL` on parse failure or wrong scheme |
| `CMS_DATABASE_URL` | yes | — | `requireString` | non-empty after trim | `E_CONFIG_MISSING_REQUIRED` if absent |
| `CMS_OIDC_ISSUER` | yes | — | `requireString` | non-empty after trim | `E_CONFIG_MISSING_REQUIRED` if absent |
| `CMS_OIDC_AUDIENCE` | yes | — | `requireString` | non-empty after trim | `E_CONFIG_MISSING_REQUIRED` if absent |
| `CMS_OIDC_JWKS_URL` | yes | — | `parseUrl` | `http://` or `https://`; URL-parseable | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_URL` on parse failure or wrong scheme |
| `CMS_OIDC_JWKS_CACHE_SECONDS` | yes | — | `parsePositiveInt` | strictly positive integer | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_TYPE` if non-integer, `E_CONFIG_OUT_OF_RANGE` if zero |
| `CMS_OIDC_FETCH_TIMEOUT_MS` | yes | — | `parsePositiveInt` | strictly positive integer | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_TYPE` if non-integer, `E_CONFIG_OUT_OF_RANGE` if zero |
| `CMS_OIDC_ALGORITHMS` | yes | — | `parseAlgorithms` | comma-separated list with at least one element, every element in `RS256, RS384, RS512, ES256, ES384, ES512, PS256, PS384, PS512`; duplicates removed; `HS*` and `none` always refused | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_TYPE` if empty or contains a disallowed algorithm |
| `CMS_OBJECT_ENDPOINT` | yes | — | `parseUrl` | `http://` or `https://`; URL-parseable | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_URL` on parse failure or wrong scheme |
| `CMS_OBJECT_BUCKET` | yes | — | `requireString` | non-empty after trim | `E_CONFIG_MISSING_REQUIRED` if absent |
| `CMS_OBJECT_ACCESS_KEY_ID` | yes | — | `requireString` | non-empty after trim | `E_CONFIG_MISSING_REQUIRED` if absent |
| `CMS_OBJECT_SECRET_ACCESS_KEY` | yes | — | `requireString` | non-empty after trim | `E_CONFIG_MISSING_REQUIRED` if absent |
| `CMS_OBJECT_REGION` | no | `us-east-1` | `getString` | non-empty after trim | n/a (defaults applied) |
| `CMS_OBJECT_FORCE_PATH_STYLE` | no | `true` | `parseBool` | one of `true`, `false`, `1`, `0` | `E_CONFIG_INVALID_TYPE` if not parseable as the four tokens |
| `CMS_QUOTA_REQUEST_BYTES_CAP` | yes | — | `parsePositiveInt` | strictly positive integer | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_TYPE` if non-integer, `E_CONFIG_OUT_OF_RANGE` if zero |
| `CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE` | yes | — | `parsePositiveInt` | strictly positive integer | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_TYPE` if non-integer, `E_CONFIG_OUT_OF_RANGE` if zero |
| `CMS_LOG_LEVEL` | yes | — | `parseLogLevel` | one of `silent`, `error`, `warn`, `info`, `debug` | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_LOG_LEVEL` if not in the enum |
| `CMS_DEFAULT_LOCALE` | yes | — | `parseLocale` | `en` or `es` | `E_CONFIG_MISSING_REQUIRED` if absent, `E_CONFIG_INVALID_TYPE` if not in the enum |

Counted totals: **21** variables: **18 required** by the loader and **3 defaulted** (`CMS_HOSTNAME=0.0.0.0`, `CMS_OBJECT_REGION=us-east-1`, `CMS_OBJECT_FORCE_PATH_STYLE=true`). Those defaults come from `Dockerfile` and `compose.yaml`; `.env.example` is an infrastructure/bootstrap template and does not define them. The parser distribution is 1 `parsePort`, 4 `parsePositiveInt`, 3 `parseUrl`, 6 `requireString`, 1 `parseBool`, 3 enum parsers (`parseNodeEnv`, `parseLogLevel`, `parseLocale`), 1 `parseAlgorithms`, and 2 defaulted `getString` calls. The five `SERVER_CONFIG_ERROR_CODES` cover missing required values, invalid types, out-of-range positive integers, malformed URLs, and invalid log levels.

The matrix is exactly the contract: the loader is pure, never reads the network, never parses JSON, and never trusts the environment to shape the server's behavior beyond these typed fields. Adding a new variable is a contract change and ships in the same pull request as the EN/ES peer docs.

## Quota surface

The `quotas` field on the loaded `ServerConfig` is the **only** operator-tunable rate / size contract. It is two strictly positive integers; the server never silently relaxes them and never widens them.

| Field | Source variable | Bound | HTTP response on breach |
| --- | --- | --- | --- |
| `requestBytesCap` | `CMS_QUOTA_REQUEST_BYTES_CAP` | per-request body size in bytes | `E_PAYLOAD_TOO_LARGE` (413) |
| `tenantRequestsPerMinute` | `CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE` | per-tenant request rate | `E_SERVER_QUOTA_RATE` (429) — emitted by the server runtime, not the API problem catalog |

The runtime quota codes (`E_SERVER_QUOTA_BYTES`, `E_SERVER_QUOTA_RATE`) live in the `SERVER_ERROR_CODES` union and are emitted in addition to the API problem quotes. The quota surface is operator-managed: any change to either number is a contract change for the operator’s tenants. The configured `CMS_QUOTA_REQUEST_BYTES_CAP` is the ceiling the API enforces; the body is rejected before the handler runs.

## `SERVER_CONFIG_ERROR_CODES`

The `ServerConfigError` class carries a stable code from the closed union exported from `packages/server/src/config.ts:23-30`. The union contains exactly **5** literals:

| Code | Trigger | Redacted `details` |
| --- | --- | --- |
| `E_CONFIG_MISSING_REQUIRED` | `requireString` or a downstream parser sees the variable absent | `missing: <key>` |
| `E_CONFIG_INVALID_TYPE` | `parsePort`, `parseNonNegativeInt`, `parseBool`, `parseAlgorithms`, `parseLocale`, `parseNodeEnv` reject the value | `invalid: <key>` (plus `rejected: <token>` for `parseAlgorithms`, `parseLocale`, `parseNodeEnv` when applicable) |
| `E_CONFIG_OUT_OF_RANGE` | `parsePositiveInt` sees a zero after a successful integer parse | `invalid: <key>` |
| `E_CONFIG_INVALID_URL` | `parseUrl` cannot construct a URL or the scheme is not `http://` or `https://` | `invalid: <key>` |
| `E_CONFIG_INVALID_LOG_LEVEL` | `parseLogLevel` does not match the closed enum | `invalid: <key>`, `rejected: <raw>` |

The `details` bag is operator-safe: it never embeds the secret value itself, only the key that failed to parse. The error message likewise names the key and the constraint, never the value. This is what `startSelfHostedServer` emits at boot so operators can paste it into an incident channel without leaking credentials. The secret-bearing fields (`CMS_OIDC_*` secrets, `CMS_OBJECT_ACCESS_KEY_ID`, `CMS_OBJECT_SECRET_ACCESS_KEY`, `CMS_DATABASE_URL`) are redacted in `describeServerConfig`: `accessKeyId` and `secretAccessKey` are replaced with `***`, and the database URL is reduced to `<scheme>://***:***@<host>/***` (scheme and host preserved, credentials and path tail removed).

## URL parsing

`parseUrl` is the only URL parser the loader uses. It accepts only `http://` and `https://` schemes. Any other scheme (`file:`, `ftp:`, `data:`, etc.) returns `E_CONFIG_INVALID_URL`. The `pathname`, `search`, and `hash` of the URL are kept verbatim; the loader does not normalize or strip them. The parsed URL is serialized back to a string via `parsed.toString()` so the returned `string` is the canonical form of the input.

Used by three variables: `CMS_PUBLIC_URL`, `CMS_OIDC_JWKS_URL`, `CMS_OBJECT_ENDPOINT`. The OIDC issuer (`CMS_OIDC_ISSUER`) and audience (`CMS_OIDC_AUDIENCE`) are accepted as opaque strings; the runtime issuer-mismatch check happens later in the auth path, not at config load.

## Boolean parsing

`parseBool` accepts exactly four tokens: `true`, `false`, `1`, `0`. Any other value — including `yes`, `on`, `True`, `TRUE`, or empty strings — returns `E_CONFIG_INVALID_TYPE`. The default is applied when the variable is absent (only `CMS_OBJECT_FORCE_PATH_STYLE` uses this path; the default is `true`). Other booleans in the loader are derived from string enums (`CMS_OIDC_ALGORITHMS` allow-list, `CMS_LOG_LEVEL` enum) and never go through `parseBool`.

## Integer parsing

Three integer parsers cover the integer surface:

| Parser | Bounded by | Used by |
| --- | --- | --- |
| `parsePort` | `[1, 65535]`, rejects leading zeros and non-strict integer strings | `CMS_PORT` |
| `parseNonNegativeInt` | `>= 0`, rejects leading zeros and non-strict integer strings | (internal helper) |
| `parsePositiveInt` | `> 0`, delegates to `parseNonNegativeInt` then rejects `0` | `CMS_OIDC_JWKS_CACHE_SECONDS`, `CMS_OIDC_FETCH_TIMEOUT_MS`, `CMS_QUOTA_REQUEST_BYTES_CAP`, `CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE` |

Whitespace around the integer is preserved; the parser trims nothing. `" 100 "` and `"00100"` are rejected because their parsed decimal representation does not equal the raw string; `"100"` is accepted. The strict integer contract is operator-facing: unexpected whitespace or padding is a misconfiguration, not tolerated input.

## Algorithm allow-list

`CMS_OIDC_ALGORITHMS` is the only comma-separated list variable. The tokens are trimmed; empty tokens are dropped. The list must contain at least one element; the empty list returns `E_CONFIG_INVALID_TYPE`. Each token must be a member of `ALLOWED_ALGORITHMS`:

| Family | Members |
| --- | --- |
| RS (RSA) | `RS256`, `RS384`, `RS512` |
| ES (ECDSA) | `ES256`, `ES384`, `ES512` |
| PS (RSA-PSS) | `PS256`, `PS384`, `PS512` |

`HS*` (symmetric) and `none` are **never** accepted. The returned array is deduplicated and frozen as `readonly AllowedAlgorithm[]`. The same array is later enforced by the per-request token verifier: any token whose `alg` header is outside this list returns `E_TOKEN_BAD_ALGORITHM` (server) → `E_TOKEN_MALFORMED` (API).

## Log level and locale enums

`CMS_LOG_LEVEL` accepts exactly `silent`, `error`, `warn`, `info`, `debug`. The empty string is rejected by `requireString` upstream. `CMS_DEFAULT_LOCALE` accepts exactly `en` or `es`. There is no third locale; the API problem catalog declares `PROBLEM_LOCALES = ['en', 'es']` and `CMS_DEFAULT_LOCALE` must align with that set. The `parseLocale` failure mode is `E_CONFIG_INVALID_TYPE`, not `E_CONFIG_INVALID_LOG_LEVEL`, even though both are closed enums.

## Operator diagnostic summary

`describeServerConfig(config)` returns a frozen object safe to paste into an incident channel. The redaction policy is:

| Field | Redacted form |
| --- | --- |
| `accessKeyId` | `***` |
| `secretAccessKey` | `***` |
| `databaseUrl` | scheme + `://***:***@<host>/***` (search and path tail removed) |
| `audit` private key fields | not exposed (the server config does not carry them) |
| All other fields | passed through verbatim |

The diagnostic summary is exactly what `startSelfHostedServer` emits at boot. It is not a substitute for the loaded config; the loader’s immutable `ServerConfig` is the only object the API surface sees.

## Loader purity

`loadServerConfig(env)` is a pure function: it takes an `EnvSource` (a `Readonly<Record<string, string | undefined>>`) and returns either a frozen `ServerConfig` or throws a `ServerConfigError`. It does not perform I/O, does not resolve environment references at runtime, and never throws for “missing optional” values — only for malformed or absent required ones. Operator diagnostics on error never include the secret values themselves; they only mention which key failed to parse. The loader is the only sanctioned entry point for `ServerConfig` in the codebase; no other module may parse `CMS_*` values directly.

## Discovery sweep

The parity lint in `docs/README.md` scans `packages/server/src/config.ts` for the literal `CMS_` and asserts that:

1. Every `CMS_*` token referenced by the loader is documented in the matrix above.
2. Every variable in the matrix is referenced by the loader.
3. Every entry in the `SERVER_CONFIG_ERROR_CODES` union is documented in the table above.
4. The `details` bag keys (`missing`, `invalid`, `rejected`) match the keys the loader actually emits.

Adding a new `CMS_*` variable, a new quota, or a new `SERVER_CONFIG_ERROR_CODES` literal is a contract change and must ship in the same pull request as the EN/ES peer docs.
