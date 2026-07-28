# Self-hosting Handoff CMS

> [Versión en español](self-host.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

This page is for the **self-hoster** audience: an operator bringing the full stack up on a host they own. It is grounded in `compose.yaml`, `.env.example`, and `Dockerfile` at the repository root, and in the server config loader at [`packages/server/src/config.ts`](../../packages/server/src/config.ts). Nothing on this page has been live-tested against a Docker daemon — see [What was verified](#what-was-verified) below for the exact scope of V1 evidence.

## Audience boundary

Handoff CMS has three operational roles. This page addresses the **self-hoster** who runs the full `compose.yaml` stack. Adjacent audiences live on their own pages:

- The **agency operator** running a managed compose stack is covered by [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md) (the seven-command verification sequence) and [`configure.md`](configure.md) · [`.es`](configure.es.md) (fail-closed startup validation).
- The **author** who edits content through the OIDC-authenticated surface is covered by [`authoring.md`](authoring.md) · [`.es`](authoring.es.md).
- The **integrator** writing an adapter is covered by [`../reference/adapter-sdk.md`](../reference/adapter-sdk.md) · [`.es`](../reference/adapter-sdk.es.md).

Day-2 operations are documented in [`operate.md`](operate.md) · [`.es`](operate.es.md), [`migrate.md`](migrate.md) · [`.es`](migrate.es.md), [`backup-restore.md`](backup-restore.md) · [`.es`](backup-restore.es.md), [`../reference/observability.md`](../reference/observability.md) · [`.es`](../reference/observability.es.md), and [`../security/hardening.md`](../security/hardening.md) · [`.es`](../security/hardening.es.md).

## Prerequisites

The bring-up assumes a single Linux host with the following toolchain, all pinned by the workspace manifest:

- **Docker Engine + Compose v2.** Required to read `compose.yaml`. The compose file targets the Compose v2 schema; commands on this page assume `docker compose` (v2).
- **Node.js ≥ 22.0.0.** Pinned in `package.json` under `engines.node`. The Docker image pins `NODE_VERSION=22.20.0` (`Dockerfile` ARG, line 16).
- **pnpm ≥ 9.0.0.** Pinned in `package.json` under `engines.pnpm`. The Docker image pins `PNPM_VERSION=9.15.0` (`Dockerfile` ARG, line 17). The package manager declaration is `packageManager: pnpm@9.15.0`.
- **An OIDC issuer** the host can reach at runtime. The server verifies `CMS_OIDC_ISSUER`, `CMS_OIDC_AUDIENCE`, and `CMS_OIDC_JWKS_URL`; symmetric (`HS*`) and `none` algorithms are refused ([server OIDC surface](../../packages/server/src/config.ts#L82-L102)).

## The two-branch compose DAG

`compose.yaml` defines exactly five services arranged as a strict two-branch DAG. Branches converge only at the `server` service, and the server does not start until both branches have reached a terminal healthy or completed-successfully state.

**Data branch (network `cms_data`, internal — no external ingress):**

1. `postgres` — `postgres:16-alpine`. Required env: `CMS_POSTGRES_DB`, `CMS_POSTGRES_USER`, `CMS_POSTGRES_PASSWORD`. Healthcheck: `pg_isready`. Volume: `postgres_data` → `/var/lib/postgresql/data`.
2. `migrations` — one-shot, `postgres:16-alpine`. Reads `./packages/storage/migrations/*.sql` read-only. Runs `psql ... -v ON_ERROR_STOP=1` per migration against `CMS_DATABASE_URL`, records each applied revision in `public.cms_schema_migrations`. `restart: "no"`. Does not start until `postgres` is healthy.

**Object branch (network `cms_data`, internal):**

3. `minio` — `minio/minio:RELEASE.2024-12-18T13-15-44Z`. Required env: `CMS_MINIO_ROOT_USER`, `CMS_MINIO_ROOT_PASSWORD`. `MINIO_BROWSER=off`. Healthcheck uses `mc ready`. Volume: `minio_data` → `/data`.
4. `minio-init` — one-shot, `minio/mc:RELEASE.2024-11-21T17-21-54Z`. Creates the private bucket `CMS_OBJECT_BUCKET` (`mc mb --ignore-existing`), sets `mc anonymous none`, and converges a bucket-scoped application user (`CMS_OBJECT_ACCESS_KEY_ID` / `CMS_OBJECT_SECRET_ACCESS_KEY`) with a least-privilege policy allowing only `s3:GetBucketLocation`, `s3:ListBucket`, `s3:ListBucketMultipartUploads` on the bucket, and `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts` on its objects. Re-runs replace only that dedicated user so rotated credentials take effect before the server starts. **MinIO root credentials never reach the application.** `restart: "no"`. Does not start until `minio` is healthy.

**Server:**

5. `server` — built from `./Dockerfile` as `cms-server:local`. Joins both `cms_data` (internal) and `cms_egress` (the only network with external ingress). Does not start until **all four** of `postgres` (healthy), `migrations` (completed successfully), `minio` (healthy), and `minio-init` (completed successfully) have reached their terminal state. Publishes `${CMS_BIND_HOST}:${CMS_BIND_PORT}:${CMS_PORT}`; the published port must track the application bind port — a mismatch produces a perma-unhealthy container with no signal in the logs (`compose.yaml:296-301`).

Named volumes `postgres_data` and `minio_data` are the durable state. The application never assumes a writable container filesystem.

```text
                     ┌──────────────────────┐    ┌──────────────────────────┐
                     │      data branch      │    │      object branch       │
                     │      cms_data         │    │      cms_data            │
                     │                       │    │                          │
   postgres (healthy) ──► migrations (1-shot)│    │ minio (healthy)          │
                     │                       │    │      │                   │
                     └───────────┬───────────┘    └──────┴─────────┬─────────┘
                                 │                                 │
                                 └──────────────┬──────────────────┘
                                                ▼
                                  ┌──────────────────────────────┐
                                  │       server                 │
                                  │  cms_data + cms_egress       │
                                  │  depends_on: 4 conditions    │
                                  │  healthcheck: live probe     │
                                  │  publish: CMS_BIND_PORT→PORT │
                                  └──────────────────────────────┘
```

## Compose-only verification (no daemon claim)

The only V1-verified Compose command is interpolation-only and does not require a running daemon:

```sh
docker compose -f compose.yaml config --quiet
```

This step validates the Compose substitution map. The verified run used non-secret validation-only substitutions. The container image was not built and the server was not run inside Docker. See [What was verified](#what-was-verified) for the full limitations ledger.

## Placeholder secrets and the .env inventory

`.env.example` at the repository root is the authoritative variable inventory. Treat it as complete; do not infer required variables from this page. Copy it to `.env` and replace every placeholder. The tracked file ships these literals:

```text
CMS_POSTGRES_PASSWORD=replace-with-a-strong-database-password
CMS_MINIO_ROOT_PASSWORD=replace-with-a-strong-minio-root-password
CMS_OBJECT_SECRET_ACCESS_KEY=replace-with-a-distinct-strong-application-secret
```

Concrete rules:

- The `replace-with-*` strings are placeholders. Compose refuses to start the server when required values are missing (`compose.yaml:269-284` uses the `${VAR:?message}` required-substitution form for every secret). Required values produce a hard Compose error before any container starts; the server itself additionally fails closed via `loadServerConfig` and emits a redacted `ServerConfigError` carrying one of the codes in [`SERVER_CONFIG_ERROR_CODES`](../../packages/server/src/config.ts#L22-L30).
- The three secret values are **distinct**. Reusing the Postgres password for MinIO root, or the MinIO root password for the application user, is allowed by the substitution grammar but rejected by the security boundary — the MinIO root credentials must never reach the application, and the application user is bucket-scoped to `CMS_OBJECT_BUCKET` only (`compose.yaml:202-218`).
- `CMS_DATABASE_URL` embeds `CMS_POSTGRES_PASSWORD`; replace the embedded password together with the standalone variable so the two stay in sync.
- `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.crt`, and `*.p12` are excluded from the Docker build context (`.dockerignore:19-26`). The build context never sees a real secret even if one is committed by mistake.
- `describeServerConfig` redacts the application object-store credentials and the database URL password before any operator logging; secret values never appear in the redacted diagnostic summary ([`config.ts:429-456`](../../packages/server/src/config.ts#L429-L456)).

The full OIDC, Postgres, MinIO, and quota variable inventory is documented in [`configure.md`](configure.md) · [`.es`](configure.es.md). This page intentionally does not duplicate it.

## Fail-closed startup and SERVER_CONFIG_ERROR_CODES

The server is fail-closed: every required `CMS_*` value is parsed by `loadServerConfig` (`packages/server/src/config.ts`) before the HTTP server binds. On a validation failure `loadServerConfig` throws a `ServerConfigError` carrying a stable machine-readable code from the closed union:

```ts
export const SERVER_CONFIG_ERROR_CODES = [
  'E_CONFIG_MISSING_REQUIRED',
  'E_CONFIG_INVALID_TYPE',
  'E_CONFIG_OUT_OF_RANGE',
  'E_CONFIG_INVALID_URL',
  'E_CONFIG_INVALID_LOG_LEVEL',
] as const;
```

The set is frozen at module load (`Object.freeze`) and the `ServerConfigErrorCode` type alias is the union's element type. The thrown error carries a `details` bag with the offending variable name; it never embeds secret values. Compose's required-substitution form `${VAR:?message}` catches missing values at the orchestration layer before the container starts; the server's loader catches malformed values, out-of-range integers, invalid URLs, invalid log levels, and invalid `CMS_OIDC_ALGORITHMS` lists.

The startup contract is:

1. Compose refuses to start any service whose `${VAR:?message}` substitution is unset.
2. `postgres` and `minio` reach a healthy state before their dependents begin.
3. `migrations` and `minio-init` complete successfully before the server begins.
4. `server` calls `loadServerConfig`; on success it binds on `${CMS_BIND_HOST}:${CMS_PORT}`; on failure it exits with the stable `ServerConfigError` code.
5. The `server` healthcheck probes `/usr/local/bin/self-host-healthcheck.mjs live` — a process-only liveness probe that does not perform dependency I/O.

## OIDC, Postgres, and MinIO: what the server validates

The server does not re-implement identity, persistence, or storage. It validates contracts and forwards:

- **OIDC.** The server fetches the JWKS at `CMS_OIDC_JWKS_URL`, caches it for `CMS_OIDC_JWKS_CACHE_SECONDS` (default 300), and refuses symmetric and `none` algorithms. The allowed list is fixed at module scope (`config.ts:246`). `CMS_OIDC_ISSUER`, `CMS_OIDC_AUDIENCE`, and `CMS_OIDC_JWKS_URL` are required.
- **Postgres.** `CMS_DATABASE_URL` is required and passed to the storage layer. Migrations are owned by `compose.yaml:105-140`, not by the server.
- **MinIO.** `CMS_OBJECT_ENDPOINT` (default `http://minio:9000`), `CMS_OBJECT_BUCKET`, `CMS_OBJECT_ACCESS_KEY_ID`, and `CMS_OBJECT_SECRET_ACCESS_KEY` are required. `CMS_OBJECT_FORCE_PATH_STYLE` defaults to `true` (compose default; the image default matches). `CMS_OBJECT_REGION` defaults to `us-east-1`. The root credentials are used only by `minio` and `minio-init`; the application uses the dedicated bucket-scoped user.

The complete variable matrix and the parsing rules for each value are documented in [`configure.md`](configure.md) · [`.es`](configure.es.md).

## Docker build context

`Dockerfile` is a multi-stage build (deps → workspace build → minimal runtime). The runtime stage:

- runs the Node 22 ESM executable as a non-root user `cms:cms` (UID/GID 10001),
- ships only the production dependency graph materialized by `pnpm deploy --filter @cms/server --prod`,
- copies the healthcheck script from `scripts/self-host-healthcheck.mjs` and pins its mode to `0555`,
- sets safe non-secret defaults for the variables listed under `ENV` (line 100-115), all of which compose overrides at runtime.

No secrets or `CMS_*` values are baked into the image. The container is configured exclusively at runtime via environment variables; the compose file interpolates them from a managed `.env` that only the operator has access to (`Dockerfile:1-14`). The build context excludes `.env`, `node_modules`, build outputs, test artefacts, VCS state, and other workspace glue (`.dockerignore`).

## What was verified

This page is grounded in the source files named above. The only Docker-related command V1 actually ran is interpolation-only:

```sh
docker compose -f compose.yaml config --quiet
```

That command validates the substitution map. It does not build the image, start the daemon, or exercise any container. The V1 verification report at `artifacts/g008/workspace-test-report.json` records this explicitly in its limitations ledger. A live Docker daemon-backed build or runtime is **not** part of V1 and is not a claim on this page.

For live deployment evidence, follow the day-2 [`hardening`](../security/hardening.md), [`migration`](migrate.md), and [`backup/restore`](backup-restore.md) guides. The on-disk V1 evidence remains limited to the cited source files and the seven-command report referenced from [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md); it does not prove a daemon-backed deployment.

## Where to go next

- Configure every `CMS_*` value: [`configure.md`](configure.md) · [`.es`](configure.es.md).
- The seven-command workspace verification sequence (operator surface): [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).
- The hosting-stack architecture (network and storage rationale): [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md).
- The content boundary and human authority model: [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md).
- The verification report: `artifacts/g008/workspace-test-report.json`.
- The closed `SERVER_CONFIG_ERROR_CODES` union source: [`packages/server/src/config.ts:22-30`](../../packages/server/src/config.ts#L22-L30).