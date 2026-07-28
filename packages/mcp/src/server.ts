/**
 * @cms/mcp — thin MCP projection over the @cms/api authority surface.
 *
 * The MCP server is a deterministic, injectable transport. It does not
 * own policy or state-machine logic; every authoritative decision is
 * delegated to the API. It does not touch storage, the policy engine,
 * or the audit module directly.
 *
 * Authority contract enforced by this module (fail-closed):
 *
 *   1. The tool and resource registries are the only surface a client
 *      can address. Names not in those registries are rejected before
 *      any network I/O.
 *
 *   2. The exposed tool set is a fixed closed union: `proposeEdit`,
 *      `suggestAltText`, `suggestCrop`, `generatePreview`,
 *      `submitApprovalRequest`. The exposed resource set is a fixed
 *      closed union of read-only resources backed by `/v1` GET routes.
 *      Adding a new entry is a code change in this file.
 *
 *   3. The following names are NEVER exposed, regardless of how a
 *      caller frames the request:
 *        - `approve`, `publish`, `apply`, `rollback`
 *        - aliases or near-spellings (`approves`, `publishProposal`,
 *          `rollBack`, `APPROVE`, `doApprove`, `forceApprove`,
 *          `requestApproval`, `signApproval`, `applyProposal`,
 *          `deploy`, `forcePublish`, `signPublish`, `adminApprove`,
 *          `adminPublish`, `adminRollback`, `bypass`,
 *          `executeRequest`, `httpRequest`, `proxyRequest`,
 *          `arbitraryRequest`, `rawFetch`, `sendRequest`,
 *          `forwardRequest`, `submitApproval`, `requestPublish`,
 *          `requestRollback`, `requestApply`).
 *      The full forbidden list is captured in
 *      `FORBIDDEN_TOOL_NAMES` and matched case-insensitively after
 *      collapsing common separators.
 *
 *   4. Tool arguments are never interpreted as a method/path/URL
 *      pointing at the authority surface. Every call to the API is
 *      issued from a fixed, registered `callApi` function with a
 *      constant method and path that match the registered tool's
 *      declaration. Crafted arguments that try to encode
 *      `method: 'POST'`, `path: '/v1/.../approve'`,
 *      `url: 'https://api/.../publish'`, `action: 'approve'`,
 *      `targetState: 'approved'`, `op: 'publish'`, `op: 'apply'`,
 *      `op: 'rollback'`, or any override of the registered `method`
 *      or `path` are rejected at argument-validation time and never
 *      forwarded to the API.
 *
 *   5. `submitApprovalRequest` signals readiness / creates an approval
 *      opportunity for an out-of-band human. It does not call
 *      `/v1/proposals/:id/approve`, `/publish`, or `/rollback`; it
 *      does not transition approval state.
 *
 *   6. MCP- and service-token seams are present (`Authorization`
 *      and `X-Tenant-Id` are forwarded); the server does not grant
 *      the calling identity any authority it does not already have.
 *      The API remains the sole policy and authority gate.
 *
 *   7. Tenant (`X-Tenant-Id`), localization (`Accept-Language`),
 *      idempotency (`Idempotency-Key`), and Problem Details
 *      (`application/problem+json`) are forwarded unchanged. Errors
 *      from the API pass through as Problems.
 */

import { createHash, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public contract types
// ---------------------------------------------------------------------------

/**
 * The minimal subset of the MCP wire types this server emits and
 * consumes. We model the MCP request/response shape directly rather
 * than depending on `@modelcontextprotocol/sdk` so the projection is
 * the only authority surface (MCP SDK can wrap this without
 * re-implementing it).
 */
export interface McpRequest {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface McpResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type McpMessage = McpRequest | McpResponse;

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  /** Constant API method this tool is allowed to issue. */
  readonly apiMethod: 'GET' | 'POST';
  /** Constant API path template this tool is allowed to hit. */
  readonly apiPath: string;
  /**
   * Names of well-known argument keys whose value, if present, is
   * forbidden from encoding a method/path/url/action/op override.
   * The tool's argument validator rejects them; the API call uses
   * the descriptor's own `apiMethod` and `apiPath` only.
   */
  readonly forbiddenArgKeys: readonly string[];
}

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
  /** Constant API path this resource is allowed to GET. */
  readonly apiPath: string;
}

