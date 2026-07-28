# Migrate Handoff CMS

> [Versión en español](migrate.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

This page documents how the `@cms/storage` schema evolves, who owns the migration gate, and what an operator can and cannot do to an applied migration. It is the schema-upgrade companion to [`operate.md`](operate.md) · [`.es`](operate.es.md); runtime day-2 signals, snapshot cadence, and the agency-operator-vs-self-hoster role split live there and are not duplicated here. Bring-up, configuration variables, and the seven-command verification sequence live on [`self-host.md`](self-host.md) · [`.es`](self-host.es.md), [`configure.md`](configure.md) · [`.es`](configure.es.md), and [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md) respectively.

This page is grounded in [`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql), the `migrations` one-shot service in [`compose.yaml`](../../compose.yaml#L102-L140), and the operator note [`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt). The migration gate has not been exercised against a live Docker daemon; see [What was verified](#what-was-verified) for the exact V1 scope.

## Audience boundary

- The **agency operator** runs the managed compose stack and is the day-2 operator of the migration gate. They own the volume snapshot, the `migrations: service_completed_successfully` dependency, and the redacted boot diagnostic.
- The **self-hoster** runs the full stack on a host they own. They additionally own the named-volume restore path and the off-host replication of any applied snapshot.
- The **author** never touches the schema. Schema changes are operator work tickets; the author surfaces a behavior change through the bilingual proposal flow described in [`authoring.md`](authoring.md) · [`.es`](authoring.es.md).
- The **integrator** writing a second adapter (planned v1.1 conformance gate) interacts with the schema through the adapter SDK's contract surface, not through `psql` against `cms_postgres_data`.

## Source of truth and the one-shot gate

The canonical SQL migrations live in the workspace at `packages/storage/migrations/`. Every file in that directory is a forward-only schema change. The `migrations` service in `compose.yaml` is the **only** entry point that should apply them.

The Compose distribution reads the canonical directory read-only and applies each new file plus its marker in **one Postgres transaction**:

```sh
psql "$CMS_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  'CREATE TABLE IF NOT EXISTS public.cms_schema_migrations (revision text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
for migration in /migrations/*.sql; do
  revision="$(basename "$migration")"
  if printf "%s\n" "SELECT 1 FROM public.cms_schema_migrations WHERE revision = :'revision';" \
    | psql "$CMS_DATABASE_URL" -v revision="$revision" -At | grep -q 1; then
    continue
  fi
  {
    cat "$migration"
    printf "\nINSERT INTO public.cms_schema_migrations (revision) VALUES (:'revision');\n"
  } | psql "$CMS_DATABASE_URL" -v revision="$revision" -v ON_ERROR_STOP=1 -1 -f -
done
```

`compose.yaml:105-140`. The relevant invariants are:

- The script creates `public.cms_schema_migrations` (a `(revision text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())` table) once, idempotently. The `revision` is the migration filename — `0001_governance.sql`, `0002_*.sql`, and so on.
- For every migration file in the read-only directory, it queries the ledger for the matching `revision`. If the row exists, the file is **skipped** silently. If the row does not exist, the script runs `cat "$migration" ; INSERT INTO public.cms_schema_migrations (revision) VALUES (:'revision');` in a **single** `psql -1` transaction.
- `psql -v ON_ERROR_STOP=1` aborts the moment a SQL statement returns an error. The whole `cat + INSERT` pair is wrapped in a `BEGIN ... COMMIT` via `psql -1`, so a failure on either side rolls back the migration **and** the marker insert together.
- The `migrations` service has `restart: "no"` and `read_only: true`. It is one-shot. A new migration file added to the directory is not applied until the operator re-runs the gate explicitly.
- The `server` service declares `migrations: condition: service_completed_successfully` on its `depends_on` ([`compose.yaml:243-265`](../../compose.yaml#L243-L265)). Compose refuses to start the server until the migration gate exits 0. There is no override, no `service_healthy` shortcut, and no documented flag to skip it.

Diagnosing the gate from the outside uses the same image re-run with a clean exit:

```sh
docker compose run --rm migrations
```

This iterates the same script and prints the recorded revisions. Already-recorded filenames are skipped by the ledger query; the next file with no recorded revision is the one the gate will apply. When the script finishes without entering the apply branch, the gate exits 0 and Compose proceeds to start the server.

## Append-only SQL migrations

Three rules govern the schema:

1. **Forward-only.** No `DOWN`, no `UNDO`, no `REVERT` SQL. Recovery from a corrupt or wrong migration is via `DROP TABLE` + re-provisioning from a snapshot, not via a reverse SQL statement ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql#L20-L24)).
2. **Append the marker in the same transaction as the SQL.** `psql -1` enforces this. A failure on the SQL side rolls back both the schema change and the marker insert. A failure after the SQL but before the marker insert is impossible because the two are piped into the same `psql -v ON_ERROR_STOP=1 -1` invocation.
3. **Never alter an applied migration.** The bytes that were applied are the contract. Renaming a file or editing its content after release is a silent corruption: the filename may or may not match a row in `cms_schema_migrations`, and the schema may diverge from the recorded ledger.

The append-only nature is reinforced at the SQL layer:

- `cms_storage.audit_events` refuses `UPDATE` / `DELETE` / `TRUNCATE` via `BEFORE` triggers that raise `SQLSTATE 'P0001'` with the marker text `cms_storage.audit_events is append-only`. The storage classifier maps both the SQLSTATE and the marker to `AppendOnlyViolationError` ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql#L578-L612)).
- The schema layer enforces `cms_storage.idempotency_records` transitions from `in_progress` to a terminal outcome (`succeeded` / `failed`) under a single `UPDATE`, but the table itself is **not** append-only at the SQL layer. `CHECK` constraints guard the transition; `BEFORE UPDATE / DELETE` triggers do not ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql#L607-L613)).

The append-only property of `audit_events` is what makes a `DOWN` migration impossible: dropping the table destroys audit lineage that the regulator and the rollback lineage both rely on. That is why recovery is by snapshot + restore, not by reverse SQL.

## What an operator may and may not do

### Allowed operations

The operator may:

- Add a **new** ordered SQL file to `packages/storage/migrations/` whose filename is lexically greater than the highest recorded revision. Filenames start at `0001_*.sql`; the gate orders by filename and applies only the unrevisioned files.
- Re-run the gate via `docker compose run --rm migrations` to apply newly added files. The `cms_schema_migrations` ledger makes this safe to re-invoke.
- Snapshot the `cms_postgres_data` and `cms_minio_data` named volumes **before** promoting a new image that bundles new migration files ([`operate.md`](operate.md) · [`.es`](operate.es.md) `#postgres--minio-snapshot-discipline`).
- `psql "$CMS_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT revision, applied_at FROM public.cms_schema_migrations ORDER BY applied_at;"` to read what has been applied.

The operator's invariant: every schema change is a new ordered file, applied by the gate, recorded in the ledger, and only ever forward.

### Forbidden operations

The operator may not:

- **Rename or edit an applied migration.** Once `cms_schema_migrations` records a filename, that file's bytes are part of the contract. Editing them later is silent corruption.
- **Write a `DOWN` migration.** The migration directory accepts only forward files. The runtime never executes a reverse SQL, and the README states "DOWN migrations are intentionally NOT provided" ([`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt#L47-L48)).
- **Manually `INSERT INTO public.cms_schema_migrations`.** The marker insert is the gate's responsibility. A manual insert claims a revision is applied without actually applying it, and the next `psql -v ON_ERROR_STOP=1` run against that filename will silently skip a missing schema change.
- **`DELETE` or `TRUNCATE cms_storage.audit_events`.** The triggers raise `SQLSTATE 'P0001'`; any attempt aborts the transaction. There is no `WITH (append_only = false)` override, and there must not be one. Dropping the table from the database is a destructive backup-recovery decision, not a routine operation.
- **Bypass the `migrations: service_completed_successfully` dependency.** Booting the `server` against a half-applied migration set is unsafe and is explicitly forbidden by the README ([`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt#L40-L42)). Compose refuses this wiring; the only paths around it would be a fork of `compose.yaml`, which is also out of scope.
- **Apply a migration from a directory other than `packages/storage/migrations/`.** The `migrations` service mounts that directory read-only at `/migrations` ([`compose.yaml:117-118`](../../compose.yaml#L117-L118)); the script iterates `/migrations/*.sql`. A different directory is a different contract.

If the operator needs schema change, they open a pull request that adds a new file under `packages/storage/migrations/`. The gate applies it on the next `docker compose run --rm migrations` call. The change is reviewed as part of the same pull request that introduces it.

## Snapshot / restore boundary

The migration gate does not own backups. It owns the **forward-only schema version**. Backups live on the volume snapshot path described in [`operate.md`](operate.md) · [`.es`](operate.es.md) `#postgres--minio-snapshot-discipline`.

The boundary is:

- **Forward step.** Adding a file, running the gate, and rebooting the `server` against the new image. The gate records the new revision in `cms_schema_migrations`. The pair `(cms_postgres_data, cms_minio_data)` continues forward.
- **Recovery step.** Stopping the stack, restoring the `cms_postgres_data` named volume from a snapshot taken **before** the failed upgrade, restoring `cms_minio_data` from the matching snapshot, recreating `cms_schema_migrations` with the rows that the snapshot covers, and rebooting the `server` against the prior image. The `migrations` gate now exits 0 with no work to do, because the recorded revisions match the files on disk.

A snapshot taken **after** a failed migration does not repair the schema. A snapshot taken **before** the upgrade is the only thing that lets the operator step back. Therefore:

1. Snapshot before any promotion of `cms-server:local` ([`operate.md`](operate.md) · [`.es`](operate.es.md) snapshot cadence table).
2. Apply the upgrade by re-running `docker compose run --rm migrations`.
3. Boot the new image and observe the readiness probes (`/health/ready`) and the structured JSON logs ([`operate.md`](operate.md) · [`.es`](operate.es.md) `#liveness-readiness-and-metrics`).
4. If the migration succeeded but the new server fails, **stop the stack, restore the snapshot, restart the prior image**. Do not attempt to mutate `cms_schema_migrations` to "skip" the failed upgrade — the markers are the contract.

There is no `pg_dump | psql` shortcut across versions: the schema and the named-volume snapshot move together or not at all.

## Authoring a new migration

When the team needs schema change, the file lands in the same pull request as the runtime change that depends on it. The canonical file structure is:

```text
NNNN_<short_slug>.sql
```

with a leading `-- =============================================================================` block that:

- Names the migration number and slug.
- States the **scope** of the change: which tables / indexes / triggers / functions are touched, and which are intentionally not touched.
- States the **idempotency notes**: forward-only, appended marker, bytes-immutable once applied.
- States any **rollback rationale** — i.e., why the change does not provide a `DOWN` SQL and what the snapshot + restore path looks like for it.
- Uses portable `pgcrypto` handling: `gen_random_uuid()` is in `pgcrypto` on PG < 13 and native on PG ≥ 13, so the `CREATE EXTENSION` call is wrapped in `DO / EXCEPTION WHEN OTHERS THEN NULL` ([`packages/storage/migrations/0001_governance.sql`](../../packages/storage/migrations/0001_governance.sql#L67-L78)).

Inside the file, every tenant-scoped row carries a `tenant_id` column. Every `UPDATE` on a governed table uses `version BIGINT NOT NULL DEFAULT 1` for optimistic concurrency. Every `BEFORE INSERT / UPDATE` policy lives in TypeScript so a single source of truth applies, not duplicated in SQL triggers. The append-only property of `cms_storage.audit_events` is the **only** table-level invariant enforced at the SQL layer; everything else is policy in `@cms/core` and `@cms/storage`.

## What was verified

The migration gate's contract — the `cms_schema_migrations` ledger, the `psql -v ON_ERROR_STOP=1 -1` invocation, the `service_completed_successfully` dependency, and the read-only mount — is read from the source files cited above. `docker compose -f compose.yaml config --quiet` was the only Docker-related command V1 ran; it validated substitution only, not a live daemon. A live `docker compose run --rm migrations`, `docker compose up -d server`, or `docker compose pull` is **not** part of V1 and is not claimed on this page. For deployment guidance, follow [`self-host.md`](self-host.md) · [`.es`](self-host.es.md) and [`../security/hardening.md`](../security/hardening.md) · [`.es`](../security/hardening.es.md). The on-disk evidence is limited to the cited source files and the seven-command report referenced from [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).

## Where to go next

- Day-2 operations: [`operate.md`](operate.md) · [`.es`](operate.es.md).
- Bring-up: [`self-host.md`](self-host.md) · [`.es`](self-host.es.md).
- Every `CMS_*` value and its parsing rule: [`configure.md`](configure.md) · [`.es`](configure.es.md).
- The seven-command workspace verification sequence: [`quickstart.md`](quickstart.md) · [`.es`](quickstart.es.md).
- The hosting-stack architecture (network and storage rationale): [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md).
- The content boundary and human authority model: [`../concepts/content-boundary.md`](../concepts/content-boundary.md) · [`.es`](../concepts/content-boundary.es.md).
- The verification report: `artifacts/g008/workspace-test-report.json`.
- Canonical SQL migrations: [`packages/storage/migrations/`](../../packages/storage/migrations/).
- Operator note: [`packages/server/migrations/README.txt`](../../packages/server/migrations/README.txt).
- Migrations service in compose: [`compose.yaml:102-140`](../../compose.yaml#L102-L140).
- Server migration dependency: [`compose.yaml:243-265`](../../compose.yaml#L243-L265).
- Append-only triggers: [`packages/storage/migrations/0001_governance.sql:578-612`](../../packages/storage/migrations/0001_governance.sql#L578-L612).
