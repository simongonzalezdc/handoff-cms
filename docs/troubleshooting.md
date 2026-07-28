# Troubleshooting

> [Versión en español](troubleshooting.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`README.md#same-pr-enes-zero-lag`](README.md#same-pr-enes-zero-lag).

This page is for the **operator** and **self-hoster** audiences. It maps the symptoms you can observe to the lifecycle state the proposal is in, lists the canonical problem codes for OIDC, configuration, media, and adapter failures, and points at the reconcile and rollback notes that close the loop. Nothing on this page is a claim about a live Docker daemon — the V1 verification report at `artifacts/g008/workspace-test-report.json` shows that only `docker compose -f compose.yaml config --quiet` was run, and the image was not built.

## Audience boundary

Handoff CMS has three operational roles. This page addresses the **agency operator** running a managed compose stack and the **self-hoster** running the full stack on a host they own. Adjacent audiences live on their own pages:

- The **author** who edits content through the OIDC-authenticated surface is covered by [`docs/how-to/authoring.md`](how-to/authoring.md) · [`.es`](how-to/authoring.es.md). The author never sees exit codes; the author sees UI states and stable `STORE_ERROR_CODES`.
- The **integrator** writing an adapter is covered by [`docs/reference/adapter-sdk.md`](reference/adapter-sdk.md) · [`.es`](reference/adapter-sdk.es.md).
- The **security reviewer** is covered by [`docs/security/reviewer-on-ramp.md`](security/reviewer-on-ramp.md) · [`.es`](security/reviewer-on-ramp.es.md), with the threat model and hardening guides linked there.

The lifecycle states, the canonical write beat, and the `rolled_back` terminal state are documented separately in [`docs/concepts/governance-and-human-authority.md`](concepts/governance-and-human-authority.md) · [`.es`](concepts/governance-and-human-authority.es.md) and in [`docs/concepts/content-boundary.md`](concepts/content-boundary.md) · [`.es`](concepts/content-boundary.es.md). The CLI and the API exit codes are documented in [`docs/reference/cli.md`](reference/cli.md) · [`.es`](reference/cli.es.md). The closed error-code unions are documented in [`docs/reference/error-codes.md`](reference/error-codes.md) · [`.es`](reference/error-codes.es.md). This page is intentionally the navigation entry that maps **symptom → lifecycle state → code → remediate**.

## How to read this page


The six sections below answer six questions:


1. **Symptoms to lifecycle states.** What the UI, the CLI, and the API show you when the proposal is in a particular state.
2. **OIDC and configuration failures.** What the closed `SERVER_CONFIG_ERROR_CODES` and `API_ERROR_CODES` say, and where in the runtime they originate.
3. **Media and adapter failures.** What the closed `STORE_ERROR_CODES` and the adapter checks say, and how to differentiate between a media upload problem and an adapter contract problem.
4. **Problem → CLI exit code navigation.** Which problem code maps to which CLI exit code, so a script can branch on the exit code without parsing the JSON body.
5. **Reconcile notes.** Reconcile notes including the absent `canonical_written + propagate → propagate_failed` edge and the deferred publication-owner schema limitation.
6. **Limitations.** What is not verified.

Each section is grounded in the source file that anchors the contract.

## 1. Symptoms to lifecycle states

The proposal state machine (`packages/core/src/state-machine.ts`) has exactly eighteen states, eleven actions, and one terminal state (`rolled_back`). The mapping from the bookkeeping states you can observe (`canonical_written`, `canonical_write` returned from the publish endpoint, deploy receipts reported asynchronously) to the proposal state is below.

### `canonical_written` and the publish beat

The publish endpoint returns `canonical_written` after the canonical bytes have been written to the host. This is **not** a claim that a remote site is live. The lifecycle is:

- `approved → applying → canonical_written` (publish transition).
- `canonical_written → propagating → live` (deploy-receipt pathway) **or** `canonical_written → write_failed` (a second canonical write failed; the proposal is recoverable).
- A failed deploy receipt leaves the proposal in `canonical_written`; the system does not silently invent an intermediate state. The receipt row is the authoritative failure record.

If the UI shows `canonical_written` for longer than expected, the deploy is either in flight or failed. Read the receipt table — `GET /v1/publications/{id}/deploy-receipts` or the equivalent CLI surface — and act on the receipt's status.

### `rolled_back` and the rollback terminal state

The rollback endpoint is a single compensating human-authorized action. It does not replay credentials or impersonate the original approver, and it does not push a synthetic "live" receipt. The governed adapter write boundary completes at `canonical_written`; the proposal lifecycle transitions to terminal `rolled_back` and is audited as `proposal.rolled_back`. Asynchronous deployment reconciliation follows the canonical write and reports separately if and when the served site catches up.

`rolled_back` is the only terminal state. `isTerminalState` (`packages/core/src/state-machine.ts:204-206`) returns `true` exclusively for `rolled_back`. After rollback, the proposal is final; subsequent attempts to act on it return `E_INVALID_TRANSITION`.

### `propagate_failed` and the absent transition

The state machine has **no direct** `canonical_written + propagate → propagate_failed` edge. There is no transition from `canonical_written` to `propagate_failed` in the `TRANSITIONS` table (`packages/core/src/state-machine.ts:100-128`). A failed deploy receipt recorded against a proposal in `canonical_written` does not move the proposal into `propagate_failed`; the proposal stays in `canonical_written`, and the deploy receipt row carries the failure reason. This is the canonical wording from the OpenAPI summary for `POST /v1/publications/{id}/deploy-receipts`.

When you see a `failed` deploy receipt and the proposal is still in `canonical_written`, the remediation is one of:

1. **Re-run the deploy.** Trigger a new deploy from the publication row; the proposal remains `canonical_written` until a terminal receipt arrives.
2. **Rollback.** Issue a governed rollback from the proposal; the proposal transitions to terminal `rolled_back` and the canonical bytes are reverted to the captured approval snapshot.
3. **Reconcile.** Issue a reconcile against the proposal; the proposal transitions to `reconciled` (or `reconcile_failed`). Reconcile is read-only; it does not write bytes.

The state machine is the authority for which transition is legal; the application service surrounding `transition()` validates the version, the actor, and the window before the pure transition.

### `reconcile_failed` and the storage alphabet

The core state `reconcile_failed` maps to the storage proposal state `reconcile_pending` (`packages/core/src/state-machine.ts:254-273`). The storage layer's CHECK constraint on `proposals.state` (`packages/storage/src/schema.ts:322`) accepts the storage alphabet (which includes `reconcile_pending`) and the core states that map to it; the `reconcile_pending` row is the persisted record that the proposal is awaiting a governed recovery decision. The audit envelope carries the original core state via the `event` payload, so the projection is recoverable.

If your query expects to see `reconcile_failed` in the storage row, the row will show `reconcile_pending` instead. The mapping is exact and total; the audit row is the recovery path.

### `rolled_back` versus `canonical_written`

The two are **not** the same beat. `canonical_written` is the canonical write beat: the proposal has been written to the host's `canonical_source` (`inventory/products.json` for the Cerafica reference adapter), and the publication row records `canonical_written_at`. `rolled_back` is the terminal state the proposal enters after a single compensating human-authorized action; the canonical bytes are reverted to the captured approval snapshot, and the proposal lifecycle is closed.

The Cerafica adapter mirrors this exactly: rollback writes canonical bytes and returns `canonical_written` (the adapter's deploy capability returns `canonical_written` after the rollback write; the proposal lifecycle separately records `rolled_back`). An asynchronous reconcile follows the canonical write and does not claim `live`. See `packages/adapter-cerafica/src/index.ts:1213-1238` and `packages/adapter-cerafica/src/index.ts:860-871`.

### Badge states vs literal states

The web authoring surface renders a closed set of badge states (`VisibleState` in `packages/web/src/model.ts:151-160`). The mapping is intentional and bounded:

| Badge | Core state | Notes |
| --- | --- | --- |
| `editing` | (draft, before any transition) | Not part of the persisted lifecycle. |
| `preview_ready` | `previewing` (transient) | The server-rendered preview succeeded. |
| `proposed` | `proposed` | The proposal has been submitted. |
| `approved` | `approved` | The proposal has been approved. |
| `canonical_written` | `canonical_written` | The canonical write beat. |
| `deploy_pending` | `canonical_written` (UI convenience) | No terminal receipt yet. |
| `live` | `live` | A terminal `succeeded` receipt. |
| `rolled_back` | `rolled_back` | Terminal. |
| `error` | any failure branch | The UI's recoverable error surface. |

If the UI badge disagrees with the API state, the API state is the authority. The badge is a render-time projection; the API state is the persisted cursor.

## 2. OIDC and configuration failures

### `SERVER_CONFIG_ERROR_CODES` (server startup)

The server is fail-closed at startup. The loader at `packages/server/src/config.ts` throws a `ServerConfigError` with a stable code from the closed union:

```ts
export const SERVER_CONFIG_ERROR_CODES = [
  'E_CONFIG_MISSING_REQUIRED',
  'E_CONFIG_INVALID_TYPE',
  'E_CONFIG_OUT_OF_RANGE',
  'E_CONFIG_INVALID_URL',
  'E_CONFIG_INVALID_LOG_LEVEL',
] as const;
```

The codes are anchored at `packages/server/src/config.ts:22-30`. The thrown error carries a `details` bag with the offending variable name; it never embeds secret values. The simplest first check is to read the `details` bag and match it against the `.env.example` inventory at the repository root.

Common remediation:

- `E_CONFIG_MISSING_REQUIRED` — a required `CMS_*` value is unset. Compose would catch this earlier with the `${VAR:?message}` substitution form for every secret (`compose.yaml:75`, `compose.yaml:115`, `compose.yaml:154-155`); the code only surfaces when the server starts in a non-compose context (for example, `node packages/server/dist/index.js`).
- `E_CONFIG_INVALID_URL` — `CMS_PUBLIC_URL`, `CMS_OIDC_ISSUER`, `CMS_OIDC_AUDIENCE`, `CMS_OIDC_JWKS_URL`, or `CMS_OBJECT_ENDPOINT` is malformed.
- `E_CONFIG_OUT_OF_RANGE` — a quota integer (`CMS_QUOTA_REQUEST_BYTES_CAP`, `CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE`) is out of range.
- `E_CONFIG_INVALID_LOG_LEVEL` — `CMS_LOG_LEVEL` is not in the allowed set.
- `E_CONFIG_INVALID_TYPE` — a parsed value does not match the expected type (for example, a non-integer where an integer is required).

### OIDC failures (request time)

The configured algorithm allow-list contains only asymmetric RS, ES, and PS variants; `none` and `HS*` are rejected by `ALLOWED_ALGORITHMS` and `parseAlgorithms` ([`packages/server/src/config.ts:246-284`](../packages/server/src/config.ts#L246-L284)). The closed `API_ERROR_CODES` reflect the OIDC failure surface in [`packages/api/src/problem.ts:35-56`](../packages/api/src/problem.ts#L35-L56):

| Code | Failure | Remediation |
| --- | --- | --- |
| `E_TOKEN_MISSING` | No `Authorization` header. | Add the bearer token. |
| `E_TOKEN_MALFORMED` | Token is not a parseable JWT or the required claims are missing. | Verify the OIDC issuer and the audience. |
| `E_TOKEN_EXPIRED` | `exp` is in the past. | Acquire a fresh token. |
| `E_TOKEN_AUDIENCE_MISMATCH` | `aud` does not match `CMS_OIDC_AUDIENCE`. | Verify the audience in the OIDC client configuration. |
| `E_UNAUTHORIZED` | Generic unauthorized fallback. | Check the verifier log for the underlying reason. |

The CLI maps `E_TOKEN_EXPIRED` to exit 77; `E_TOKEN_MISSING`, `E_TOKEN_MALFORMED`, `E_TOKEN_AUDIENCE_MISMATCH`, and `E_UNAUTHORIZED` use the generic `E_*` exit 2 mapping ([`packages/cli/src/index.ts:1071-1103`](../packages/cli/src/index.ts#L1071-L1103)). The same problem code remains in stderr JSON.

### Self-approval and service / MCP identity refused

The three privileged actions (`approve`, `publish`, `rollback`) are refused for service identities and for identities carrying the `mcp` capability before the policy engine runs (`packages/api/src/auth.ts:197-225`). The codes are exported from the core error union (`packages/core/src/domain.ts:86-114`):

- `E_SERVICE_APPROVAL_FORBIDDEN` — a service identity attempted an approval / publish / rollback. The CLI maps this to exit code 77.
- `E_MCP_APPROVAL_FORBIDDEN` — an MCP identity attempted the same. CLI exit code 77.
- `E_SELF_APPROVAL_FORBIDDEN` — self-approval is recorded explicitly (`selfApproved: true`) but is refused when policy does not allow it. CLI exit code 77.

The CLI's privileged-command gate ([`packages/cli/src/index.ts:773-801`](../packages/cli/src/index.ts#L773-L801)) requires a `delegated_human_fresh_interactive` session for approve, publish, rollback, and deploy reconciliation. Static `env_token`, `cli_service`, and `mcp_identity` credentials fail closed.

### Lifecycle refusals

The state machine refuses illegal transitions with `E_INVALID_TRANSITION` (`packages/core/src/domain.ts:108`). The CLI maps this to exit code 2. The thrown error carries the offending `from` state and the attempted `action`. The remediation is always state-dependent: rerun the command against the proposal's current state, or wait for the in-flight action to complete.

## 3. Media and adapter failures

### `STORE_ERROR_CODES` (web authoring surface)

The web authoring surface reports a closed set of UI-level error codes (`packages/web/src/model.ts:111-133`):

| Code | When | Remediation |
| --- | --- | --- |
| `E_BAD_BLOCK_ID` | The block id is not in the snapshot. | Refresh the page; the snapshot is stale. |
| `E_BAD_LOCALE` | The locale is not `en` or `es`. | Switch the language selector to a peer locale. |
| `E_BAD_INDEX` | A block move, duplicate, or insert target index is outside the snapshot bounds. | Refresh and repeat the block action with an index valid for the current snapshot. |
| `E_MISSING_ALT` / `E_EMPTY_ALT` / `E_MISSING_ALT_LOCALE` | Image alt text is missing or empty in one peer locale. | Fill the alt text in both locales. |
| `E_BAD_CROP` / `E_BAD_FOCAL` | The crop or focal-point values are out of the valid range. | Reset the crop; the model accepts a focal-point offset relative to the crop. |
| `E_BAD_BYTES` | The uploaded bytes failed the media pipeline's integrity check. | Re-upload the file; quarantine has logged the failure. |
| `E_SERVICE_APPROVAL_FORBIDDEN` / `E_MCP_APPROVAL_FORBIDDEN` | Service / MCP identity attempted an in-app privileged action. | Switch to a human OIDC session. |
| `E_NO_PROPOSAL` | The proposal was not created before the privileged action. | Create the proposal first. |
| `E_NOT_PREVIEW_READY` | The privileged action was attempted before the preview completed. | Run the preview; the action requires a `preview_ready` state. |
| `E_NOT_APPROVED` | Publish attempted on a non-approved proposal. | Approve the proposal first. |
| `E_NOT_LIVE` | Rollback attempted on a non-live proposal. | Rollback is allowed from `live` and `error`; check the visible state. |
| `E_NOT_DEPLOY_READY` | Reconcile attempted on a proposal with no in-flight deploy. | Reconcile is read-only; rerun only when a deploy is pending. |
| `E_NOT_REVERSIBLE` | Local undo depth exceeded. | Local undo is browser-local; ask the operator for a governed rollback. |
| `E_RECONCILE_FORBIDDEN` | Reconcile attempted from a state that does not permit it. | The model allows reconcile from `canonical_written`, `deploy_pending`, and `live`; check the state. |
| `E_FROZEN_BLOCK` | The block action was attempted on a frozen block. | Use the exposed block actions for the section. |
| `E_INVALID_SNAPSHOT` | The snapshot is inconsistent. | Refresh; the model re-creates the snapshot from the API. |
| `E_API_ERROR` | The API returned a non-2xx response. | Read the API problem code; the model surfaces it. |

### Media pipeline failures

The media pipeline at `packages/media/src/` is a pluggable `BlobStore` over the S3-compatible object store. The ICC is preserved, the EXIF is stripped, and the malware quarantine is fail-closed. The most common failure modes from the operator's perspective are:

- **Upload rejected by the browser.** The pipeline validates the byte stream before the parts are uploaded. The model surfaces the rejection as `E_BAD_BYTES`; the browser shows the byte error in the error region.
- **Upload accepted but quarantine failed.** The pipeline accepts the bytes for screening, but the screening rejects them. The model records the failure; the snapshot is unchanged. The remediation is to re-upload a non-quarantined file; the quarantine is operator-auditable.
- **Object store unreachable.** The MinIO service is unhealthy. The model surfaces the API error; the remediation is to restore the `minio` service health (see the [minio service healthcheck](https://min.io/docs/minio/linux/operations/monitoring/healthcheck-probes.html) for the official probe). The application's preset healthcheck is `mc ready local` after `mc alias` (`compose.yaml:160-166`).
- **Bucket policy drifted.** The `minio-init` one-shot creates the bucket and the bucket-scoped application user. If the operator edits the bucket policy outside the `minio-init` flow, the application user may lose a permission it needs (for example, `s3:PutObject` on its bucket). The remediation is to re-run `minio-init`; the policy is re-applied idempotently.

### Adapter failures

The adapter contract is the frozen invariant-bearing `canonical_source` / `derived_artifacts[]` / `regeneration_contract` triple. The adapter SDK's `binding.discover` returns a `discovery` report (`packages/adapter-sdk/src/index.ts`); the conformance harness exercises it (`packages/adapter-sdk/src/conformance.ts`). The most common failure modes from the operator's perspective are:

- **E_BAD_REGENERATION_MODE.** The binding's `regeneration_contract.mode` is not in the frozen allow-list (`alias_symlink` is the only mode frozen in V1). The check fires at activation; the binding is refused.
- **E_EMPTY_DERIVED_ARTIFACTS.** The `derived_artifacts[]` list is empty. The check fires at activation; the binding is refused.
- **E_AMBIGUOUS_BINDING.** The adapter cannot resolve a single canonical source. The check fires at activation; the binding is refused.
- **E_ABSOLUTE_PATH / E_ESCAPING_PATH / E_SELF_ALIAS / E_CYCLIC_ALIAS.** Repository confinement checks at activation. The binding is refused.
- **E_DERIVED_WRITE_FORBIDDEN.** A write attempt whose target is a derived artifact. The adapter refuses; the API surfaces the refusal.

The `deferred` publication-owner schema limitation is on the **reconcile** endpoint. The route at `packages/api/src/index.ts:637-682` requires a current human authority. A tighter publication-owner binding is an explicit integration blocker: the storage schema must grow a `publication_owner_actor_id` column and a corresponding `IdentityResolver.loadPublicationOwner` hook before per-publication ownership can be enforced. The hook is the same one used for the per-publication ownership check on approve / publish / rollback. The blocker is recorded in `artifacts/g009/inventory-findings.json` finding `API-DEPLOY-AUTHORITY-BINDING`. The reconciliation route therefore accepts **any** current human identity until the storage migration lands; the route is not a per-publication write authority.

## 4. Problem → CLI exit code navigation

The CLI maps problem codes to exit codes (`packages/cli/src/index.ts:1071-1100`). The mapping is closed and integer-valued; a script can branch on the exit code without parsing the JSON body.

| Exit code | Meaning | Problem codes |
| --- | --- | --- |
| `1` | Unexpected error | Unrecognized non-`E_*` problem codes without a specific mapping. |
| `2` | Not found / generic problem | `not_found`, `E_*` codes without a specific mapping. |
| `3` | Network failure | `connection_failed`, or fetch / network / ENOTFOUND / ECONN message strings. |
| `4` | Conflict | `E_OPTIMISTIC_CONCURRENCY_CONFLICT`, `optimistic_concurrency_conflict`, `idempotency_replay_mismatch`, `idempotency_in_progress`. |
| `64` | Usage error | Local CLI argument parsing. |
| `65` | Validation error | `E_BAD_REQUEST`, `invalid_input`. |
| `77` | Authorization failure | `E_SERVICE_APPROVAL_FORBIDDEN`, `E_MCP_APPROVAL_FORBIDDEN`, `E_TOKEN_KIND_FORBIDDEN`, `E_INTERACTIVE_AUTH_REQUIRED`, `E_TENANT_MISMATCH`, `E_TOKEN_EXPIRED`, `E_INVALID_IDENTITY`, `E_TENANT_FORBIDDEN`, `E_INSUFFICIENT_AUTHORITY`, `E_ACTION_FORBIDDEN`, `E_SELF_APPROVAL_FORBIDDEN`. |

The CLI's `cliErrorToExitCode` for the local error categories (`packages/cli/src/index.ts:1137-1157`) is the same shape: `usage` → 64, `credential_forbidden` → 77, `network` → 3, `problem` → 2, `conflict` → 4, `not_found` → 2, `validation` → 65, `unexpected` → 1.

The CLI preserves the wire shape of the API problem (`packages/cli/src/index.ts:1020-1038`). A script that wants to log the `code` and `traceId` can read the stderr problem JSON instead of branching on the exit code.

## 5. Reconcile notes

The reconcile action is a **read-only** check. It re-runs alias verification and the canonical hash check; it does not write. `apply` is canonical-only and refuses to run before reconcile has observed the latest canonical state (`packages/adapter-sdk/src/index.ts:33-44`). The cerafica adapter enforces this on top: apply writes the canonical `inventory/products.json`; reconcile re-verifies the alias and the hash and reports state, never bytes (`packages/adapter-cerafica/src/index.ts:11-24`).

Three reconcile-related notes are worth restating:

- **Reconcile does not write bytes.** It records a successful reconciliation or an explicit reconciliation failure. The proposal advances to `reconciled` (success) or to `reconcile_failed` (failure). A reconverge that fails leaves the proposal in `reconcile_failed`; the audit row records the reason.
- **The deferred publication-owner schema limitation.** The reconcile endpoint requires a current human identity. Per-publication ownership is an explicit integration blocker: the storage schema must grow a `publication_owner_actor_id` column and a corresponding `IdentityResolver.loadPublicationOwner` hook before per-publication ownership can be enforced. Until the migration lands, the route accepts any current human identity. The blocker is in `artifacts/g009/inventory-findings.json` finding `API-DEPLOY-AUTHORITY-BINDING` and is also reflected in the OpenAPI summary for `reconcileProposal`.
- **The `canonical_written + propagate → propagate_failed` edge is intentionally absent.** There is no direct transition from `canonical_written` to `propagate_failed` in the state machine (`packages/core/src/state-machine.ts:100-128`). A failed deploy receipt leaves the proposal in `canonical_written`; the deploy receipt row is the authoritative failure record. The proposal does not silently traverse an intermediate `propagating` state it never visited.

## 6. Limitations

- **No Docker daemon-backed build or runtime.** The Compose configuration is validated by interpolation only; the container image was not built and the server was not run inside Docker. The codes and the lifecycle states above are the application's behavior; running them against a live container is operator-managed.
- **No second adapter.** The Cerafica reference adapter is the only adapter in V1. The adapter failure modes are the Cerafica-specific failures; a second adapter introducing a new `canonical_source` backend is the v1.1 conformance gate.
- **External participant validation is v1.1.** The product is described as "neurodivergent-accessible by design" in the i18n catalog; external validation is not in V1.

## Where to go next

- Concept pages: [`docs/concepts/governance-and-human-authority.md`](concepts/governance-and-human-authority.md) · [`.es`](concepts/governance-and-human-authority.es.md), [`docs/concepts/content-boundary.md`](concepts/content-boundary.md) · [`.es`](concepts/content-boundary.es.md).
- Authoring guide: [`docs/how-to/authoring.md`](how-to/authoring.md) · [`.es`](how-to/authoring.es.md).
- Self-host and configuration: [`docs/how-to/self-host.md`](how-to/self-host.md) · [`.es`](how-to/self-host.es.md), [`docs/how-to/configure.md`](how-to/configure.md) · [`.es`](how-to/configure.es.md).
- Backup and restore: [`docs/how-to/backup-restore.md`](how-to/backup-restore.md) · [`.es`](how-to/backup-restore.es.md).
- Reference: [`docs/reference/api.md`](reference/api.md) · [`.es`](reference/api.es.md), [`docs/reference/cli.md`](reference/cli.md) · [`.es`](reference/cli.es.md), [`docs/reference/error-codes.md`](reference/error-codes.md) · [`.es`](reference/error-codes.es.md).
- Glossary: [`docs/project/glossary.md`](project/glossary.md) · [`.es`](project/glossary.es.md).
- Verification report: `artifacts/g008/workspace-test-report.json`.
