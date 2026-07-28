# Architecture

Handoff CMS is a pnpm workspace organized as a one-way dependency graph. The host repository remains the canonical source; the system validates proposals, records human decisions, writes canonical bytes, and coordinates projections.

## Dependency DAG

```text
@cms/core  ───────────────► @cms/storage
     │                            │
     └──────────────► @cms/api ◄──┘
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
          @cms/cli       @cms/mcp     @cms/server
             │              │              │
             └────── HTTP/handle ──────────┘

@cms/adapter-sdk ─► host adapters (for example @cms/adapter-cerafica)
@cms/audit       ─► API/audit integration
```

`@cms/core` owns domain types, invariants, policy, and the proposal state machine. `@cms/storage` persists the core records and migrations. `@cms/api` is the authoritative Hono/OpenAPI transport over those packages; it does not reimplement policy or state transitions. The CLI and MCP packages are clients/projections of that API (or its `handle` seam), never alternate authority surfaces. The server package supplies runtime configuration/auth and mounts the API. Adapter SDK contracts are implemented by host adapters; adapters resolve host paths and perform host-side writes, but do not own governance authority. Audit provides canonical, signed audit-event structures.

## Transport and authority boundaries

All web, CLI, and MCP mutations enter through `@cms/api`. Every write is tenant-scoped and idempotent; approve, publish, rollback, and reconcile additionally use optimistic `If-Match` checks. The API authenticates and resolves the actor before calling the single authorization facade. Core policy and state-machine decisions remain in `@cms/core`; persistence remains in `@cms/storage`.

The host's `canonical_source` is the only write target. `derived_artifacts` are served projections and are never written directly. `reconcile` is read-only and must observe current canonical state before `apply`; `apply` is canonical-only. Regeneration follows the explicit `alias_symlink` contract. A deployment receipt reports propagation only: `canonical_written` and `live`/`live_propagated` are distinct states. A failed receipt leaves the proposal at `canonical_written`; it does not silently invent an intermediate state.

Adapters are write surfaces, not authority surfaces. Their deploy capability is advisory and coordinator-gated; an adapter, agent, service, or MCP path cannot approve, publish, or roll back. Commerce fields remain coordinator-gated and client-read-only. No transport silently falls back to another source, and missing `en` or `es` values are rejected rather than defaulted.

## Evidence

- `packages/core/src/domain.ts`, `policy.ts`, `state-machine.ts`
- `packages/storage/src/index.ts`, `migrations/0001_governance.sql`
- `packages/api/src/index.ts`, `auth.ts`, `openapi.ts`
- `packages/cli/src/index.ts`; `packages/mcp/src/server.ts`; `packages/server/src/index.ts`
- `packages/adapter-sdk/src/index.ts`; `packages/adapter-cerafica/src/index.ts`
- `packages/audit/src/index.ts`