export interface McpServerOptions {
  /**
   * The API base URL. The path component of every request is built
   * from a registered descriptor, never from a caller's argument.
   */
  readonly apiBaseUrl: string;
  /** Bearer token seam for the MCP/service identity. */
  readonly serviceToken: string;
  /** Tenant id seam. */
  readonly tenantId: string;
  /** Optional locale seam; defaults to 'en'. */
  readonly locale?: 'en' | 'es';
  /**
   * Injectable fetch (e.g. for tests). Defaults to the global fetch.
   * The server never calls any other I/O surface; storage, audit,
   * core, and policy are not reached from here.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Idempotency key generator. Defaults to a v4 uuid. Tests inject
   * a deterministic generator.
   */
  readonly idempotencyKeyGenerator?: () => string;
  /**
   * Optional clock for trace ids. Defaults to a wall clock.
   */
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Authority: closed union of allowed tool names.
// ---------------------------------------------------------------------------

export const ALLOWED_TOOL_NAMES = [
  'proposeEdit',
  'suggestAltText',
  'suggestCrop',
  'generatePreview',
  'submitApprovalRequest',
] as const;
export type AllowedToolName = (typeof ALLOWED_TOOL_NAMES)[number];

export const ALLOWED_RESOURCE_URIS = [
  'proposal://{id}',
  'health://',
] as const;
export type AllowedResourceUri = (typeof ALLOWED_RESOURCE_URIS)[number];

// ---------------------------------------------------------------------------
// Authority: explicit closed list of forbidden tool names. Any of
// these names — case-insensitive, after collapsing common separators
// — is rejected at registration time AND at call time. Adding a
// forbidden alias requires a code change in this file; the test
// enumerates the list.
// ---------------------------------------------------------------------------

const RAW_FORBIDDEN_TOOL_NAMES: readonly string[] = [
  'approve',
  'publish',
  'apply',
  'rollback',
  'deploy',
  'forceapprove',
  'forcepublish',
  'forceapply',
  'forcerollback',
  'forcedeploy',
  'adminapprove',
  'adminpublish',
  'adminapply',
  'adminrollback',
  'admindeploy',
  'bypass',
  'override',
  'overridepolicy',
  'signapproval',
  'signpublish',
  'signrollback',
  'requestapproval',
  'requestpublish',
  'requestrollback',
  'requestapply',
  'requestdeploy',
  'submitapproval',
  'submitpublish',
  'submitrollback',
  'submitapply',
  'submitdeploy',
  'approves',
  'publishes',
  'applies',
  'rollbacks',
  'deploys',
  'approveproposal',
  'publishproposal',
  'applyproposal',
  'rollbackproposal',
  'deployproposal',
  'http',
  'fetch',
  'request',
  'proxyrequest',
  'arbitraryrequest',
  'rawfetch',
  'sendrequest',
  'forwardrequest',
  'executerequest',
  'send',
  'proxy',
  'exec',
  'run',
  'invoke',
  'doapprove',
  'dopublish',
  'doapply',
  'dorollback',
  'dodeploy',
  'patchproposal',
  'transitionproposal',
];

function normalizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_\s/.:]+/g, '');
}

function isForbiddenToolName(name: string): boolean {
  const normalized = normalizeToolName(name);
  if (normalized === '') return true;
  for (const raw of RAW_FORBIDDEN_TOOL_NAMES) {
    if (normalizeToolName(raw) === normalized) return true;
  }
  return false;
}

/**
 * Build the closed set of forbidden argument keys — keys a caller
 * might try to use to sneak a method/path/url/action override past
 * the descriptor. The validator rejects these keys; the API call uses
 * only the descriptor.
 */
const FORBIDDEN_ARG_KEYS: ReadonlySet<string> = new Set<string>([
  'method',
  'path',
  'url',
  'endpoint',
  'target',
  'action',
  'op',
  'operation',
  'verb',
  'route',
  'request',
  'raw',
  'override',
  'bypass',
  'force',
  'forcepath',
  'forcemethod',
  'patch',
  'transition',
  'forward',
  'proxy',
  'exec',
  'run',
  'invoke',
  'http',
  'fetch',
  'send',
  'approver',
  'approve',
  'publish',
  'apply',
  'rollback',
  'deploy',
  'ifmatch',
  'if_match',
  'if-match',
]);

