# CLI reference

The CLI is a thin projection over the authoritative HTTP API. It never mutates the host directly; every operation becomes an API request and the host remains canonical.

## Commands (exactly nine)

| Command | Alias | Privilege |
| --- | --- | --- |
| `help` | `--help` | no |
| `health` | — | no |
| `proposal get <id>` | `proposals get <id>` | no |
| `proposal create` | `proposals create` | no |
| `proposal approve <id>` | `proposals approve <id>` | privileged |
| `proposal publish <id>` | `proposals publish <id>` | privileged |
| `proposal rollback <id>` | `proposals rollback <id>` | privileged |
| `proposal deploy status <id>` | `proposals deploy status <id>` | no |
| `proposal deploy reconcile <id>` | `proposals deploy reconcile <id>` | privileged |

Source inventory: `COMMANDS` and `PRIVILEGED_COMMANDS` in [`packages/cli/src/index.ts:385-403`](../../packages/cli/src/index.ts#L385-L403).

The four privileged commands are approval, publication, rollback, and deploy reconciliation. Privileged execution requires a **fresh delegated-human interactive session**. Environment tokens, service credentials, MCP identities, and stale/expired sessions cannot authorize these commands. The device flow opens the configured verification URI and validates tenant, audience, and expiry before sending the request; the default browser seam denies interactive authorization unless an application injects an approved seam.

`proposal create` accepts a JSON object from `--file <path>` or `--data '<json>'`. Files are read locally as UTF-8 JSON; directories, missing files, and malformed JSON are rejected. When both options are present, `--file` takes precedence and `--data` is ignored; pass only one to avoid ambiguous operator intent. The CLI requires a top-level `proposal` object and derives the HTTP method and path exclusively from the command; the API validates the full body shape. Use `--expect-version` for optimistic concurrency and an idempotency key where required by the API. Deployment reconciliation accepts only a boolean success result.

## Errors and exit status

The CLI exposes exactly eight `CliErrorCode` values: `usage`, `credential_forbidden`, `network`, `problem`, `unexpected`, `conflict`, `not_found`, and `validation` ([source](../../packages/cli/src/index.ts#L179-L188)). They map to exits 64, 77, 3, 2, 1, 4, 2, and 65 respectively in [`cliErrorToExitCode`](../../packages/cli/src/index.ts#L1137-L1165). RFC 9457 problem responses retain their `type`, `title`, `status`, `detail`, `instance`, `code`, `locale` (`en` or `es`), and extensions. API problem codes map bad input to 65, forbidden/invalid authority to 77, not-found to 2, concurrency/idempotency conflicts to 4, and connection failure to 3; unknown `E_*` codes exit 2 and other unknown problems exit 1 ([`exitCodeForProblem`](../../packages/cli/src/index.ts#L1071-L1135)).

## Configuration and output

The base URL, tenant, locale, output mode, expected version, and credentials are resolved from flags, environment, and explicit configuration. Human output is localized to English or Spanish; machine output preserves structured JSON. `--locale` overrides `CMS_LOCALE`; if both are absent, the CLI defaults explicitly to `en`. Values outside `en` and `es` fail with a usage error rather than silently substituting the other peer ([source](../../packages/cli/src/index.ts#L663-L671)).

The CLI does not approve, publish, or roll back through an agent identity. A human performs those privileged transitions; rollback may occur after the canonical write beat while the proposal terminal state is `rolled_back`.
