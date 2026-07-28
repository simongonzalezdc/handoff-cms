# Observability

> **Audience:** operators, integrators, and security reviewers. This page
> is the closed reference for the observability surface exposed by
> `@cms/server` and the `@cms/api` Hono app: the unauthenticated
> `/v1/health` liveness probe on the authority surface, the operator-only
> `/health/live` and `/health/ready` probes on the self-hosted server,
> the Prometheus-format `/metrics` endpoint, and the PII-free JSON
> log stream. It mirrors the runtime contract in
> `packages/server/src/index.ts` and `packages/api/src/index.ts`; the
> audit envelope (signed, content-addressable, offline-verifiable) is
> documented at the companion page
> [`docs/reference/audit-envelope.md`](audit-envelope.md) ·
> [`.es`](audit-envelope.es.md).

> [Versión en español](observability.es.md) · English and Spanish are
> peer locales. Both siblings ship in the same pull request (zero-lag
> rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## Surface map

There are exactly five observability surfaces. The table below names
the route, the package that owns it, and the intended consumer.

| Route | Owner | Consumer |
| --- | --- | --- |
| `GET /v1/health` | `@cms/api` | Liveness probe; the only authority-surface route that bypasses `requestContextMiddleware` (no `Authorization` header, no `X-Tenant-Id` header). |
| `GET /health/live` | `@cms/server` | Operator-managed liveness probe; always returns `200` when the Node process is alive. |
| `GET /health/ready` | `@cms/server` | Operator-managed readiness probe; returns `200` with `status: "ready"` only when every dependency check is `ok`, `503` with `status: "degraded"` otherwise. |
| `GET /metrics` | `@cms/server` | Operator-managed Prometheus text exposition (`text/plain; version=0.0.4`); exactly eight metric names. |
| Stderr JSON log stream | `@cms/server` | Operator log shipper; structured JSON, PII-free by construction. |

The two `/health/*` routes and `/metrics` are registered on the server
Hono app **before** the API mount (`app.route('/', apiApp)`), so they
short-circuit before the API's tenant + bearer middleware runs.

Source: `packages/server/src/index.ts:404-426`,
`packages/api/src/index.ts:88-96`, `packages/api/src/index.ts:145-155`.

## Health contracts

### `GET /v1/health` — API liveness

The response is `200` with a frozen body of shape:

```json
{ "status": "ok", "service": "@cms/api", "locale": "en" }
```

`locale` is `"en"` or `"es"`. An omitted `Accept-Language` header uses the documented protocol default `en`. A non-empty header with no supported peer is rejected with `E_BAD_LOCALE`; it is never silently converted to English. The endpoint carries `security: []`, so clients do not send a bearer token.

`status` is the closed string `"ok"`. There is no `"degraded"` value
on this route: a degraded host returns `200` from the API process
regardless of database, object-store, or OIDC state.

Source: `packages/api/src/index.ts:145-155`,
`packages/api/src/openapi.ts:437-457`.

### `GET /health/live` — server liveness

The response is always `200` when the Node process answers HTTP:

```json
{
  "status": "alive",
  "service": "@cms/server",
  "version": "0.1.0",
  "timestamp": "<ISO-8601 UTC>"
}
```

`version` is the literal `0.1.0` from
`packages/server/src/index.ts:410`. The endpoint is not authenticated
and is intended for an operator-load balancer or kubelet liveness probe.

Source: `packages/server/src/index.ts:405-415`.

### `GET /health/ready` — server readiness

The response is `200` when every dependency check is `ok`, and `503`
when any check is not:

```ts
export interface ReadinessReport {
  readonly status: 'ready' | 'degraded';
  readonly checks: Readonly<{
    readonly database: ReadinessCheck;
    readonly objectStore: ReadinessCheck;
    readonly oidc: ReadinessCheck;
  }>;
}

export interface ReadinessCheck {
  readonly ok: boolean;
  readonly detail: string;
}
```

There are exactly three readiness dependencies. They run in parallel
under `Promise.all`. The endpoint is unauthenticated by design (an
operator probe must not require a tenant header or bearer token), but
it is still operator-managed and bound to the trusted network.

| Check | What it does | `ok: true` when | `ok: false` when |
| --- | --- | --- | --- |
| `database` | `storage.getTenantById('00000000-0000-0000-0000-000000000000')` round-trips a SELECT | Postgres returns the row | The call throws (`transaction_aborted` StorageError or any other failure); detail is the literal `database unavailable` |
| `objectStore` | `HEAD <endpoint>/<bucket>` against the configured S3-compatible endpoint with an `AbortSignal.timeout` from `config.oidc.fetchTimeoutMs` | The endpoint returns 2xx or 403 (expected from a public bucket probe) | Any non-2xx/403 response (detail includes the status code) or any network throw (detail is `object store unavailable`) |
| `oidc` | `GET config.oidc.jwksUrl` with the same timeout, parsed for `Array.isArray(body.keys)` | The JWKS document is reachable and structurally valid | Any non-2xx response (detail includes the status code), JSON parse failure, or network throw (detail is `OIDC JWKS unavailable`) |

When the readiness probe returns `degraded`, the
`cms_server_readiness_failures_total` counter increments by 1. The
boot path runs the readiness probe at startup, logs only
(`event: readiness.boot`), and does **not** block boot on transient
backend outages.

Source: `packages/server/src/index.ts:82-94`,
`packages/server/src/index.ts:383-401`,
`packages/server/src/index.ts:834-885`,
`packages/server/src/index.ts:928-942`.

## Metrics — exactly eight names

The `/metrics` endpoint returns Prometheus text exposition. There are
exactly eight metric names. The render path is
`metricsToText(state)` in `packages/server/src/index.ts:253-282`; that
function is the single source of truth for the metric catalog and
should be the only function that changes when a metric is added.

| # | Metric name | Type | Meaning |
| --- | --- | --- | --- |
| 1 | `cms_server_uptime_seconds` | gauge | `(Date.now() - state.startedAtMs) / 1000` |
| 2 | `cms_server_requests_total` | counter | Every handled HTTP request, incremented once on entry to the Node adapter |
| 3 | `cms_server_request_bytes_in_total` | counter | Bytes read from request bodies (post-cap, summed after `readBoundedBody` resolves) |
| 4 | `cms_server_response_bytes_out_total` | counter | Bytes written to response bodies |
| 5 | `cms_server_rate_limited_total` | counter | Requests rejected with `429` by the per-remote-source rate limit |
| 6 | `cms_server_oversized_total` | counter | Requests rejected with `413` by the body-size cap |
| 7 | `cms_server_readiness_failures_total` | counter | Readiness probes that returned `degraded` (any check `ok: false`) |
| 8 | `cms_server_requests_by_status_total{status="<code>"}` | counter | One counter series per HTTP status code, labelled by status |

The labelled `cms_server_requests_by_status_total` series uses a
single `status` label; no other label dimension is exposed. There is
no `tenant_id`, `actor_id`, `route`, `method`, or `locale` label —
adding one would risk log-shaped cardinality and is forbidden by the
closed metric catalog.

The metrics state (`MetricsState` in
`packages/server/src/index.ts:229-251`) is the single in-memory
authoritative store. All mutations go through
`metricsStateInc` / `metricsStateAdd` /
`metricsStateIncStatus`. Direct field mutation outside those helpers
is forbidden by convention; the closure keeps the eight counters and
the status map consistent.

## Logs — PII-free structured JSON

The server emits one log record per `logger.log(level, event)` call to
`process.stderr` as a single line of JSON terminated with `\n`. The
record always carries `level`, `event`, `timestamp` (ISO-8601 UTC),
`host`, `service` (`@cms/server`), and `version` (`0.1.0`). Per-call
records add fields drawn from the `ServerLogEvent` interface
(`packages/server/src/index.ts:107-120`).

There is no PII in the record set. The redaction discipline is built
into the Node adapter, the config loader, and the logger itself:

- **Request headers are sanitized before they reach the API.** The
  `sanitizeHeaders` helper at
  `packages/server/src/index.ts:676-692` drops the `cookie` and
  `proxy-authorization` headers; `cookie` would carry session state,
  and `proxy-authorization` is treated as opaque.
- **Bodies are not logged.** The only body-shaped field a caller can
  attach is `bytes`, which is the declared `content-length` for an
  oversize rejection; the contents of the body are never serialized.
- **`describeServerConfig` redacts secret values.** It replaces the database URL username, password, and path with `***`, removes the query string, and replaces `objectStore.accessKeyId` / `secretAccessKey` with `***`. The credentialed URL is reconstructed only for live Drizzle and S3 clients, never for a log.
- **Bearer tokens never appear.** The token verifier runs inside the
  API and returns the verified identity; the Node adapter never
  reads `authorization` for logging.
- **Health probe history is not retained.** The `/v1/health` body
  (`{ status, service, locale }`) and the `/health/ready` body
  (`ReadinessReport`) are the only payloads on those routes and
  carry no per-call metadata.

Log levels are `silent`, `debug`, `info`, `warn`, `error`, in that
priority order. The level gate is `isLoggable(level, threshold)` at
`packages/server/src/index.ts:159-161`; `silent` short-circuits before
the gate.

The shape of an `event` value is closed by `ServerLogEvent`. The
expected event names, in story order, are:

| Event | Level | Notes |
| --- | --- | --- |
| `config.loaded` | `info` | Operator diagnostic (`describeServerConfig`) emitted at boot. |
| `readiness.boot` | `info` or `warn` | Initial readiness result; `info` when ready, `warn` when degraded. The boot path does NOT block on this. |
| `readiness.boot_failed` | `warn` | Initial readiness threw (not "degraded"); carries `detail` only. |
| `server.listening` | `info` | Once the Node listener binds. Carries `port`, `hostname`, `traceId`. |
| `request.completed` | `info` / `warn` / `error` | Every HTTP request. Carries `method`, `path`, `traceId`, `status`, `latencyMs`. |
| `request.oversized` | `warn` | 413 by `content-length` or by `readBoundedBody`. |
| `request.body_read_failed` | `error` | Body read threw for a non-oversize reason. |
| `request.rate_limited` | `warn` | 429 from the per-remote-source limit. |
| `request.unhandled_error` | `error` | `app.fetch` threw. |
| `config.invalid` | `error` | Loader threw a `ServerConfigError`; the process exits non-zero. |
| `server.start_failed` | `error` | Top-level bootstrap threw; the process exits non-zero. |

The audit envelope (signed, content-addressable, offline-verifiable)
is not part of this log stream. Every governance transition is
persisted as a detached Ed25519 JWS envelope through `@cms/audit`,
which is captured in the audit-envelope page
[`docs/reference/audit-envelope.md`](audit-envelope.md) ·
[`.es`](audit-envelope.es.md).

## Probe sequence

The recommended operator probe sequence is:

1. **Liveness** — `GET /health/live`. If this returns non-`200`, the
   Node process is dead and should be restarted by the supervisor.
   The `/v1/health` route can substitute on a public ingress when the
   SRE team prefers the authority-surface health route.
2. **Readiness** — `GET /health/ready`. If this returns `503` with
   `status: "degraded"`, the process is alive but at least one of the
   three dependency checks is failing. Do not restart; investigate
   the `database` / `objectStore` / `oidc` details and route.
3. **Metrics** — `GET /metrics`. Scrape on the operator's standard
   Prometheus interval; the eight counters and the uptime gauge are
   the only series.
4. **Logs** — Pipe `process.stderr` (when running under `node` or
   under `compose up` with `stderr: true`) into the operator log
   shipper. Filter on `event` and on `level`; never ingest bodies or
   headers.

## Failure mode cross-reference

- **Database unavailable.** The `/health/ready` `database` check
  reports `ok: false`, detail `"database unavailable"`, and the
  process stays alive. API calls that touch governance rows return
  `503` problems until the database recovers. No fail-open path
  short-circuits the proxy or serves cached rows as authoritative.
- **Object store unavailable.** The `/health/ready` `objectStore`
  check reports `ok: false`, detail `"object store unavailable"` or
  the status code. Pipeline ingests that require `put` fail closed;
  see [`media-pipeline.md`](media-pipeline.md) ·
  [`.es`](media-pipeline.es.md) for the exact
  `E_INVALID_INPUT` quarantine path.
- **OIDC JWKS unavailable.** The `/health/ready` `oidc` check reports
  `ok: false`, detail `"OIDC JWKS unavailable"` or the status code.
  Bearer-token verification fails closed; the API returns `401`
  problems until the JWKS endpoint is reachable again.

Every failed readiness probe increments
`cms_server_readiness_failures_total` by exactly 1, regardless of how
many of the three checks failed; the metric is gated on the overall
`ok` flag, not per-check.

Source: `packages/server/src/index.ts:383-401`,
`packages/server/src/index.ts:834-885`.

## Evidence

- Server factory and routes — `packages/server/src/index.ts:331-481`
- Liveness probe — `packages/server/src/index.ts:404-415`
- Readiness probe — `packages/server/src/index.ts:416-419`
- Metrics render — `packages/server/src/index.ts:253-282`
- Probe functions — `packages/server/src/index.ts:834-885`
- API health bypass — `packages/api/src/index.ts:88-96`,
  `packages/api/src/index.ts:145-155`
- OpenAPI `/v1/health` — `packages/api/src/openapi.ts:437-457`
- Boot sequence — `packages/server/src/index.ts:891-954`
- Config redaction — `packages/server/src/config.ts:429-472`
- Header sanitization — `packages/server/src/index.ts:676-692`
- Audit envelope (signed, content-addressable, offline-verifiable) —
  [`docs/reference/audit-envelope.md`](audit-envelope.md) ·
  [`.es`](audit-envelope.es.md)
- Media pipeline (fail-closed quarantine, fail-closed
  scanner-unavailable) — [`docs/reference/media-pipeline.md`](media-pipeline.md) ·
  [`.es`](media-pipeline.es.md)
