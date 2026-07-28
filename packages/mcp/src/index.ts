/**
 * @cms/mcp — entry point.
 *
 * Re-exports the deterministic injectable server and authority types.
 * No policy or state-machine logic lives here; every authoritative
 * decision is delegated to the API.
 */

export {
  ALLOWED_RESOURCE_URIS,
  ALLOWED_TOOL_NAMES,
  McpAuthorityError,
  McpServer,
  type AllowedResourceUri,
  type AllowedToolName,
  type McpMessage,
  type McpRequest,
  type McpResourceDescriptor,
  type McpResponse,
  type McpServerOptions,
  type McpToolDescriptor,
} from './server.js';
