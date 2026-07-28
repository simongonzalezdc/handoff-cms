# Hardening Handoff CMS

> **Audience:** self-hosters and security reviewers. This page is the closed operator-facing hardening checklist that turns the threat model at [`threat-model.md`](threat-model.md) · [`.es`](threat-model.es.md) into deployable configuration. It mirrors `compose.yaml`, `Dockerfile`, `.env.example`, [`packages/server/src/config.ts`](../../packages/server/src/config.ts), and [`packages/server/src/index.ts`](../../packages/server/src/index.ts). Primary OWASP citations are inline (retrieved 2026-07-28).

> [Versión en español](hardening.es.md) · English and Spanish are peer locales. Both ship in the same pull request. See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## Audience boundary

Three operational roles share the compose stack but have distinct postures. This page is for the self-hoster running the full stack on a host they own; they additionally own reverse-proxy termination, TLS, volume backup, and the rotation calendar. The agency operator owns `.env` only and is covered by [`../how-to/configure.md`](../how-to/configure.md) · [`.es`](../how-to/configure.es.md). The author never touches any value on this page.

## What this page is and is not

It documents what the runtime applies today, what the operator must add outside the runtime, and the source locations where each control is anchored. It does not introduce controls the system cannot enforce and does not promise verification beyond what the workspace evidence records. Where a control is a hosted concern (reverse proxy, TLS, log retention) the page names the contract the runtime expects and leaves the implementation to the operator.

## Secret ownership

