@cms/server — migrations operator notes (concise)

Source of truth
---------------
The canonical SQL migrations live inside the workspace at:

    packages/storage/migrations/

The Compose distribution owns a one-shot `migrations` service. It reads
these canonical files read-only, records each applied filename in
`cms_schema_migrations`, and applies each new file plus its marker in one
Postgres transaction.

Apply commands
--------------
1. Snapshot the Postgres and MinIO volumes before upgrading.

2. Validate and start the stack:

       docker compose config
       docker compose up -d

   Compose waits for Postgres health, runs `migrations` to successful
   completion, creates the private MinIO bucket, and only then starts
   `server`. A failed SQL statement rolls back its migration transaction
   and prevents the server from starting.

3. Inspect migration state when diagnosing an upgrade:

       docker compose run --rm migrations

   Already-recorded filenames are skipped. Never rename an applied file
   or modify its bytes after release; add a new ordered SQL file instead.

Ordering rule
-------------
- First boot: Postgres healthy, migrations complete, then server starts.
- Upgrade: snapshot volumes, pull/build, run the one-shot migration gate,
  then start the new server image.
- NEVER bypass the `migrations: service_completed_successfully` dependency
  or boot `server` against a half-applied migration set.

Backup / restore boundary
-------------------------
- Governance data is APPEND-ONLY by design (audit_events refuses
  UPDATE/DELETE/TRUNCATE via trigger; idempotency_records has CHECK-
  guarded transitions). DOWN migrations are intentionally NOT provided.
- Recovery is via snapshot + restore OR upstream replay, not via DOWN.
- Snapshot the postgres volume before the migration gate and before bumping
  the server image. Treat the postgres named volume as the source of
  truth for governance history.
- The MinIO bucket holds governed blobs (canonical + derived). Snapshot
  its named volume alongside the database; backups must be consistent
  across both stores or atomic replay is unsafe.

Role split
----------
- Managed operator (agency / developer): owns the compose stack, the
  network, volumes, environment/secrets, OIDC issuer (or its hosted
  instance), Postgres, MinIO, bucket lifecycle, and schema upgrades.
  Runs and monitors the one-shot `migrations` service, reads redacted boot
  diagnostics, and approves deploys. Rotates `CMS_OIDC_*`,
  `CMS_OBJECT_ACCESS_KEY_ID` / `CMS_OBJECT_SECRET_ACCESS_KEY`, and the
  Postgres password on the operator's own schedule.
- Author client (non-technical): authenticates via the OIDC issuer
  configured by the operator, authors proposals / revisions / media via
  the CMS API, and consumes canonical content through adapters. The
  client NEVER touches Postgres, MinIO, the `server` container, the
  `.env` file, or the compose stack. If the client needs schema change,
  a new region binding, a new adapter, or a new bucket policy, those
  are managed-operator work tickets.

PII / observability
-------------------
The server emits PII-free structured JSON to stdout, `/health/live`,
`/health/ready`, and Prometheus-format `/metrics`. The managed operator
must keep those endpoints from being exposed beyond the trusted network.

License
-------
Apache-2.0. No proprietary / managed-service dependency is required at
runtime; the bootstrap is fully Apache-2.0.
