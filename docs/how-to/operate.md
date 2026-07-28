# Operate Handoff CMS

> [Versión en español](operate.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

This page is the day-2 operator manual for an already-broken-in self-hosted Handoff CMS stack. It covers the runtime signals (PII-free JSON logs, `/health/live`, `/health/ready`, `/metrics`), the two-store snapshot discipline (Postgres + MinIO), the agency operator vs. self-hoster role split, and the entry point back into the human authority lifecycle. It does not cover initial bring-up — for that, follow [`self-host.md`](self-host.md) · [`.es`](self-host.es.md) and [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md). It does not cover configuration variables — for that, follow [`configure.md`](configure.md) · [`.es`](configure.es.md). Migrations and schema upgrades live on the paired page [`migrate.md`](migrate.md) · [`.es`](migrate.es.md).

This page is grounded in [`packages/server/src/index.ts`](../../packages/server/src/index.ts), [`packages/server/src/config.ts`](../../packages/server/src/config.ts), [`compose.yaml`](../../compose.yaml), and the script [`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs). None of the runtime signals below has been observed against a live Docker daemon; see [What was verified](#what-was-verified) for the exact V1 scope.

## Audience boundary

Handoff CMS distinguishes three operational roles. The day-2 scope of this page belongs to the operator roles; the other audience pages are linked, not duplicated.

- The **agency operator** runs a managed compose stack on behalf of a client. They own `.env`, the published bind host/port, the OIDC issuer configuration, and day-2 operations. The configure + operate pair is their day-1 / day-2 manual.
- The **self-hoster** runs the full `compose.yaml` stack on a host they own. They additionally own reverse-proxy termination, TLS, named-volume snapshot and restore, and hardening. The self-host + operate + migrate triangle is their day-1 / day-2 manual.
- The **author** never touches runtime. They authenticate through the OIDC issuer, edit a draft, preview, and propose for human review. Their surface is OIDC-authenticated content editing covered by [`authoring.md`](authoring.md) · [`.es`](authoring.es.md).

The agency operator and the self-hoster share the same compose stack and the same [`@cms/server`](../../packages/server/src/index.ts) runtime; they differ only in who owns the host beneath the compose file. Roles never blur at runtime: an operator is never an author, and an author is never given a Postgres URL, a MinIO root credential, or the path to the `cms_postgres_data` named volume.

## PII-free structured JSON logs

The server writes one structured JSON record per line on **stderr** — never on stdout, never on a file under the container filesystem, never on the host journal of a remote proxy ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L163-L180)). Every record carries the same envelope so that downstream collectors can ingest, filter, and alert on it without parsing the body. The default envelope is:

- `level` — `silent`, `debug`, `info`, `warn`, or `error`.
- `timestamp` — ISO-8601 UTC.
- `host` — `os.hostname()` of the container.
- `service` — `@cms/server`.
- `version` — the package version on the running image (`0.1.0`).
- `event` — short stable verb, like `request.completed`, `request.rate_limited`, `request.oversized`, `readiness.boot`, `config.loaded`, `server.listening`, `config.invalid`, `server.start_failed`.
- `traceId`, `requestId`, `method`, `path` (server-determined from the URL's pathname, never the raw query), `status`, `latencyMs`, `bytes`, `code`, `detail`, and additional context fields.

The records are PII-free by construction:

- The Node adapter **strips** the inbound `cookie` and `proxy-authorization` headers before the request is forwarded to the API ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L676-L692)). The cookie jar is therefore invisible to every downstream handler.
- The Node adapter logs `path` parsed from the URL pathname. The raw URL's query string is not serialized.
- Bearer credentials are validated by the OIDC verifier and are never persisted on the request log event.
- The Node adapter writes 400 / 413 / 429 / 500 problems as RFC 9457 `application/problem+json` with a server-emitted `traceId` extension; the problem body carries the negotiated locale so the client can verify the resolved peer ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L699-L807)). Problem bodies do not contain the request payload.
- `describeServerConfig` redacts `accessKeyId` and `secretAccessKey` to `***` and rewrites `databaseUrl` to its scheme + host + `/***` before operator logging ([`packages/server/src/config.ts`](../../packages/server/src/config.ts#L429-L456)). The redacted shape supports diagnosis, but copied output from a real host still follows the [`secrets-in-docs`](../security/secrets-in-docs.md) policy.

Operators should size their log collector for the `cms_server_*` event vocabulary above. Do not parse the free-form `detail` field for compliance or audit decisions — read the structured fields only. The `code` field is the stable machine-readable identifier; the `detail` field is human-friendly context.

The log level is controlled by `CMS_LOG_LEVEL` (default `info`) and parsed by `parseLogLevel` against the closed list `silent | error | warn | info | debug` ([`packages/server/src/config.ts`](../../packages/server/src/config.ts#L249-L303)). A value outside that list raises `E_CONFIG_INVALID_LOG_LEVEL` and the server exits before binding.

## Liveness, readiness, and metrics

Three HTTP endpoints are exposed by `@cms/server` for a host-side orchestrator. They are mounted before the API's tenant-required auth middleware, so an unauthenticated probe never touches the authority path ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L404-L425)).

### `/health/live` (liveness)

`GET /health/live` returns `200` with a small JSON body the moment the Node server can answer HTTP. It does **not** validate the database, the object store, or the OIDC issuer. A 503 from this endpoint means the Node process itself is wedged — restart the container (`packages/server/src/index.ts#L404-L415`). The container's Compose healthcheck invokes the process-only probe script:

```sh
node /usr/local/bin/self-host-healthcheck.mjs live
```

The script supports two modes (`live` and `ready`) and refuses `0.0.0.0` / `::` as a probe host unless `ALLOW_INSECURE_HTTP=1` is set explicitly in the test fixture. When both `PORT` and `CMS_PORT` are set and disagree, the script exits `2` — the probe target and the application bind port must move together ([`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs#L55-L82)). This fail-closed behavior prevents the perma-unhealthy container the host warned against.

### `/health/ready` (readiness)

`GET /health/ready` runs three readiness probes in parallel and returns `200` only when all three report `ok`. Any failing probe forces a `503` and the operator gets a per-probe reason in the response body. The probes are:

1. **database** — `storage.getTenantById('00000000-0000-0000-0000-000000000000')`. A round-trip SELECT against Postgres. A connection failure surfaces `transaction_aborted` from the storage layer and the probe reports `database unavailable` ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L834-L846)).
2. **objectStore** — `HEAD` against `${endpoint}/${bucket}` with the configured `CMS_OIDC_FETCH_TIMEOUT_MS`. A `200` or `403` is treated as reachable. Other statuses, network failures, and timeouts each report their own detail ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L848-L863)).
3. **oidc** — `GET` against `CMS_OIDC_JWKS_URL` with the same fetch timeout. The JSON must parse and carry a top-level `keys` array; an empty or absent `keys` field reports `OIDC JWKS response invalid` ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L865-L885)).

Each unsuccessful readiness probe increments the `cms_server_readiness_failures_total` Prometheus counter. The endpoint is for the host orchestrator, **not** a public monitor: a `503` reports whether the server should receive traffic, not whether it is broken. Run the snapshot + restore procedure in [Postgres + MinIO snapshot discipline](#postgres--minio-snapshot-discipline) only after a sustained `503` — a transient outage during restart is normal and expected.

### `/metrics` (Prometheus exposition)

`GET /metrics` returns a Prometheus text exposition (`text/plain; version=0.0.4`). The metric set is fixed at module scope ([`packages/server/src/index.ts`](../../packages/server/src/index.ts#L253-L282)):

| Metric | Type | Field |
| --- | --- | --- |
| `cms_server_uptime_seconds` | gauge | uptime since process start |
| `cms_server_requests_total` | counter | every HTTP request |
| `cms_server_request_bytes_in_total` | counter | request body bytes |
| `cms_server_response_bytes_out_total` | counter | response body bytes |
| `cms_server_rate_limited_total` | counter | 429 responses |
| `cms_server_oversized_total` | counter | 413 responses |
| `cms_server_readiness_failures_total` | counter | failed readiness probes |
| `cms_server_requests_by_status_total{status="..."}` | counter | per-status totals |

`204` and other 2xx, 3xx, 4xx, and 5xx codes share the same per-status counter partition. A Prometheus scrape at `15s` to `60s` is appropriate; the metrics object is in-memory and resets on process restart.

The metrics endpoint serves the same data, format, and `Content-Type` independent of auth. Network isolation is the operator's job: the `cms_data` network is marked `internal: true` in [`compose.yaml:30-50`](../../compose.yaml#L30-L50), while the server also joins `cms_egress` and exposes its HTTP port through the published bind mapping. Protect `/metrics` at the host or reverse-proxy boundary; do not expose it to the wider internet.

## Postgres + MinIO snapshot discipline

Governance state lives in two stores. Both stores must be snapshotted together; an inconsistent pair cannot be replayed safely.

### What lives where

- **`cms_postgres_data` named volume** — governance schema (`cms_storage.*`), `cms_schema_migrations` ledger, audit envelopes, idempotency records, proposals, approvals, revisions, publications, deploy receipts, region bindings. The full schema is the forward-only `0001_governance.sql` migration; rollback is not provided ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql)).
- **`cms_minio_data` named volume** — governed blobs under `CMS_OBJECT_BUCKET`. The bucket holds canonical and derived media. Writes go through the application with the bucket-scoped user; MinIO root credentials never reach the application ([`compose.yaml:184-239`](../../compose.yaml#L184-L239)). Cerafica reports a broken or unverified alias as `E_AMBIGUOUS_BINDING`, refuses direct alias writes with `E_ALIAS_WRITE_FORBIDDEN`, and refuses derived or non-canonical writes with `E_DERIVED_WRITE_FORBIDDEN`; second independent adapter validation remains a v1.1 conformance gate.

The two stores therefore carry complementary state. Postgres has the **provenance** of every approval and the **envelope** of every audit event. MinIO has the **canonical bytes** for every uploaded asset and every publication artifact. Losing either side breaks replay.

### The snapshot cadence

The discipline is: **snapshot both, in one logical step, before any destructive step**.

| Operator action | Snapshot required | Reason |
| --- | --- | --- |
| Bumping the `cms-server:local` image | yes | the migration gate may run on first boot |
| First run after a `git pull` of `packages/storage/migrations/` | yes | new SQL files produce schema changes |
| Promoting a release tag | yes | a release may rebase compose wiring |
| Rotating `CMS_OIDC_*`, `CMS_OBJECT_ACCESS_KEY_ID`, `CMS_OBJECT_SECRET_ACCESS_KEY`, or `CMS_POSTGRES_PASSWORD` | yes | rotation is destructive; capture before rotating |
| After any 503 on `/health/ready` that does not self-recover in `30s` | yes | take the snapshot before further diagnosis |
| Routine weekly cadence | yes | the cheapest insurance |

The cadence is intentionally aggressive about taking snapshots and conservative about skipping them. The Postgres and MinIO named volumes together are smaller than any other durable footprint of the system, so the cost is dominated by the I/O bandwidth, not the storage.

### The snapshot boundary

A snapshot must capture:

1. The `cms_postgres_data` named volume **at quiescence**. Use `pg_dump --schema=cms_storage --schema=public` against the running database, OR stop the `postgres` container, snapshot the named volume, and restart. Do not mix methods across the same logical snapshot pair.
2. The `cms_minio_data` named volume **at quiescence**. Use `mc mirror cms-content /backup/cms-content` against the bucket, OR stop the `minio` container, snapshot the named volume, and restart.
3. The exact `cms_server.env` or `.env` that was active when the snapshot was taken. The env file is not durable state, but the snapshot is unusable without the matching `CMS_*` values.

The two snapshots must be taken within the same logical window. A Postgres snapshot from Monday paired with a MinIO snapshot from Wednesday is not a coherent pair — the audit envelope references MinIO object IDs that may not have existed when the Postgres snapshot was taken, and replay is unsafe.

### What snapshots are NOT

- A snapshot is **not** a substitute for the migration gate. The append-only `audit_events` table refuses `UPDATE` / `DELETE` / `TRUNCATE` ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql#L578-L612)), so the only way to recover from a corrupt schema is to drop and re-provision from snapshot. The migration gate is the path forward.
- A snapshot is **not** the same as a backup rotation set. The CMS does not assume a particular retention policy; the operator chooses how many snapshots to keep.
- A snapshot is **not** a license to bypass the migration gate. Once a migration is recorded in `cms_schema_migrations`, the migration itself is immutable; adding a new migration is the only legal forward step. The boundary is described on [`migrate.md`](migrate.md) · [`.es`](migrate.es.md).

## Agency operator vs. self-hoster

The runtime is identical. The role split lives entirely in who owns what is beneath the compose file.

### Agency operator (managed compose)

The agency operator runs the stack on behalf of one or more clients. They own:

- `.env` (or its secrets-manager equivalent) at the repository root: every `CMS_*` substitution.
- The published bind host/port: `CMS_BIND_HOST`, `CMS_BIND_PORT`, `CMS_PORT`. The published port MUST track `CMS_PORT`; a mismatch yields a perma-unhealthy container with no signal in the logs ([`compose.yaml`](../../compose.yaml#L296-L301)).
- The OIDC issuer (or the hosted instance they point at): `CMS_OIDC_ISSUER`, `CMS_OIDC_AUDIENCE`, `CMS_OIDC_JWKS_URL`, `CMS_OIDC_ALGORITHMS`, `CMS_OIDC_JWKS_CACHE_SECONDS`, `CMS_OIDC_FETCH_TIMEOUT_MS`.
- Rotation on their own schedule: `CMS_OIDC_*`, `CMS_OBJECT_ACCESS_KEY_ID`, `CMS_OBJECT_SECRET_ACCESS_KEY`, `CMS_POSTGRES_PASSWORD`.

They never own the host beneath the compose file. They read redacted boot diagnostics and approve deploys. They run and monitor the one-shot `migrations` service and read its output via `docker compose run --rm migrations` ([`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt#L28-L33)).

### Self-hoster (full stack on a host they own)

The self-hoster additionally owns:

- The reverse proxy, TLS termination, and the published bind host/port.
- The named volumes: `cms_postgres_data` and `cms_minio_data`. Snapshot cadence, retention, and off-host replication are the self-hoster's responsibility.
- Hardening posture: process isolation, read-only mounts where possible, `no-new-privileges`, the `cms_data` network isolation, the image non-root user, and the compose-level `security_opt`. Follow [`../security/hardening.md`](../security/hardening.md) · [`.es`](../security/hardening.es.md).
- Engine and host updates: Docker, the host kernel, and the OIDC issuer's public JWKS endpoint rotation.

Roles never blur. The agency operator delegates volume backup to the host; the self-hoster delegates OIDC issuance to an external IdP. Neither role delegates OIDC issuance to the other.

### What the author never sees

The author is a third role and is operationally out of scope for this page. They:

- Authenticate only through the configured OIDC issuer.
- Author proposals / revisions / media through the CMS API.
- Consume canonical content through adapters.
- **Never** touch Postgres, MinIO, the `server` container, the `.env` file, or the compose stack.

If an author needs a schema change, a new region binding, a new adapter, or a new bucket policy, that is an operator ticket, not an author capability ([`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt#L65-L72)).

## Where day-2 fits in the human authority lifecycle

Day-2 operations remain governed. The authority model in [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es`](../concepts/governance-and-human-authority.es.md) states that approve, publish, and rollback are system-side human-authority transitions, never adapter authority. The day-2 surface does not let an operator apply a change on behalf of an author or approve a proposal without a human authority event.

Concretely:

- **Approval** is recorded by the API only after a current human authorization event. Static environment, service, agent, and MCP identities fail closed (`E_SERVICE_APPROVAL_FORBIDDEN`, `E_MCP_APPROVAL_FORBIDDEN`).
- **Publication** writes the approved revision to the host canonical source and returns `canonical_written`. A failed deploy receipt leaves the proposal at `canonical_written`; it does not silently invent an intermediate `live` state.
- **Rollback** is one current human authorization action and ends at `canonical_written`. Asynchronous deploy reconciliation converges after the rollback, not the other way around.

The Compose bring-up and day-2 operations above do not cross the authority boundary. They move containers, rotate secrets, snapshot volumes, and surface failures — none of which requires the human-authority gate.

## What was verified

The runtime signals on this page are read directly from the source files cited above. The composition `docker compose -f compose.yaml config --quiet` was the only Docker-related command V1 ran; it validated substitution only, not a live daemon ([`self-host.md`](self-host.md) · [`.es`](self-host.es.md) `#what-was-verified`). The runtime package tests and the healthcheck syntax check cover the application layer, not the container layer; a `node scripts/self-host-healthcheck.mjs {live,ready}` was syntax-checked, not exercised against a running server. The V1 verification report records this explicitly in its limitations ledger at `artifacts/g008/workspace-test-report.json`.

A live Docker daemon-backed build, runtime, log scrape, scrape of `/metrics`, snapshot of `cms_postgres_data`, or mirror of `cms_minio_data` is **not** part of V1 and is not a claim on this page. For deployment guidance, follow [`self-host.md`](self-host.md) · [`.es`](self-host.es.md) and [`../security/hardening.md`](../security/hardening.md) · [`.es`](../security/hardening.es.md). The on-disk evidence is limited to the cited source files and the seven-command report referenced from [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).

## Where to go next

- Schema upgrades and the migration gate: [`migrate.md`](migrate.md) · [`.es`](migrate.es.md).
- Bring-up: [`self-host.md`](self-host.md) · [`.es`](self-host.es.md).
- The seven-command workspace verification sequence (operator surface): [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).
- Every `CMS_*` value and its parsing rule: [`configure.md`](configure.md) · [`.es`](configure.es.md).
- The hosting-stack architecture (network and storage rationale): [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md).
- The content boundary and human authority model: [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md).
- The verification report: `artifacts/g008/workspace-test-report.json`.
- PII-free JSON logger: [`packages/server/src/index.ts:163-180`](../../packages/server/src/index.ts#L163-L180).
- Readiness probes: [`packages/server/src/index.ts:834-885`](../../packages/server/src/index.ts#L834-L885).
- Prometheus exposition: [`packages/server/src/index.ts:253-282`](../../packages/server/src/index.ts#L253-L282).
- Compose two-branch DAG and probe wiring: [`compose.yaml:30-50`](../../compose.yaml#L30-L50) and [`compose.yaml:243-329`](../../compose.yaml#L243-L329).
- Healthcheck script contract: [`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs).