| Secret | Owner | Delivery channel | Rotation cadence | Redaction guarantee |
| --- | --- | --- | --- | --- |
| `CMS_POSTGRES_PASSWORD` | self-hoster | Operator-managed `.env` (Compose-required substitution) | Operator-defined; see [Rotation schedule](#rotation-schedule) | Embedded in `CMS_DATABASE_URL`; both must rotate together. |
| `CMS_MINIO_ROOT_USER` / `CMS_MINIO_ROOT_PASSWORD` | self-hoster | Operator-managed `.env`; used only by `minio` and `minio-init` | Operator-defined; see [Rotation schedule](#rotation-schedule) | Never reaches the application; the `cms-app` policy is bucket-scoped. |
| `CMS_OBJECT_ACCESS_KEY_ID` / `CMS_OBJECT_SECRET_ACCESS_KEY` | self-hoster | Operator-managed `.env`; bucket-scoped application user created by `minio-init` | Operator-defined; bind to MinIO root rotation | Redacted in `describeServerConfig`. |
| `CMS_OIDC_ISSUER`, `CMS_OIDC_AUDIENCE`, `CMS_OIDC_JWKS_URL` | self-hoster | Operator-managed `.env`; consumed by the verifier | Issuer-side; key rotation respects `CMS_OIDC_JWKS_CACHE_SECONDS` | Not exposed in logs; the verifier never echoes the bearer. |
| `CMS_PUBLIC_URL` | self-hoster | Operator-managed `.env` | n/a (public) | Logged without credentials. |
| Postgres data and MinIO data volumes | self-hoster | Host filesystem snapshot path | Operator-defined | `cms_postgres_data` and `cms_minio_data` are named volumes. |

Delivery channel rules: `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.crt`, `*.p12` are excluded from the Docker build context ([`.dockerignore`](../../.dockerignore)). No `CMS_*` value is baked into the runtime image ([`Dockerfile`](../../Dockerfile)). The runtime stage applies safe non-secret defaults through `ENV` and lets Compose override each value at deploy time. `loadServerConfig` parses every value and throws `ServerConfigError` with a closed `SERVER_CONFIG_ERROR_CODES` code (`E_CONFIG_MISSING_REQUIRED`, `E_CONFIG_INVALID_TYPE`, `E_CONFIG_OUT_OF_RANGE`, `E_CONFIG_INVALID_URL`, `E_CONFIG_INVALID_LOG_LEVEL`). `describeServerConfig` redacts `accessKeyId`, `secretAccessKey`, and the database URL password before any operator logging.

Cite: OWASP Secrets Management Cheat Sheet — <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html>

## Rotation schedule

Handoff CMS does not impose a vendor-validated rotation calendar; it defines the contract the system honours and the operator acts on. The order below is the recommended cadence for a steady-state deployment. Each rotation is a deliberate, journaled change; the runtime is fail-closed across every step.

1. **Postgres data snapshot.** Stop `server` (Compose stops dependents). Snapshot `cms_postgres_data`. Restart.
2. **`CMS_POSTGRES_PASSWORD` and the password embedded in `CMS_DATABASE_URL`.** Update `.env` so the standalone variable and the embedded URL stay in sync. Compose's required substitution catches missing values; the server loader catches malformed values. Restart `postgres`, `migrations`, then `server`.
3. **MinIO root credentials.** Update `.env`. Re-run `minio-init` so the `cms-app` policy reattaches to fresh application credentials. The root credentials never reach the application.
4. **Bucket-scoped application user.** Update `.env`. `minio-init` replaces only that user before the server restarts.
5. **OIDC signing keys.** Publish the new key at the JWKS URL with the previous key overlapping the cache window. The verifier uses `createRemoteJWKSet` with bounded cache and bounded fetch.
6. **Audit JWS signing key.** The offline verifier accepts the new key. Existing envelopes remain verifiable against the historical key.
7. **OIDC bearer tokens.** Issuer-side; respect the `exp` claim verification. Bounded clock skew of 30 s.
8. **Image and Node runtime.** Rebuild to pick up patched `node:22.20.0-bookworm-slim` and dependency updates.

The closed runtime responses the operator can correlate against: `E_CONFIG_MISSING_REQUIRED` (Compose `${VAR:?message}` catches most missing values; the server loader catches malformed values, out-of-range integers, invalid URLs, invalid log levels, invalid `CMS_OIDC_ALGORITHMS` lists) and `E_OIDC_JWKS_UNAVAILABLE` (JWKS fetch failure; bounded by `CMS_OIDC_FETCH_TIMEOUT_MS` and `CMS_OIDC_JWKS_CACHE_SECONDS` on the happy path).

## Non-root and capability drop

| Control | Where | What the runtime does |
| --- | --- | --- |
| **Non-root runtime user** | `Dockerfile` | Creates `cms:cms` (UID / GID 10001) and runs the application as that user. The home is `/home/cms`; the shell is `/usr/sbin/nologin`. |
| **`no-new-privileges:true`** | `compose.yaml` | Applied to `migrations`, `minio-init`, and `server`. The container cannot acquire new privileges through `setuid` / `setgid` binaries or file capabilities. |
| **`read_only: true`** | `compose.yaml` | Applied to `migrations` and `minio-init`. |
| **`tmpfs` scratch mounts** | `compose.yaml` | Bounded `tmpfs` mounts for `/tmp`, `/run/postgresql`, and one-shot scratch. |
| **PID-1 reaping** | `Dockerfile` | `tini --` is the entrypoint; orphan processes are reaped. |
| **Healthcheck script pinning** | `Dockerfile`, [`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs) | `chmod 0555` on the script; refuses `0.0.0.0` / `::` as a probe host unless `ALLOW_INSECURE_HTTP=1` is set explicitly. Fails closed when `PORT` and `CMS_PORT` disagree. |

The application never needs to `chmod`, `chown`, or otherwise mutate the runtime filesystem in the hot path. Any future control that requires in-place mutation is a behaviour change, not a hardening change, and is not on this page.

Cite: CIS Docker Benchmark §4 (image build) and §6 (networking); OWASP Docker Top 10.

## Loopback healthchecks

The image and the runtime cooperate so the container's `HEALTHCHECK` and any host-side probe reach `127.0.0.1` instead of `0.0.0.0` or another container. The script [`scripts/self-host-healthcheck.mjs`](../../scripts/self-host-healthcheck.mjs) makes this contract explicit: `HOST` defaults to `127.0.0.1`; the script exits `2` if `ALLOW_INSECURE_HTTP` is not `1` and the host is `0.0.0.0`, `::`, or `[::]`. `PORT` and `CMS_PORT` are both honoured; when both are set and disagree, the script exits `2`. `PROBE_TIMEOUT_MS` (default `3000`) and `PROBE_RETRIES` (default `1`) bound the probe budget. The script uses the global `fetch` (Node ≥ 18) so it has no npm dependency and is reproducible byte-for-byte.

The image's `HEALTHCHECK` directive is `node /usr/local/bin/self-host-healthcheck.mjs live` with `--interval=15s`, `--timeout=5s`, `--start-period=20s`, `--retries=3`. Compose's published port `${CMS_BIND_HOST:-127.0.0.1}:${CMS_BIND_PORT:-8080}:${CMS_PORT:-8080}` forces the bound port to track the application bind port; the script fails closed if the two disagree.

## Private health and metrics endpoints

Four unauthenticated HTTP endpoints are exposed by `@cms/server` for a host-side orchestrator. They are mounted **before** the API's tenant-required auth middleware so an unauthenticated probe never reaches the authority path. The grounding is [`packages/server/src/index.ts`](../../packages/server/src/index.ts) · [`../reference/observability.md`](../reference/observability.md) · [`.es`](../reference/observability.es.md).

| Endpoint | Purpose | Operator-only network requirement |
| --- | --- | --- |
| `GET /v1/health` | Authority-surface liveness; frozen response `{ status, service, locale }` with `security: []` in OpenAPI | Bound to the API mount; the request body has no PII. |
| `GET /health/live` | Node liveness; returns `{ status, service, version, timestamp }` with `version: "0.1.0"` | Fronted on the operator network only; not exposed publicly. |
| `GET /health/ready` | Operator readiness; runs database, object store, and OIDC checks in parallel under `Promise.all` | Fronted on the operator network only; not exposed publicly. |
| `GET /metrics` | Prometheus text exposition with exactly eight metric names and a single `status` label | Fronted on the operator network only; not exposed publicly. |

Re-exposure rules: bind on the operator network; no labels leak tenant or actor identifiers (`status` is the only label dimension — no `tenant_id`, no `actor_id`, no `route`, no `method`, no `locale`); headers are stripped before the API sees them (the Node adapter drops `cookie` and `proxy-authorization`; bearer credentials are validated by the OIDC verifier and never persisted on the request log event); bodies are not logged (the only body-shaped field a caller can attach is `bytes`, which is the declared `content-length` for an oversize rejection); the `cms_postgres_*` readiness probe does a `SELECT` through the storage layer for tenant `00000000-0000-0000-0000-000000000000`. Failures surface as `503` with the literal `database unavailable` in the `detail` field.

## `MINIO_BROWSER` off

The MinIO container is configured to disable the embedded browser console entirely: `MINIO_BROWSER: "off"` in `compose.yaml`; `--console-address :9001` is the network port the embedded console would have bound; with `MINIO_BROWSER=off` the listener refuses connections. `mc anonymous none` sets the bucket to private. The `cms-app` policy has bucket listing and object CRUD scoped to `CMS_OBJECT_BUCKET`; the application user has no wildcard `*` permission, no `s3:ListAllMyBuckets`, no cross-bucket read or write.

The runtime application talks to the S3-compatible endpoint at `CMS_OBJECT_ENDPOINT` with `CMS_OBJECT_FORCE_PATH_STYLE=true`. The self-host configuration uses path-style addressing; signed URLs are scoped to `CMS_OBJECT_BUCKET` only. **Browsing the object store from a browser console is never an operator capability on this stack.** Operators who need to inspect blobs use the AWS CLI or the `mc` client against the endpoint with the bucket-scoped application user credentials.

## Network split

The compose graph declares exactly two networks. The split is the runtime's contribution to the threat-model §10 entry; the operator extends it with the host firewall.

- `cms_data` — internal, `internal: true`, `attachable: true`. Hosts `postgres`, `migrations`, `minio`, `minio-init`. The server joins this network for data access.
- `cms_egress` — `internal: false`, `attachable: true`. Hosts the `server` service only. The server reaches the OIDC issuer and JWKS endpoint over this network; it never publishes data ports.

The published port mapping on the operator network is `${CMS_BIND_HOST:-127.0.0.1}:${CMS_BIND_PORT:-8080}:${CMS_PORT:-8080}`. The default `CMS_BIND_HOST=127.0.0.1` keeps the published port on loopback; the operator's reverse proxy listens on the public interface and forwards to `127.0.0.1:8080`.

Operational rules: do not change `internal: true` on `cms_data`; do not publish Postgres or MinIO ports (the published `ports:` block on `server` is the only published mapping); do not add a third network that bridges `cms_data` with the host network (if a tool needs data access, it joins `cms_data` explicitly).

## Bounded runtime resources

The compose file places explicit resource caps on every service. The caps are deliberately narrow; they keep the blast radius of a runaway container bounded and surface saturation as a readiness failure rather than a host hang.

| Service | CPU limit | Memory limit | CPU reservation | Memory reservation |
| --- | --- | --- | --- | --- |
| `postgres` | 1.0 | 768 MiB | 0.25 | 256 MiB |
| `minio` | 1.0 | 1024 MiB | 0.25 | 256 MiB |
| `server` | 1.0 | 1024 MiB | 0.25 | 256 MiB |

The migration and `minio-init` one-shots do not set resource caps; they are short-lived and pass through the system default.

## Operator-side obligations not enforced by the runtime

- **TLS termination.** The server speaks plain HTTP on the loopback bind. Terminating TLS is a reverse-proxy responsibility; do not bypass the reverse proxy.
- **Reverse-proxy hardening.** TLS version, cipher suites, HSTS, ALPN, and OCSP stapling are reverse-proxy concerns.
- **Log retention.** The server writes PII-free JSON to `stderr`. The operator's log shipper owns retention, integrity, and access policy.
- **Audit envelope retention.** `@cms/audit` produces offline-verifiable envelopes; the operator owns the verification keys and the archive window. The threat model documents the offline verifier contract at [`threat-model.md`](threat-model.md) · [`.es`](threat-model.es.md) §11.
- **Snapshot validation.** Restoring `cms_postgres_data` and `cms_minio_data` is a host-side concern; the application provides no in-band snapshot API.
- **External operator reconnaissance.** The unauthenticated `/health/*` and `/metrics` endpoints are bound to the operator network. The threat model lists the re-exposure rules at [`threat-model.md`](threat-model.md) · [`.es`](threat-model.es.md) §12.
- **Image update cadence.** Upstream Node 22 / Debian security updates are operator-driven; the operator rebuilds the image when a CVE applies.

## What was verified

This page is grounded in the source files named above. The only Docker-related command V1 actually ran is interpolation-only: `docker compose -f compose.yaml config --quiet`. That command validates the substitution map. It does not build the image, start the daemon, or exercise any container. A live Docker daemon-backed build or runtime is **not** part of V1 and is not a claim on this page.

## Limitations

- **External participant accessibility testing.** External validation is a planned v1.1 goal ([`../accessibility/statement.md`](../accessibility/statement.md) · [`.es`](../accessibility/statement.es.md)).
- **Second independent adapter.** A second adapter is the v1.1 conformance gate ([`../reference/adapter-sdk.md`](../reference/adapter-sdk.md) · [`.es`](../reference/adapter-sdk.es.md)).
- **Docker daemon-backed deployment.** Compose was interpolation-only; no live daemon build or runtime was executed ([`../how-to/self-host.md`](../how-to/self-host.md) · [`.es`](../how-to/self-host.es.md)).
- **Vendor-validated rotation calendar.** The runtime imposes bounded JWKS caches, bounded fetch timeouts, and bounded clock skew; the operator owns the actual calendar per [Rotation schedule](#rotation-schedule).

## Where to go next

- The threat model — [`threat-model.md`](threat-model.md) · [`.es`](threat-model.es.md).
- Bring-up — [`../how-to/self-host.md`](../how-to/self-host.md) · [`.es`](../how-to/self-host.es.md).
- Configuration variables — [`../how-to/configure.md`](../how-to/configure.md) · [`.es`](../how-to/configure.es.md).
- Day-2 operations — [`../how-to/operate.md`](../how-to/operate.md) · [`.es`](../how-to/operate.es.md).
- The hosting-stack architecture (network and storage rationale) — [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md).
- The content boundary and human authority model — [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md).
- The reviewer on-ramp — [`reviewer-on-ramp.md`](reviewer-on-ramp.md) · [`.es`](reviewer-on-ramp.es.md).
- The closed `SERVER_CONFIG_ERROR_CODES` union — [`packages/server/src/config.ts`](../../packages/server/src/config.ts).
- The closed `SERVER_AUTH_ERROR_CODES` union — [`packages/server/src/auth.ts`](../../packages/server/src/auth.ts).
