# Configure Handoff CMS

> [Versión en español](configure.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

This page documents every `CMS_*` environment variable consumed by `@cms/server`. It is the authoritative companion to [`self-host.md`](self-host.md) · [`.es`](self-host.es.md): the bring-up page tells you how to stand the stack up; this page tells you what each value means and how the server validates it. Every row below is grounded in `compose.yaml` (interpolation defaults), `Dockerfile` (image-level defaults), `.env.example` (placeholder inventory), and `loadServerConfig` at [`packages/server/src/config.ts`](../../packages/server/src/config.ts) (parsing rules). The closed failure-code union is [`SERVER_CONFIG_ERROR_CODES`](../../packages/server/src/config.ts#L22-L30).

The page also documents the operator-vs-self-hoster distinction: which variables the agency operator manages through Compose, and which the self-hoster additionally owns in `.env`. Nothing on this page has been live-tested against a Docker daemon; see [What was verified](#what-was-verified).

## Audience boundary

- The **agency operator** runs the managed compose stack. They own `.env` (the placeholder secret inventory), the published bind host/port, and the OIDC issuer configuration. Day-2 operations are documented in [`operate.md`](operate.md).
- The **self-hoster** runs the full `compose.yaml` stack on a host they own. They additionally own reverse-proxy termination, TLS, volume backup, and the posture documented in [`../security/hardening.md`](../security/hardening.md).
- The **author** never touches any value on this page; their surface is OIDC-authenticated content editing covered by [`authoring.md`](authoring.md).

The matrix below names the audience for each variable with the tag **[operator]** (managed via `.env`), **[compose]** (Compose default applies), or **[image]** (baked into the runtime image; Compose can override).

## SERVER_CONFIG_ERROR_CODES

The server is fail-closed. `loadServerConfig` throws a `ServerConfigError` carrying one of the closed union of stable codes:

```ts
export const SERVER_CONFIG_ERROR_CODES = [
  'E_CONFIG_MISSING_REQUIRED',
  'E_CONFIG_INVALID_TYPE',
  'E_CONFIG_OUT_OF_RANGE',
  'E_CONFIG_INVALID_URL',
  'E_CONFIG_INVALID_LOG_LEVEL',
] as const;
```

The set is frozen at module load. Compose catches missing required values earlier via `${VAR:?message}` substitution; the server catches malformed values, out-of-range integers, invalid URLs, invalid log levels, and invalid `CMS_OIDC_ALGORITHMS` lists. Every thrown error carries a `details` bag with the offending variable name; secret values are never embedded. The diagnostic helper `describeServerConfig` redacts application object-store credentials and the database URL password before any operator logging ([`config.ts:429-456`](../../packages/server/src/config.ts#L429-L456)).

## Complete CMS_* matrix

The matrix below covers every `CMS_*` value consumed by the runtime. Variable names match the source verbatim; defaults are quoted from `compose.yaml` interpolation and the image-level `ENV` block in `Dockerfile:100-115`. Where the two differ, both are shown and the image default is noted.

### Node and process

| Variable | Type | Default (compose / image) | Required | Audience | Notes |
| --- | --- | --- | --- | --- | --- |
| `CMS_NODE_ENV` | enum: `production` \| `staging` \| `development` \| `test` | `production` / `production` | no | [compose] | Parsed by `parseNodeEnv`. Drives logging and error verbosity. |
| `CMS_HOSTNAME` | hostname string | `0.0.0.0` / `0.0.0.0` | no | [compose] | Bind hostname. `0.0.0.0` is the only documented default; do not narrow it without adjusting the reverse proxy. |
| `CMS_PORT` | integer (1-65535) | `8080` / `8080` | no in Compose; required by the loader | [operator] | Compose injects its default. Direct server launches must set it. The published port must track the bind port; mismatches produce a perma-unhealthy container (`compose.yaml:296-301`). |
| `CMS_BIND_HOST` | hostname string | `127.0.0.1` (.env.example) | no | [operator] | Only present in `.env.example`; consumed by the published-port mapping `${CMS_BIND_HOST:-127.0.0.1}:${CMS_BIND_PORT:-8080}:${CMS_PORT:-8080}`. Not parsed by the server itself. |
| `CMS_BIND_PORT` | integer | `8080` (.env.example) | no | [operator] | Only present in `.env.example`; consumed by the published-port mapping. Not parsed by the server. |
| `PORT` | integer | `${CMS_PORT:-8080}` (compose injection) | no | [compose] | Exported from `CMS_PORT` so the healthcheck probe target and the listening port cannot silently diverge. |

### Public URL

| Variable | Type | Default | Required | Audience | Notes |
| --- | --- | --- | --- | --- | --- |
| `CMS_PUBLIC_URL` | URL | none / none | **yes** | [operator] | Parsed by `parseUrl`. Used to construct absolute URLs the host exposes to authors and OIDC flows. |

### Database

| Variable | Type | Default | Required | Audience | Notes |
| --- | --- | --- | --- | --- | --- |
| `CMS_DATABASE_URL` | URL with embedded credentials | none | **yes** | [operator] | Parsed by `requireString`. Embedded password must match `CMS_POSTGRES_PASSWORD`. Redacted in `describeServerConfig`. |
| `CMS_POSTGRES_DB` | string | `cms` (.env.example / compose) | no | [operator] | Consumed by the `postgres` service as `POSTGRES_DB`. |
| `CMS_POSTGRES_USER` | string | `cms` (.env.example / compose) | no | [operator] | Consumed by the `postgres` service as `POSTGRES_USER` and by the healthcheck. |
| `CMS_POSTGRES_PASSWORD` | string | none | **yes** | [operator] | Consumed by the `postgres` service as `POSTGRES_PASSWORD`. Compose refuses to start without it (`compose.yaml:75`). Distinct from `CMS_MINIO_ROOT_PASSWORD`. |
| `CMS_POSTGRES_INITDB_ARGS` | string | `--encoding=UTF-8 --locale=C` | no | [operator] | Forwarded to `postgres` as `POSTGRES_INITDB_ARGS`. |

### OIDC

The OIDC block is documented in [`packages/server/src/config.ts#L82-L102`](../../packages/server/src/config.ts#L82-L102). The host runs an OIDC issuer (Keycloak, Authentik, Cognito, etc.) and publishes a JWKS endpoint. Symmetric (`HS*`) and `none` algorithms are refused by the verifier.

| Variable | Type | Default (compose / image) | Required | Audience | Notes |
| --- | --- | --- | --- | --- | --- |
| `CMS_OIDC_ISSUER` | URL | none / none | **yes** | [operator] | Parsed by `requireString`. The expected `iss` claim. |
| `CMS_OIDC_AUDIENCE` | string | none / none | **yes** | [operator] | Parsed by `requireString`. The expected `aud` claim. |
| `CMS_OIDC_JWKS_URL` | URL | none / none | **yes** | [operator] | Parsed by `parseUrl`. Where the verifier fetches keys. |
| `CMS_OIDC_ALGORITHMS` | comma-separated list | `RS256,ES256` / `RS256,ES256` | no | [operator] | Parsed by `parseAlgorithms`. The allowed list is `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512`, `PS256`, `PS384`, `PS512`; anything else produces `E_CONFIG_INVALID_TYPE`. |
| `CMS_OIDC_JWKS_CACHE_SECONDS` | positive integer | `300` / `300` | no | [operator] | Parsed by `parsePositiveInt`. Bounded JWKS cache lifetime. |
| `CMS_OIDC_FETCH_TIMEOUT_MS` | positive integer | `5000` / `5000` | no | [operator] | Parsed by `parsePositiveInt`. Bounded fetch timeout for JWKS / discovery. |

### Object store (S3-compatible)

The object store block is documented in [`packages/server/src/config.ts#L68-L80`](../../packages/server/src/config.ts#L68-L80). `MINIO_BROWSER=off` and the bucket-scoped application user are set by `minio-init`; the application never sees the root credentials.

| Variable | Type | Default (compose / image) | Required | Audience | Notes |
| --- | --- | --- | --- | --- | --- |
| `CMS_OBJECT_ENDPOINT` | URL | `http://minio:9000` / none | no | [operator] | Parsed by `parseUrl`. The S3-compatible endpoint the application talks to. |
| `CMS_OBJECT_BUCKET` | string | `cms-content` (.env.example / compose) | **yes** | [operator] | Parsed by `requireString`. The private bucket the application reads and writes. |
| `CMS_OBJECT_ACCESS_KEY_ID` | string | none | **yes** | [operator] | Parsed by `requireString`. Bucket-scoped application user created by `minio-init`. |
| `CMS_OBJECT_SECRET_ACCESS_KEY` | string | none | **yes** | [operator] | Parsed by `requireString`. Distinct from `CMS_MINIO_ROOT_PASSWORD`. Redacted in `describeServerConfig`. |
| `CMS_OBJECT_REGION` | string | `us-east-1` / `us-east-1` | no | [operator] | S3 region label. |
| `CMS_OBJECT_FORCE_PATH_STYLE` | boolean | `true` / `true` | no | [operator] | Parsed by `parseBool`. Self-host requires path-style addressing. |
| `CMS_MINIO_ROOT_USER` | string | `cms-root` (.env.example / compose) | **yes** (compose) | [operator] | Consumed by `minio` (`MINIO_ROOT_USER`) and `minio-init`. Never reaches the application. |
| `CMS_MINIO_ROOT_PASSWORD` | string | none | **yes** | [operator] | Consumed by `minio` (`MINIO_ROOT_PASSWORD`) and `minio-init`. Compose refuses to start without it (`compose.yaml:155`). Never reaches the application. |

### Quotas

Quotas are documented in [`packages/server/src/config.ts#L57-L66`](../../packages/server/src/config.ts#L57-L66). They are the operator's contract with their users; the server never silently relaxes them. A request exceeding `requestBytesCap` returns 413; a tenant exceeding `tenantRequestsPerMinute` returns 429.

| Variable | Type | Default (compose / image) | Required | Audience | Notes |
| --- | --- | --- | --- | --- | --- |
| `CMS_QUOTA_REQUEST_BYTES_CAP` | positive integer | `1048576` / `1048576` | no | [operator] | Parsed by `parsePositiveInt`. 1 MiB by default. |
| `CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE` | positive integer | `120` / `120` | no | [operator] | Parsed by `parsePositiveInt`. Per-tenant request rate cap. |

### Logging and locale

| Variable | Type | Default (compose / image) | Required | Audience | Notes |
| --- | --- | --- | --- | --- | --- |
| `CMS_LOG_LEVEL` | enum: `silent` \| `error` \| `warn` \| `info` \| `debug` | `info` / `info` | no | [operator] | Parsed by `parseLogLevel`. Invalid values produce `E_CONFIG_INVALID_LOG_LEVEL`. |
| `CMS_DEFAULT_LOCALE` | locale string | `en` / `en` | no | [operator] | Parsed by `parseLocale`. English and Spanish are the peer locales; this default drives the authoring surface when no explicit locale is selected. |

## Parsing rules, by code path

Each parser in `loadServerConfig` corresponds to a `ServerConfigError` code. The mapping below is grounded in `config.ts` and is the authoritative reference for what each code means:

| Code | Where it is thrown | What it indicates |
| --- | --- | --- |
| `E_CONFIG_MISSING_REQUIRED` | `requireString` | A required `CMS_*` value is unset or whitespace-only. Compose should have caught this at `${VAR:?message}` substitution; this code only fires when running outside Compose. |
| `E_CONFIG_INVALID_TYPE` | `parsePort`, `parseNonNegativeInt`, `parseAlgorithms`, `parseLocale`, `parseNodeEnv`, `parseBool` | A value has invalid syntax or is outside an accepted literal set. Examples include a port outside 1-65535, a negative integer, or a `CMS_OIDC_ALGORITHMS` entry outside the nine allowed asymmetric algorithms. |
| `E_CONFIG_OUT_OF_RANGE` | `parsePositiveInt` | A parsed integer is zero where the value must be greater than zero, including quota and timeout values. |
| `E_CONFIG_INVALID_URL` | `parseUrl` | A URL value does not parse, has an unsupported scheme, or violates another URL invariant. |
| `E_CONFIG_INVALID_LOG_LEVEL` | `parseLogLevel` | `CMS_LOG_LEVEL` is not one of `silent`, `error`, `warn`, `info`, `debug`. |

The thrown `ServerConfigError` carries a `details` bag with the variable name and a redacted human-readable message. Secret values never appear in the message.

## .env.example as the placeholder inventory

`.env.example` at the repository root is the authoritative placeholder inventory. The literal placeholder strings are part of the contract; replacing them is the operator's first act:

```text
CMS_POSTGRES_PASSWORD=replace-with-a-strong-database-password
CMS_MINIO_ROOT_PASSWORD=replace-with-a-strong-minio-root-password
CMS_OBJECT_SECRET_ACCESS_KEY=replace-with-a-distinct-strong-application-secret
```

The three placeholders are **distinct on purpose**. Reusing any of them across categories is rejected by the security boundary even though Compose's substitution grammar would permit it:

- `CMS_POSTGRES_PASSWORD` authenticates the `cms` role against `postgres:5432`.
- `CMS_MINIO_ROOT_PASSWORD` authenticates the `cms-root` MinIO administrator; it never reaches the application.
- `CMS_OBJECT_SECRET_ACCESS_KEY` authenticates the bucket-scoped application user that `minio-init` creates with the `cms-app` policy.

`CMS_DATABASE_URL` embeds `CMS_POSTGRES_PASSWORD`; when you rotate either, rotate both together so the embedded password and the standalone variable stay in sync.

## What was verified

This page is grounded in the source files named above. The only Docker-related command V1 actually ran is interpolation-only and does not require a running daemon:

```sh
docker compose -f compose.yaml config --quiet
```

That command validates the substitution map. It does not build the image, start the daemon, or exercise any container. The V1 verification report at `artifacts/g008/workspace-test-report.json` records this explicitly in its limitations ledger. A live Docker daemon-backed build or runtime is **not** part of V1 and is not a claim on this page.

## Where to go next

- Bring the stack up: [`self-host.md`](self-host.md) · [`.es`](self-host.es.md).
- Seven-command workspace verification (operator surface): [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).
- The hosting-stack architecture: [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md).
- The closed `SERVER_CONFIG_ERROR_CODES` source: [`packages/server/src/config.ts:22-30`](../../packages/server/src/config.ts#L22-L30).
- The verification report: `artifacts/g008/workspace-test-report.json`.