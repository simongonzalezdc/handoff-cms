# Quickstart

> [Versión en español](quickstart.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

This page is the operator-facing seven-command verification sequence recorded in `artifacts/g008/workspace-test-report.json` at `2026-07-27T21:18:49.543Z`. The seven verified commands are reproduced without additions or omissions; the required, unverified installation prerequisite is documented separately below.

## Prerequisites

The bring-up assumes a single host with the following toolchain pinned by the workspace manifest:

- **Node.js ≥ 22.0.0.** Pinned in `package.json` under `engines.node`. The Docker image pins `NODE_VERSION=22.20.0` (`Dockerfile` ARG).
- **pnpm ≥ 9.0.0.** Pinned in `package.json` under `engines.pnpm`. The Docker image pins `PNPM_VERSION=9.15.0` (`Dockerfile` ARG). The package manager declaration is `packageManager: pnpm@9.15.0`.

The lockfile (`pnpm-lock.yaml`) is the source of truth for the workspace dependency graph. `pnpm install` is required to materialize the workspace before the verification commands run; this is a required preparation step **not** included in the seven verified commands below. The evidence report assumes a single install at the start and does not re-run install between the commands.

## Environment

The workspace ships a `.env.example` placeholder at the project root. Copy it to `.env` and replace the placeholder values only — never hard-code a real secret into a tracked file:

```text
CMS_POSTGRES_PASSWORD=replace-with-a-strong-database-password
CMS_MINIO_ROOT_PASSWORD=replace-with-a-strong-minio-root-password
CMS_OBJECT_SECRET_ACCESS_KEY=replace-with-a-distinct-strong-application-secret
```

Treat `.env.example` as the complete, authoritative variable inventory. Replace every `replace-with-*` placeholder, including the password embedded in `CMS_DATABASE_URL`; preserve the distinct MinIO root and application credentials. Do not infer required variables from this quickstart. Server configuration fails closed when required `CMS_*` values are missing or malformed.

## The seven verified commands

The seven commands below are the literal command set from the V1 verification report. Run them in order from the project root. They are deterministic verification commands and safe to re-run.

1. **TypeScript type check across the workspace.**

   ```sh
   pnpm typecheck
   ```

   Verified scope: 13 package projects.

2. **Unit tests across the workspace.**

   ```sh
   pnpm test
   ```

   Verified scope: 27 test files, 899 tests.

3. **Workspace build.**

   ```sh
   pnpm build
   ```

   Verified scope: 13 package projects.

4. **Licensing guard.** The Apache-2.0 allowlist guard scans the workspace and refuses to ship a release that violates the open-core license boundary.

   ```sh
   node packages/licensing-guard/dist/index.js --root . --json
   ```

   Verified scope: 14 packages, 0 findings. The guard admits the documented dev-only MPL-2.0 exception for the `axe-core` test tooling; the runtime artifact graph does not include the exception.

5. **End-to-end browser journey.**

   ```sh
   pnpm test:e2e
   ```

   Verified scope: 6 projects (desktop/tablet/mobile Chromium × en/es), 0 axe violations, `CLEAN` Tastecheck verdicts. Browser artifacts are written to `artifacts/g008/{desktop,tablet,mobile}/handoff-beat-{en,es}.{json,png}`.

6. **Compose configuration validation.**

   ```sh
   docker compose -f compose.yaml config --quiet
   ```

   This step validates the Compose interpolation and does not require a running Docker daemon. The verified run used non-secret validation-only substitutions. A live Docker daemon-backed build/run is **not** part of the V1 verification — see the limitations section below.

7. **Self-host healthcheck script syntax check.**

   ```sh
   node --check scripts/self-host-healthcheck.mjs
   ```

   The healthcheck itself is invoked from the `server` container at runtime; this command only verifies the script parses.

## Verified evidence

The verified report at `artifacts/g008/workspace-test-report.json` records the seven commands verbatim, the verified-at timestamp, and the V1 limitations. The browser evidence files under `artifacts/g008/{desktop,tablet,mobile}/` record the per-locale accessibility tree, the axe results, the Tastecheck verdicts, and the full-page screenshots.

## Limitations

The V1 verification is honest about what it did not do:

- **No Docker daemon-backed build or runtime.** The Compose configuration was validated with interpolation only; the container image was not built and the server was not run inside Docker. The runtime package tests and the healthcheck syntax check cover the application layer, not the container layer.
- **No external neurodivergent participant validation.** The product is described as “neurodivergent-accessible by design” in the i18n catalog. External validation is a v1.1 goal and is not in V1.
- **No second independent adapter.** A second adapter is the v1.1 contract-validation gate, not a V1 completion claim.

## Where to go next

- Concept pages: [`../concepts/architecture.md`](../concepts/architecture.md) · [`.es`](../concepts/architecture.es.md), [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.md) · [`.es`](../concepts/governance-and-human-authority.es.md), [`../concepts/handoff-beat.md`](../concepts/handoff-beat.md).
- Authoring guide: [`authoring.md`](authoring.md) · [`.es`](authoring.es.md).
- Accessibility statement: [`../accessibility/statement.md`](../accessibility/statement.md) · [`.es`](../accessibility/statement.es.md).
- Glossary: [`../project/glossary.md`](../project/glossary.md) · [`.es`](../project/glossary.es.md).
- Verification report: `artifacts/g008/workspace-test-report.json`.
