# Backup and restore

> [Versión en español](backup-restore.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

This page is for the **self-hoster** and **agency operator** audiences. It is grounded in `compose.yaml` (services `postgres`, `minio`, `migrations`, `minio-init`, `server`) and in the Postgres schema at [`packages/storage/src/schema.ts`](../../packages/storage/src/schema.ts). Nothing on this page is a claim about a live Docker daemon: the V1 verification report at `artifacts/g008/workspace-test-report.json` ran `docker compose -f compose.yaml config --quiet` only, the image was not built, and the server was not run inside Docker. The procedures below describe the on-disk shape and the contract between components; executing them on a live stack is operator-managed.

## Audience boundary

Handoff CMS has three operational roles. This page addresses the **self-hoster** who runs the full `compose.yaml` stack and the **agency operator** who runs a managed compose stack. Adjacent audiences live on their own pages:

- The **author** who edits content through the OIDC-authenticated surface is covered by [`authoring.md`](authoring.md) · [`.es`](authoring.es.md).
- The **integrator** writing an adapter is covered by [`../reference/adapter-sdk.md`](../reference/adapter-sdk.md) · [`.es`](../reference/adapter-sdk.es.md).
- The **security reviewer** is covered by [`../security/reviewer-on-ramp.md`](../security/reviewer-on-ramp.md) · [`.es`](../security/reviewer-on-ramp.es.md).

The lifecycle states, the canonical-write beat, and the `rolled_back` terminal state are documented separately in [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es`](../concepts/governance-and-human-authority.es.md) and in [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md). This page is intentionally narrow: the durable state of the two data services and the boundary between PostgreSQL + MinIO restores and the upstream replay they cannot perform.

## What is durable state

The compose stack exposes exactly two named volumes (`compose.yaml:46-50`):

| Volume | Backed by | Contents |
| --- | --- | --- |
| `postgres_data` | `cms_postgres_data` | The `@cms/storage` Drizzle schema lives here. Tables: `tenants`, `actors`, `region_bindings`, `proposals`, `approvals`, `revisions`, `publications`, `deploy_receipts`, `audit_events`, `idempotency_records`. Frozen `canonical_source`, `derived_artifacts[]`, `regeneration_contract` jsonb columns on `region_bindings`. Table-level CHECK constraints enforce the regeneration mode allow-list and the proposal `state` alphabet (`schema.ts:177-240`, `schema.ts:275-327`). |
| `minio_data` | `cms_minio_data` | The S3-compatible bucket `CMS_OBJECT_BUCKET` (default `cms-content`). Governed media blobs and the EXIF-stripped / ICC-preserved derivatives produced by `@cms/media`. The bucket is private (`mc anonymous set none` in `minio-init`). |

The two volumes are **independently durable**. There is no cross-volume transaction; the application never assumes a writable container filesystem. A backup that captures one without the other is partial and must be labelled as such.

## What is out of scope

- **Hot consistency.** A consistent snapshot taken **only** at the Linux-volume level (for example, an `rsync` against the bind-mounted `postgres_data` while Postgres is running) is **not** a consistent backup. The Postgres data directory is modified continuously; reading it mid-write is unsafe. The procedures below freeze the data directory with the application's own tooling, not at the volume level.
- **Upstream replay.** The CMS does not reconstruct durable state from an upstream source. The host's canonical content is owned by the host, not by the CMS; the bundle of `(canonical_source, derived_artifacts, regeneration_contract)` lives in `region_bindings`. A restore that drops the `region_bindings` rows but keeps the `minio_data` blob has no idea where the blob belongs.
- **Docker daemon behaviour.** A live `docker compose` bring-up, `docker exec`, or `docker run` against the application's own containers is **not** V1-verified. The Compose configuration is validated by interpolation only; the image was not built, and the application was not run inside Docker. The commands below are written against the host-side Postgres and MinIO binaries; the section [Operator-managed sequence](#operator-managed-sequence) describes the contract, not a verified runtime.
- **Secret exfiltration.** Postgres passwords, MinIO root credentials, and the bucket-scoped application user credentials are operator-managed. The backup and the restore must keep these credentials in lock-step with the durable state.

## Snapshot the two volumes on a consistent boundary

The chosen backup boundary is a **quiesced pair**: stop the `server` container (so no new proposals are being written), then snapshot the Postgres data directory with Postgres's own `pg_basebackup` (or an equivalent that the operator's Postgres tooling supports), then copy the `minio_data` directory. The two artefacts are labelled with the same timestamp. They are **consistent across the pair**, not **synchronously atomic**: the Postgres snapshot is internally consistent on its own; the MinIO snapshot is internally consistent on its own; the two are aligned by the wall-clock timestamp.

If the operator instead uses a block-level filesystem snapshot (LVM/ZFS/btrfs) against the host volumes, the snapshot must be taken **before** the server is started again, so the live database never writes through a frozen image. This page does not endorse any specific filesystem snapshot strategy; it asserts the principle that the snapshot must be internally consistent **per volume** and aligned to the same wall-clock timestamp per pair.

A consistent Postgres snapshot is one produced by `pg_basebackup` (or `pg_dump` for a logical-only dump) against the running daemon or by the daemon's own online backup API. The snapshot is **not** an `rsync` against the directory while Postgres is writing. After the snapshot is verified, the server may be started again.

A consistent MinIO snapshot is one captured by reading the bucket offline via `mc` against a stopped daemon, or by taking the host filesystem snapshot at the moment the MinIO process is frozen. MinIO recommends stopping the daemon before snapshotting the data directory; the application itself does not depend on MinIO being online during the brief window between the two snapshots.

## Restore boundary

The restore is a **two-step forward replay**. There is no cross-volume transaction; the Postgres snapshot is restored first, then the MinIO bucket is restored, then the application is started. The order is fixed because the application reads Postgres first and MinIO second; the reverse order risks the application referencing a bucket whose contents lag the audit row that names them.

After the restore:

1. The application version must be compatible with the restored schema. Postgres migrations are recorded in `public.cms_schema_migrations` ([`compose.yaml:122-134`](../../compose.yaml#L122-L134)); before starting a later application version, run the documented migration gate with `docker compose run --rm migrations`. This command is operational guidance, not V1 daemon-backed evidence.
2. The audit trail is intact. The `audit_events` rows are append-only and content-hashed; the optional Ed25519 JWS signature is recorded separately. A restored audit log is the same audit log the host produced; replaying the audit row is not required.
3. The host's canonical content is untouched by the restore. The CMS does not own the host; the backup is the application's **governed projection** of the host, not a copy of the host's source of truth. A host whose `inventory/products.json` has changed since the snapshot is outside the restore's scope.
4. The proposal lifecycle resumes from the persisted state. A `canonical_written` proposal at the snapshot time is still `canonical_written` after the restore; a `live` proposal is still `live`; a `rolled_back` proposal is terminal `rolled_back` and no further action is permitted. The state machine is fully reconstructed from the database rows; there is no in-memory transition that survives a restart.

## What success looks like

After the restore, the operator should verify three things in order:

1. `GET /v1/health` returns `200` with the negotiated locale (`en` or `es`), proving only that the API process is alive. This unauthenticated route does not read Postgres, MinIO, audit rows, or publication rows ([`packages/api/src/index.ts:145-153`](../../packages/api/src/index.ts#L145-L153)).
2. A `proposal.get` probe against a recent proposal returns the same `state` and `version` that existed before the snapshot. Optimistic `If-Match` guards on the state-transition endpoints remain valid because the `version` is read from the database.
3. The minio-init one-shot and the bucket-scoped application user are still in the correct state. The least-privilege policy on `CMS_OBJECT_BUCKET` is unchanged because the bucket contents are restored as-is; the policy is bucket-scoped and survives the restore.

## Operator-managed sequence

The following commands describe the **contract** between components, not a verified runtime. They are written against the host-side Postgres and MinIO binaries; the operator is responsible for the runtime decision to invoke them against a live stack. The Docker daemon is not verified, and the application was not run inside Docker in V1.

### Pre-flight: stop the application

The application must be quiesced before the snapshot is taken. The exact stop procedure is operator-managed; the contract is that the `server` container is not running while the snapshot is taken. New proposals are not accepted in the stopped state; in-flight deploys report `failed` while the server is down, and the proposal remains `canonical_written` until the server is back and a reconcile runs.

### Snapshot Postgres

```sh
# Replace with the operator's managed credentials and target path.
# This command describes the contract; do not paste real secrets into a tracked file.
pg_basebackup \
  --dbname="$CMS_DATABASE_URL" \
  --format=tar \
  --pgdata="./snapshots/postgres-$(date -u +%Y%m%dT%H%M%SZ)" \
  --wal-method=stream \
  --checkpoint=fast \
  --progress
```

The base backup is internally consistent; the WAL stream is included because `--wal-method=stream` is set. The operator validates the snapshot by running `pg_verifybackup` against the produced tarball before the Postgres service is restarted. A snapshot that fails verification is not a backup.

### Snapshot MinIO

```sh
# Replace with the operator's managed endpoint, credentials, and target bucket.
# This command describes the contract; do not paste real secrets into a tracked file.
mc alias set cms "$CMS_OBJECT_ENDPOINT" "$CMS_OBJECT_ACCESS_KEY_ID" "$CMS_OBJECT_SECRET_ACCESS_KEY"
mc mirror --preserve --remove --overwrite \
  "cms/$CMS_OBJECT_BUCKET" \
  "./snapshots/minio-$(date -u +%Y%m%dT%H%M%SZ)/"
```

The mirror command is a **host-side copy** of the bucket contents. It does not preserve bucket policies, the lifecycle configuration, or the bucket-scoped application user; the operator must re-apply those separately if the restore mounts a fresh MinIO instance. The bucket contents themselves are the durable state under the application contract; the policy and the user are operator-managed.

### Restore Postgres

```sh
# Replace with the operator's managed data directory and snapshot path.
# This command describes the contract; do not paste real secrets into a tracked file.
pg_ctl -D "$CMS_POSTGRES_DATA_DIR" stop -m fast
rm -rf "$CMS_POSTGRES_DATA_DIR"
tar -xf "./snapshots/postgres-YYYYMMDDTHHMMSSZ/base.tar" -C "$CMS_POSTGRES_DATA_DIR"
pg_ctl -D "$CMS_POSTGRES_DATA_DIR" start
```

The restore overwrites the local data directory. The application user (`CMS_POSTGRES_USER`) and the database (`CMS_POSTGRES_DB`) exist in the restored directory because they were created at `initdb`; the operator does not need to re-create them. The application reads the Drizzle table layout from the schema; the layout is what the snapshot contains.

### Restore MinIO

```sh
mc mirror --preserve --overwrite \
  "./snapshots/minio-YYYYMMDDTHHMMSSZ/" \
  "cms/$CMS_OBJECT_BUCKET"
```

The mirror pushes the snapshot back into the configured bucket. The operator must also:

- Re-run the `minio-init` one-shot if the bucket-scoped application user was lost (the MinIO container's local user database is not part of the bucket snapshot).
- Re-apply the least-privilege policy on `CMS_OBJECT_BUCKET` if the bucket itself was recreated.

### Start the application

The application is started by the operator's compose profile. The contract is that `loadServerConfig` succeeds (the required `CMS_*` values are present and well-formed), the `postgres` and `minio` healthchecks report healthy, the `migrations` and `minio-init` one-shots have completed successfully, and the `server` then probes `/v1/health` until it returns 200.

## What the restore cannot do

The restore is **not** an upstream replay. The CMS does not look up the host's canonical content from the database; the host owns the canonical path. The following scenarios are explicitly out of scope:

- **The host's canonical file was lost.** The CMS does not re-derive `inventory/products.json` from the application database. The host's VCS, snapshot, or backup is the canonical source. The application reports the **last known proposal** that wrote the canonical file; it does not reconstruct the file.
- **The `region_bindings` row was lost.** The restore does not discover bindings. The frozen `canonical_source`, `derived_artifacts[]`, `regeneration_contract` columns are persisted in the database; they are part of the durable state and are restored together with Postgres. A restore that drops the bindings but keeps the bucket is a partial restore.
- **A deploy was lost in flight.** A deploy receipt is an asynchronous, host-side report. The receipt table (`deploy_receipts`) is durable; the receipt itself is restored together with Postgres. The proposal's deployment status reflects the **last persisted receipt**; receipts that were in flight at snapshot time are recorded as `pending` if the snapshot was taken before the receipt was written, and as `succeeded`/`failed` if the receipt was already written and the snapshot was taken after.
- **The audit log was partially lost.** The audit envelope is content-hashed and JWS-signed; a partial audit log cannot be reconstructed. The restore is all-or-nothing for the `audit_events` table.

## Reconciliation notes

The proposal state machine ([`packages/core/src/state-machine.ts`](../../packages/core/src/state-machine.ts)) is the lifecycle authority. It has one initial state (`draft`) and one terminal state (`rolled_back`); `proposed` is reached through `submit`. Reconciliation records whether live host state converged; it does not write canonical bytes. From `reconcile_failed`, the only valid exit is `rollback` to terminal `rolled_back`.

A restore loads the persisted proposal and deploy-receipt state as captured; it does not trigger an implicit reconcile. Inspect restored receipts and current host state, then invoke the explicit governed reconcile route only from a state that permits it. The receipt table remains the authoritative deployment report.

## Limitations

- **No Docker daemon-backed build or runtime.** The Compose configuration is validated by interpolation only; the container image was not built and the server was not run inside Docker. The commands above describe the host-side Postgres and MinIO binaries; running them against the application's own containers is operator-managed.
- **No hot consistency claim.** A consistent snapshot is one produced by Postgres's own online backup API and by MinIO's own bucket copy, **not** by a live filesystem snapshot against a running container. The procedures above freeze the data directory with the application's own tooling, not at the volume level.
- **No second adapter.** The Cerafica reference adapter is the only adapter in V1. The backup and restore procedures cover the bytes, the database, and the receipt table; a second adapter introducing a new durable surface (for example, a CDN edge cache or a downstream CMS) is a v1.1 conformance gate, not a V1 completion claim.
- **External participant validation is v1.1.** The product is described as "neurodivergent-accessible by design" in the i18n catalog; external validation is not in V1.

## Where to go next

- Bring up the stack: [`self-host.md`](self-host.md) · [`.es`](self-host.es.md) and [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).
- Configure every `CMS_*` value: [`configure.md`](configure.md) · [`.es`](configure.es.md).
- Lifecycle, human authority, and the canonical write beat: [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es`](../concepts/governance-and-human-authority.es.md).
- Content boundary and the alias_symlink contract: [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md).
- Glossary: [`../project/glossary.md`](../project/glossary.md) · [`.es`](../project/glossary.es.md).
- Verification report: `artifacts/g008/workspace-test-report.json`.