const TOOL_DESCRIPTORS: Readonly<Record<AllowedToolName, McpToolDescriptor>> = {
  proposeEdit: {
    name: 'proposeEdit',
    description:
      'Propose a content or asset edit. The proposal is created in the `proposed` state and awaits human approval. Service and MCP identities may propose; they may not approve.',
    apiMethod: 'POST',
    apiPath: '/v1/proposals',
    forbiddenArgKeys: [...FORBIDDEN_ARG_KEYS],
  },
  suggestAltText: {
    name: 'suggestAltText',
    description:
      'Produce a suggested alt-text delta for an existing proposal without mutating it. Suggestions are returned to the caller; the proposal itself is unchanged until a human proposes it through `proposeEdit`.',
    apiMethod: 'GET',
    apiPath: '/v1/proposals/{id}',
    forbiddenArgKeys: [...FORBIDDEN_ARG_KEYS],
  },
  suggestCrop: {
    name: 'suggestCrop',
    description:
      'Produce a suggested focal/crop delta for an existing proposal without mutating it. Suggestions are returned to the caller; the proposal itself is unchanged until a human proposes it through `proposeEdit`.',
    apiMethod: 'GET',
    apiPath: '/v1/proposals/{id}',
    forbiddenArgKeys: [...FORBIDDEN_ARG_KEYS],
  },
  generatePreview: {
    name: 'generatePreview',
    description:
      'Generate a preview from a proposed edit by reading the proposal snapshot. Previews are derived from the proposal payload; they do not advance approval, publication, or deploy state.',
    apiMethod: 'GET',
    apiPath: '/v1/proposals/{id}',
    forbiddenArgKeys: [...FORBIDDEN_ARG_KEYS],
  },
  submitApprovalRequest: {
    name: 'submitApprovalRequest',
    description:
      'Signal readiness and create an approval opportunity for a human to act out-of-band. This call does NOT transition approval state and NEVER calls approve / publish / rollback. The API returns the proposal row so the caller can hand the link to a human approver.',
    apiMethod: 'GET',
    apiPath: '/v1/proposals/{id}',
    forbiddenArgKeys: [...FORBIDDEN_ARG_KEYS],
  },
};

const RESOURCE_DESCRIPTORS: readonly McpResourceDescriptor[] = [
  {
    uri: 'proposal://{id}',
    name: 'proposal',
    description: 'Read a proposal row. Backs onto GET /v1/proposals/{id}.',
    mimeType: 'application/json',
    apiPath: '/v1/proposals/{id}',
  },
  {
    uri: 'health://',
    name: 'health',
    description: 'Liveness probe. Backs onto GET /v1/health.',
    mimeType: 'application/json',
    apiPath: '/v1/health',
  },
];

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

