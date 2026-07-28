# MCP reference

The MCP server is a constrained projection over the authoritative API. Protocol version: **2024-11-05**. It does not provide an agent mutation path: the host remains canonical and MCP identities are read/proposal-only.

## Exact interface inventory

### Five tools

| Tool | API operation | Effect |
| --- | --- | --- |
| `proposeEdit` | `POST /v1/proposals` | Creates a proposal in `proposed`; a human must approve it. |
| `suggestAltText` | `GET /v1/proposals/{id}` | Returns an alt-text suggestion; does not mutate the proposal. |
| `suggestCrop` | `GET /v1/proposals/{id}` | Returns a focal/crop suggestion; does not mutate the proposal. |
| `generatePreview` | `GET /v1/proposals/{id}` | Derives a preview; never advances approval, publication, or deploy state. |
| `submitApprovalRequest` | `GET /v1/proposals/{id}` | Signals readiness for an out-of-band human; does not transition state and never calls approve, publish, or rollback. |

### Two resources

| URI | API operation | Purpose |
| --- | --- | --- |
| `proposal://{id}` | `GET /v1/proposals/{id}` | Read one proposal row. |
| `health://` | `GET /v1/health` | Liveness probe. |

The inventory is closed: registration and invocation accept only these five tool names and two resource URIs. There are no approve, publish, apply, deploy, or rollback tools, and MCP cannot call those transitions indirectly.

Source inventory: [`ALLOWED_TOOL_NAMES` and `ALLOWED_RESOURCE_URIS`](../../packages/mcp/src/server.ts#L152-L165); the protocol version is returned by the initialize handler at [`server.ts:515`](../../packages/mcp/src/server.ts#L515).

## Name and argument firewall

Tool names are normalized case-insensitively after collapsing dashes, underscores, whitespace, slashes, dots, and colons. Empty names and every forbidden spelling or alias are rejected both at registration and call time. The forbidden set includes approval/publication/application/deployment/rollback names and force/admin/bypass/override/sign variants, arbitrary HTTP/request/proxy/fetch/exec/run/invoke/send names, and proposal patch/transition names.

Tool arguments are validated as plain objects. The server rejects keys that could override the descriptor or smuggle a transition, including `method`, `path`, `url`, `endpoint`, `target`, `action`, `op`, `operation`, `verb`, `route`, `request`, `raw`, `override`, `bypass`, `force`, `patch`, `transition`, `forward`, `proxy`, `exec`, `run`, `invoke`, `http`, `fetch`, `send`, `approver`, `approve`, `publish`, `apply`, `rollback`, `deploy`, and `ifmatch` variants. The API method and path always come from the closed descriptor; caller-supplied routing or action data is never honored.

The argument-key firewall is the closed `FORBIDDEN_ARG_KEYS` set at [`packages/mcp/src/server.ts:261-295`](../../packages/mcp/src/server.ts#L261-L295).

Approval is delegated to a human outside MCP. Commerce and other privileged effects therefore remain coordinator-gated; reconciliation is asynchronous and observable through the canonical API rather than an MCP mutation tool.