export class McpAuthorityError extends Error {
  readonly code: string;
  readonly extensions: Readonly<Record<string, unknown>>;
  constructor(
    code: string,
    message: string,
    extensions: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'McpAuthorityError';
    this.code = code;
    this.extensions = extensions;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateArgKeys(
  input: Readonly<Record<string, unknown>>,
  forbidden: readonly string[],
): Readonly<Record<string, unknown>> {
  const forbiddenSet = new Set(forbidden.map((key) => key.toLowerCase()));
  for (const key of Object.keys(input)) {
    if (forbiddenSet.has(key.toLowerCase())) {
      throw new McpAuthorityError(
        'E_MCP_FORBIDDEN_ARG_KEY',
        `argument key "${key}" is not allowed on any MCP tool`,
        { key },
      );
    }
  }
  return input;
}

function requireString(
  args: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new McpAuthorityError('E_MCP_BAD_ARG', `${field} must be a non-empty string`, {
      key,
    });
  }
  return v;
}

function isProblem(value: unknown): value is { readonly status: number; readonly type: string; readonly code: string } {
  if (!isPlainObject(value)) return false;
  return (
    typeof value['status'] === 'number' &&
    typeof value['type'] === 'string' &&
    typeof value['code'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class McpServer {
  readonly #options: Required<Omit<McpServerOptions, 'fetch' | 'idempotencyKeyGenerator' | 'now' | 'locale'>> & {
    readonly locale: 'en' | 'es';
    readonly fetch: typeof globalThis.fetch;
    readonly idempotencyKeyGenerator: () => string;
    readonly now: () => Date;
  };

  constructor(options: McpServerOptions) {
    if (options.apiBaseUrl.length === 0) {
      throw new McpAuthorityError('E_MCP_BAD_CONFIG', 'apiBaseUrl is required');
    }
    if (options.serviceToken.length === 0) {
      throw new McpAuthorityError('E_MCP_BAD_CONFIG', 'serviceToken is required');
    }
    if (options.tenantId.length === 0) {
      throw new McpAuthorityError('E_MCP_BAD_CONFIG', 'tenantId is required');
    }
    this.#options = {
      apiBaseUrl: options.apiBaseUrl,
      serviceToken: options.serviceToken,
      tenantId: options.tenantId,
      locale: options.locale ?? 'en',
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      idempotencyKeyGenerator: options.idempotencyKeyGenerator ?? (() => randomUUID()),
      now: options.now ?? (() => new Date()),
    };
  }

  /**
   * Deterministic declaration-order list of tool names.
   */
  listTools(): readonly McpToolDescriptor[] {
    return Object.freeze(
      Object.values(TOOL_DESCRIPTORS).map((d) => Object.freeze({ ...d })),
    ) as readonly McpToolDescriptor[];
  }

  /**
   * Deterministic declaration-order list of resource descriptors.
   */
  listResources(): readonly McpResourceDescriptor[] {
    return Object.freeze(RESOURCE_DESCRIPTORS.map((d) => Object.freeze({ ...d })));
  }

  /**
   * True iff the name is in the allowed tool union.
   */
  isAllowedToolName(name: string): name is AllowedToolName {
    return Object.prototype.hasOwnProperty.call(TOOL_DESCRIPTORS, name);
  }

  /**
   * True iff the name is in the forbidden list. Test-facing helper.
   */
  isForbiddenToolName(name: string): boolean {
    return isForbiddenToolName(name);
  }

  /**
   * True iff `name` is in the closed callable tool union.
   */
  isCallableToolName(name: string): boolean {
    return this.isAllowedToolName(name);
  }

  // ---------------------------------------------------------------------
  // JSON-RPC dispatcher
  // ---------------------------------------------------------------------

  async handleMessage(message: McpRequest): Promise<McpResponse> {
    if (message.jsonrpc !== '2.0') {
      return this.#error(message.id, -32600, 'invalid jsonrpc envelope', {
        received: message.jsonrpc,
      });
    }
    try {
      switch (message.method) {
        case 'tools/list':
          return this.#ok(message.id, { tools: this.listTools() });
        case 'resources/list':
          return this.#ok(message.id, { resources: this.listResources() });
        case 'tools/call':
          return await this.#callTool(message);
        case 'resources/read':
          return await this.#readResource(message);
        case 'initialize':
          return this.#ok(message.id, {
            protocolVersion: '2024-11-05',
            serverInfo: { name: '@cms/mcp', version: '0.1.0' },
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          });
        case 'ping':
          return this.#ok(message.id, {});
        default:
          return this.#error(message.id, -32601, `method not found: ${message.method}`, {
            method: message.method,
          });
      }
    } catch (err) {
      if (err instanceof McpAuthorityError) {
        return this.#error(message.id, -32010, err.message, {
          code: err.code,
          ...err.extensions,
        });
      }
      const message_ = err instanceof Error ? err.message : 'internal error';
      return this.#error(message.id, -32603, message_);
    }
  }

  // ---------------------------------------------------------------------
  // Tool call
  // ---------------------------------------------------------------------

  async #callTool(request: McpRequest): Promise<McpResponse> {
    const params = request.params ?? {};
    const rawName = params['name'];
    if (typeof rawName !== 'string' || rawName.length === 0) {
      throw new McpAuthorityError('E_MCP_BAD_TOOL_CALL', 'tools/call requires params.name');
    }
    if (isForbiddenToolName(rawName)) {
      throw new McpAuthorityError('E_MCP_FORBIDDEN_TOOL', `tool "${rawName}" is not exposed`, {
        name: rawName,
      });
    }
    if (!this.isAllowedToolName(rawName)) {
      throw new McpAuthorityError('E_MCP_UNKNOWN_TOOL', `tool "${rawName}" is not registered`, {
        name: rawName,
      });
    }
    const descriptor = TOOL_DESCRIPTORS[rawName];
    const rawArgs = params['arguments'];
    if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
      throw new McpAuthorityError('E_MCP_BAD_ARG', 'arguments must be an object if present');
    }
    const args = validateArgKeys(rawArgs ?? {}, descriptor.forbiddenArgKeys);
    const result = await this.#invokeTool(descriptor, args);
    return this.#ok(request.id, result);
  }

  async #invokeTool(
    descriptor: McpToolDescriptor,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    switch (descriptor.name) {
      case 'proposeEdit':
        return await this.#proposeEdit(args);
      case 'suggestAltText':
        return await this.#suggestFromProposal(args, 'altText');
      case 'suggestCrop':
        return await this.#suggestFromProposal(args, 'crop');
      case 'generatePreview':
        return await this.#generatePreview(args);
      case 'submitApprovalRequest':
        return await this.#submitApprovalRequest(args);
    }
    throw new McpAuthorityError(
      'E_MCP_INTERNAL',
      `unhandled tool name: ${descriptor.name}`,
    );
  }

  // ---------------------------------------------------------------------
  // Resource read
  // ---------------------------------------------------------------------

  async #readResource(request: McpRequest): Promise<McpResponse> {
    const params = request.params ?? {};
    const uri = params['uri'];
    if (typeof uri !== 'string' || uri.length === 0) {
      throw new McpAuthorityError('E_MCP_BAD_RESOURCE', 'resources/read requires params.uri');
    }
    for (const descriptor of RESOURCE_DESCRIPTORS) {
      const path = this.#matchResource(descriptor, uri);
      if (path === null) continue;
      const result = await this.#callApi({
        method: 'GET',
        path,
        body: undefined,
        requireIdempotencyKey: false,
      });
      return this.#ok(request.id, {
        contents: [
          {
            uri,
            name: descriptor.name,
            mimeType: descriptor.mimeType,
            text: JSON.stringify(result),
          },
        ],
      });
    }
    throw new McpAuthorityError('E_MCP_UNKNOWN_RESOURCE', `resource "${uri}" is not exposed`, {
      uri,
    });
  }

  #matchResource(descriptor: McpResourceDescriptor, uri: string): string | null {
    if (descriptor.uri === 'health://') {
      if (uri === 'health://' || uri === 'health://probe') {
        return descriptor.apiPath;
      }
      return null;
    }
    if (descriptor.uri === 'proposal://{id}') {
      const prefix = 'proposal://';
      if (!uri.startsWith(prefix)) return null;
      const id = uri.slice(prefix.length);
      if (id.length === 0) return null;
      if (!/^[A-Za-z0-9._:-]+$/.test(id)) return null;
      return `/v1/proposals/${id}`;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Tool implementations
  // ---------------------------------------------------------------------

  async #proposeEdit(args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const proposal = args['proposal'];
    if (!isPlainObject(proposal)) {
      throw new McpAuthorityError('E_MCP_BAD_ARG', 'proposal object is required');
    }
    const regionBindingId = requireString(args, 'regionBindingId', 'regionBindingId');
    const slug = requireString(args, 'slug', 'slug');
    const title = requireString(args, 'title', 'title');
    return await this.#callApi({
      method: 'POST',
      path: '/v1/proposals',
      body: { proposal, regionBindingId, slug, title },
      requireIdempotencyKey: true,
    });
  }

  async #suggestFromProposal(
    args: Readonly<Record<string, unknown>>,
    suggestionKind: 'altText' | 'crop',
  ): Promise<unknown> {
    const proposalId = requireString(args, 'proposalId', 'proposalId');
    const proposal = await this.#callApi({
      method: 'GET',
      path: `/v1/proposals/${encodeURIComponent(proposalId)}`,
      body: undefined,
      requireIdempotencyKey: false,
    });
    if (!isPlainObject(proposal)) {
      throw new McpAuthorityError('E_MCP_BAD_RESPONSE', 'proposal response was not an object');
    }
    const proposalShape = isPlainObject(proposal['proposal'])
      ? (proposal['proposal'] as Record<string, unknown>)
      : null;
    const suggestion = this.#buildSuggestion(proposalShape, proposal, suggestionKind);
    return {
      kind: suggestionKind,
      proposalId,
      proposalVersion: proposal['version'] ?? null,
      proposalState: proposal['state'] ?? null,
      suggestion,
    };
  }

  #buildSuggestion(
    proposalShape: Record<string, unknown> | null,
    proposal: Record<string, unknown>,
    kind: 'altText' | 'crop',
  ): Record<string, unknown> {
    if (proposalShape === null) {
      throw new McpAuthorityError(
        'E_MCP_UNSUPPORTED',
        'proposal payload is missing; cannot suggest',
      );
    }
    if (kind === 'altText') {
      const title = proposalShape['localizedTitle'];
      const body = proposalShape['localizedBody'];
      const localizedTitle = isPlainObject(title) ? title : null;
      const localizedBody = isPlainObject(body) ? body : null;
      const titleEn = localizedTitle && typeof localizedTitle['en'] === 'string' ? localizedTitle['en'] : null;
      const titleEs = localizedTitle && typeof localizedTitle['es'] === 'string' ? localizedTitle['es'] : null;
      const bodyEn = localizedBody && typeof localizedBody['en'] === 'string' ? localizedBody['en'] : '';
      const bodyEs = localizedBody && typeof localizedBody['es'] === 'string' ? localizedBody['es'] : '';
      const summarize = (text: string, max: number): string => {
        const trimmed = text.replace(/\s+/g, ' ').trim();
        if (trimmed.length === 0) return '';
        if (trimmed.length <= max) return trimmed;
        const slice = trimmed.slice(0, max);
        const lastSpace = slice.lastIndexOf(' ');
        return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice) + '…';
      };
      const tenantId = typeof proposal['tenantId'] === 'string' ? proposal['tenantId'] : null;
      const summaryEn = summarize(bodyEn, 180);
      const summaryEs = summarize(bodyEs, 180);
      return {
        kind: 'altText',
        proposedBy: 'mcp.suggestion',
        tenantId,
        localized: {
          en: {
            title: titleEn,
            summary: summaryEn,
            length: summaryEn.length,
          },
          es: {
            title: titleEs,
            summary: summaryEs,
            length: summaryEs.length,
          },
        },
        note:
          'AI-suggested alt-text. A human must review and approve before publication; never auto-applied.',
      };
    }
    // suggestCrop
    const canonicalRepoPath =
      typeof proposalShape['canonicalRepoPath'] === 'string'
        ? (proposalShape['canonicalRepoPath'] as string)
        : null;
    return {
      kind: 'crop',
      proposedBy: 'mcp.suggestion',
      focal: { x: 0.5, y: 0.5, strategy: 'center' },
      aspectRatios: [
        { name: '16:9', width: 1600, height: 900 },
        { name: '4:3', width: 1200, height: 900 },
        { name: '1:1', width: 1024, height: 1024 },
      ],
      source: canonicalRepoPath,
      note:
        'AI-suggested crop. A human must review and approve before publication; never auto-applied.',
    };
  }

  async #generatePreview(args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const proposalId = requireString(args, 'proposalId', 'proposalId');
    const proposal = await this.#callApi({
      method: 'GET',
      path: `/v1/proposals/${encodeURIComponent(proposalId)}`,
      body: undefined,
      requireIdempotencyKey: false,
    });
    if (!isPlainObject(proposal)) {
      throw new McpAuthorityError('E_MCP_BAD_RESPONSE', 'proposal response was not an object');
    }
    const proposalShape = isPlainObject(proposal['proposal'])
      ? (proposal['proposal'] as Record<string, unknown>)
      : null;
    if (proposalShape === null) {
      throw new McpAuthorityError('E_MCP_UNSUPPORTED', 'proposal payload is missing');
    }
    const previewId = `prv_${createHash('sha256')
      .update(`${proposalId}|${this.#options.now().toISOString()}`)
      .digest('hex')
      .slice(0, 32)}`;
    return {
      previewId,
      proposalId,
      proposalVersion: proposal['version'] ?? null,
      proposalState: proposal['state'] ?? null,
      kind: 'preview.snapshot',
      source: 'proposal.payload',
      snapshot: proposalShape,
      note: 'Preview derived from the proposal snapshot. Preview does not advance approval, publication, or deploy state.',
    };
  }

  /**
   * `submitApprovalRequest` is a readiness signal. It does NOT call
   * `/v1/proposals/:id/approve`, `/publish`, or `/rollback`. It
   * returns a structured opportunity descriptor the caller hands to
   * a human approver out-of-band.
   */
  async #submitApprovalRequest(args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const proposalId = requireString(args, 'proposalId', 'proposalId');
    const rationale = args['rationale'];
    if (rationale !== undefined && typeof rationale !== 'string') {
      throw new McpAuthorityError('E_MCP_BAD_ARG', 'rationale must be a string if present');
    }
    const proposal = await this.#callApi({
      method: 'GET',
      path: `/v1/proposals/${encodeURIComponent(proposalId)}`,
      body: undefined,
      requireIdempotencyKey: false,
    });
    if (!isPlainObject(proposal)) {
      throw new McpAuthorityError('E_MCP_BAD_RESPONSE', 'proposal response was not an object');
    }
    const state = typeof proposal['state'] === 'string' ? (proposal['state'] as string) : null;
    if (state !== 'proposed' && state !== 'previewing') {
      throw new McpAuthorityError(
        'E_MCP_APPROVAL_OPPORTUNITY_NOT_AVAILABLE',
        `proposal state "${state ?? 'unknown'}" does not admit an approval opportunity`,
        { proposalId, state },
      );
    }
    const opportunityId = `opp_${createHash('sha256')
      .update(`${proposalId}|${this.#options.tenantId}|${this.#options.now().toISOString()}`)
      .digest('hex')
      .slice(0, 32)}`;
    return {
      opportunityId,
      proposalId,
      proposalVersion: proposal['version'] ?? null,
      proposalState: state,
      proposedBy: proposal['proposed_by_actor_id'] ?? null,
      delegatedHumanActorId: proposal['delegated_human_actor_id'] ?? null,
      opportunityFor: 'human.approver',
      humanActionUrl: `/v1/proposals/${encodeURIComponent(proposalId)}/approve`,
      ...(typeof rationale === 'string' ? { rationale } : {}),
      note:
        'Approval opportunity signaled. A human must perform the approve action out-of-band via the human CLI/UI; the MCP identity never approves.',
      stateTransition: 'none',
    };
  }

  // ---------------------------------------------------------------------
  // API call seam
  // ---------------------------------------------------------------------

  async #callApi(input: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly body: unknown;
    readonly requireIdempotencyKey: boolean;
  }): Promise<unknown> {
    if (!input.path.startsWith('/v1/')) {
      throw new McpAuthorityError(
        'E_MCP_INTERNAL',
        `api path must be under /v1: ${input.path}`,
        { path: input.path },
      );
    }
    const idempotencyKey = input.requireIdempotencyKey
      ? this.#options.idempotencyKeyGenerator()
      : undefined;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#options.serviceToken}`,
      'x-tenant-id': this.#options.tenantId,
      'accept-language': this.#options.locale,
      accept: 'application/json, application/problem+json',
    };
    if (idempotencyKey !== undefined) {
      headers['idempotency-key'] = idempotencyKey;
    }
    const url = `${this.#options.apiBaseUrl.replace(/\/$/, '')}${input.path}`;
    const init: RequestInit = {
      method: input.method,
      headers,
    };
    if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(input.body);
    }
    const response = await this.#options.fetch(url, init);
    const text = await response.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Keep raw text; surface upstream.
      }
    }
    if (!response.ok) {
      const problem = isProblem(parsed)
        ? parsed
        : {
            status: response.status,
            type: 'urn:cms:problem:mcp:transport_error',
            code: 'E_MCP_TRANSPORT_ERROR',
            title: 'API request failed',
            detail: typeof text === 'string' ? text.slice(0, 256) : 'non-JSON response',
            instance: url,
            locale: this.#options.locale,
            extensions: { traceId: null },
          };
      throw new McpAuthorityError('E_MCP_API_PROBLEM', 'API request returned a Problem', {
        problem,
      });
    }
    return parsed;
  }

  // ---------------------------------------------------------------------
  // JSON-RPC helpers
  // ---------------------------------------------------------------------

  #ok(id: string | number | null, result: unknown): McpResponse {
    return { jsonrpc: '2.0', id, result };
  }

  #error(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
  ): McpResponse {
    return data === undefined
      ? { jsonrpc: '2.0', id, error: { code, message } }
      : { jsonrpc: '2.0', id, error: { code, message, data } };
  }
}
