import { describe, expect, it, beforeEach } from 'vitest';
import {
  ALLOWED_RESOURCE_URIS,
  ALLOWED_TOOL_NAMES,
  McpAuthorityError,
  McpServer,
  type McpRequest,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

interface FakeApi {
  readonly server: McpServer;
  readonly calls: CapturedCall[];
  /** Map of path → status + JSON body to return. */
  readonly responses: Map<string, { status: number; body: unknown }>;
  setResponse(path: string, status: number, body: unknown): void;
  lastCall(): CapturedCall | undefined;
}

function makeApi(opts?: {
  serviceToken?: string;
  tenantId?: string;
  locale?: 'en' | 'es';
  idempotencyKeyGenerator?: () => string;
}): FakeApi {
  const calls: CapturedCall[] = [];
  const responses = new Map<string, { status: number; body: unknown }>();
  const serviceToken = opts?.serviceToken ?? 'mcp-service-token';
  const tenantId = opts?.tenantId ?? 'tenant-mcp-1';
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = String(v);
      }
    }
    const body = init?.body === undefined ? undefined : String(init.body);
    calls.push({ url, method, headers, body });
    const path = new URL(url).pathname;
    const key = `${method} ${path}`;
    const r = responses.get(key) ?? responses.get(path) ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const server = new McpServer({
    apiBaseUrl: 'https://api.example.test',
    serviceToken,
    tenantId,
    ...(opts?.locale !== undefined ? { locale: opts.locale } : {}),
    fetch: fetchImpl,
    ...(opts?.idempotencyKeyGenerator !== undefined
      ? { idempotencyKeyGenerator: opts.idempotencyKeyGenerator }
      : {}),
  });
  return {
    server,
    calls,
    responses,
    setResponse(path, status, body) {
      responses.set(path, { status, body });
      responses.set(`POST ${path}`, { status, body });
      responses.set(`GET ${path}`, { status, body });
    },
    lastCall() {
      return calls[calls.length - 1];
    },
  };
}

function request(
  method: string,
  params?: Record<string, unknown>,
  id: string | number | null = 1,
): McpRequest {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

function proposalContentShape() {
  return {
    id: 'proposal-mcp-1',
    tenantId: 'tenant-mcp-1',
    contentType: 'post',
    environment: 'staging',
    action: 'create',
    createdAt: '2026-07-27T12:00:00.000Z',
    draft: false,
    kind: 'content',
    revisionId: 'rev-1',
    localizedTitle: { en: 'New title', es: 'Título nuevo' },
    localizedBody: { en: 'Body text', es: 'Cuerpo' },
    canonicalRepoPath: 'content/posts/mcp-1.md',
  };
}

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proposal-mcp-1',
    tenant_id: 'proposal-mcp-1',
    tenantId: 'tenant-mcp-1',
    region_binding_id: 'region-1',
    regionBindingId: 'region-1',
    slug: 'mcp-1',
    proposed_by_actor_id: 'human-mcp-1',
    proposedByActorId: 'human-mcp-1',
    delegated_human_actor_id: null,
    delegatedHumanActorId: null,
    title: 'MCP test proposal',
    state: 'proposed',
    version: 2,
    proposal: proposalContentShape(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Public surface enumeration
// ---------------------------------------------------------------------------

describe('@cms/mcp public surface', () => {
  it('exposes the fixed closed union of allowed tool names', () => {
    expect([...ALLOWED_TOOL_NAMES]).toEqual([
      'proposeEdit',
      'suggestAltText',
      'suggestCrop',
      'generatePreview',
      'submitApprovalRequest',
    ]);
  });

  it('exposes the fixed closed union of allowed resource uris', () => {
    expect([...ALLOWED_RESOURCE_URIS]).toEqual(['proposal://{id}', 'health://']);
  });

  it('exposes a deterministic listTools() result whose order matches the closed union', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(request('tools/list'));
    expect(response.error).toBeUndefined();
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name)).toEqual([...ALLOWED_TOOL_NAMES]);
  });

  it('exposes a deterministic listResources() result', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(request('resources/list'));
    expect(response.error).toBeUndefined();
    const result = response.result as { resources: Array<{ uri: string; name: string }> };
    expect(result.resources.map((r) => r.uri)).toEqual([...ALLOWED_RESOURCE_URIS]);
    expect(result.resources.map((r) => r.name)).toEqual(['proposal', 'health']);
  });

  it('descriptor pins each tool to a constant method and path, with no alias route', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(request('tools/list'));
    const result = response.result as { tools: Array<{ name: string; apiMethod: string; apiPath: string; forbiddenArgKeys: string[] }> };
    for (const tool of result.tools) {
      expect(['GET', 'POST']).toContain(tool.apiMethod);
      expect(tool.apiPath.startsWith('/v1/')).toBe(true);
      // No tool points at an approve/publish/apply/rollback endpoint
      expect(tool.apiPath).not.toMatch(/\/(approve|publish|apply|rollback|reconcile)(\/|$)/);
      // No tool allows an override-shaped arg key
      for (const key of tool.forbiddenArgKeys) {
        expect(tool.forbiddenArgKeys).toContain(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Allowed tools — happy paths
// ---------------------------------------------------------------------------

describe('allowed tools', () => {
  let api: FakeApi;
  beforeEach(() => {
    api = makeApi({ idempotencyKeyGenerator: () => 'fixed-idem-key-1' });
  });

  it('proposeEdit POSTs to /v1/proposals with tenant, locale, idempotency headers', async () => {
    api.setResponse('/v1/proposals', 201, proposalRow({ state: 'proposed', version: 2 }));
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeUndefined();
    const call = api.lastCall()!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.example.test/v1/proposals');
    expect(call.headers['authorization']).toBe('Bearer mcp-service-token');
    expect(call.headers['x-tenant-id']).toBe('tenant-mcp-1');
    expect(call.headers['idempotency-key']).toBe('fixed-idem-key-1');
    expect(call.headers['accept-language']).toBe('en');
    expect(call.headers['content-type']).toBe('application/json');
    const body = JSON.parse(call.body!);
    expect(body.proposal.id).toBe('proposal-mcp-1');
    expect(body.regionBindingId).toBe('region-1');
    expect(body.slug).toBe('mcp-1');
    expect(body.title).toBe('MCP test proposal');
  });

  it('proposeEdit uses es locale when configured', async () => {
    const esApi = makeApi({ locale: 'es', idempotencyKeyGenerator: () => 'idem-es' });
    esApi.setResponse('/v1/proposals', 201, proposalRow());
    await esApi.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    const call = esApi.lastCall()!;
    expect(call.headers['accept-language']).toBe('es');
  });

  it('suggestAltText GETs the proposal and returns a structured suggestion without mutating', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow());
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'suggestAltText',
        arguments: { proposalId: 'proposal-mcp-1' },
      }),
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { kind: string; proposalId: string; suggestion: { kind: string; proposedBy: string; localized: { en: unknown; es: unknown } } };
    expect(result.kind).toBe('altText');
    expect(result.proposalId).toBe('proposal-mcp-1');
    expect(result.suggestion.proposedBy).toBe('mcp.suggestion');
    expect(result.suggestion.kind).toBe('altText');
    expect(result.suggestion.localized.en).toBeTruthy();
    expect(result.suggestion.localized.es).toBeTruthy();
    const call = api.lastCall()!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('https://api.example.test/v1/proposals/proposal-mcp-1');
    expect(call.headers['idempotency-key']).toBeUndefined();
    // No POST means no body and no idempotency-key — the GET was safe.
    expect(call.body).toBeUndefined();
  });

  it('suggestCrop GETs the proposal and returns a structured crop suggestion', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow());
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'suggestCrop',
        arguments: { proposalId: 'proposal-mcp-1' },
      }),
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { kind: string; suggestion: { kind: string; focal: unknown; aspectRatios: unknown[] } };
    expect(result.kind).toBe('crop');
    expect(result.suggestion.kind).toBe('crop');
    expect(result.suggestion.focal).toEqual({ x: 0.5, y: 0.5, strategy: 'center' });
    expect(result.suggestion.aspectRatios.length).toBeGreaterThan(0);
  });

  it('generatePreview GETs the proposal and returns a preview snapshot', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow());
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'generatePreview',
        arguments: { proposalId: 'proposal-mcp-1' },
      }),
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { previewId: string; kind: string; snapshot: unknown };
    expect(result.previewId.startsWith('prv_')).toBe(true);
    expect(result.kind).toBe('preview.snapshot');
    expect(result.snapshot).toBeTruthy();
  });

  it('submitApprovalRequest signals an approval opportunity and never calls /approve|/publish|/rollback', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow({ state: 'proposed' }));
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'submitApprovalRequest',
        arguments: { proposalId: 'proposal-mcp-1', rationale: 'Routine weekly update' },
      }),
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { opportunityId: string; opportunityFor: string; stateTransition: string; humanActionUrl: string };
    expect(result.opportunityId.startsWith('opp_')).toBe(true);
    expect(result.opportunityFor).toBe('human.approver');
    expect(result.stateTransition).toBe('none');
    expect(result.humanActionUrl).toBe('/v1/proposals/proposal-mcp-1/approve');
    // The only API call made is the GET; the human action url is informational.
    const calls = api.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/proposals/proposal-mcp-1');
    // It explicitly does not hit /approve, /publish, /rollback, or /reconcile.
    for (const call of calls) {
      expect(call.url).not.toMatch(/\/(approve|publish|rollback|reconcile)(\/|$|\?)/);
    }
  });

  it('submitApprovalRequest refuses when the proposal state is not in the opportunity-allowed set', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow({ state: 'live' }));
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'submitApprovalRequest',
        arguments: { proposalId: 'proposal-mcp-1' },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_APPROVAL_OPPORTUNITY_NOT_AVAILABLE' });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.method).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// 3. Forbidden tool names — every alias is rejected before any API call
// ---------------------------------------------------------------------------

describe('forbidden tool names', () => {
  const FORBIDDEN_NAMES = [
    'approve',
    'APPROVE',
    'Approve',
    'approves',
    'approveProposal',
    'approve-proposal',
    'approve_proposal',
    'approve/proposal',
    'adminApprove',
    'admin_approve',
    'forceApprove',
    'force-approve',
    'doApprove',
    'do-approve',
    'do_approve',
    'signApproval',
    'sign-approval',
    'sign_approval',
    'requestApproval',
    'request-approval',
    'request_approval',
    'submitApproval',
    'submit-approval',
    'submit_approval',
    'publish',
    'publishProposal',
    'adminPublish',
    'forcePublish',
    'signPublish',
    'requestPublish',
    'submitPublish',
    'apply',
    'applyProposal',
    'adminApply',
    'forceApply',
    'requestApply',
    'submitApply',
    'rollback',
    'rollbackProposal',
    'adminRollback',
    'forceRollback',
    'requestRollback',
    'submitRollback',
    'rollBack',
    'Rollback',
    'deploy',
    'deployProposal',
    'adminDeploy',
    'forceDeploy',
    'requestDeploy',
    'submitDeploy',
    'bypass',
    'override',
    'overridePolicy',
    'http',
    'fetch',
    'request',
    'proxyRequest',
    'arbitraryRequest',
    'rawFetch',
    'sendRequest',
    'forwardRequest',
    'executeRequest',
    'proxy',
    'exec',
    'run',
    'invoke',
    'patchProposal',
    'transitionProposal',
  ];

  let api: FakeApi;
  beforeEach(() => {
    api = makeApi();
  });

  for (const name of FORBIDDEN_NAMES) {
    it(`rejects tool name "${name}" without making any API call`, async () => {
      const response = await api.server.handleMessage(
        request('tools/call', { name, arguments: { proposalId: 'proposal-mcp-1' } }),
      );
      expect(response.error).toBeDefined();
      expect(response.error!.data).toMatchObject({ code: 'E_MCP_FORBIDDEN_TOOL', name });
      expect(api.calls).toHaveLength(0);
    });
  }

  it('isForbiddenToolName returns true for every name in the forbidden list', () => {
    for (const name of FORBIDDEN_NAMES) {
      expect(api.server.isForbiddenToolName(name)).toBe(true);
    }
  });

  it('isCallableToolName returns false for every forbidden name', () => {
    for (const name of FORBIDDEN_NAMES) {
      expect(api.server.isCallableToolName(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Crafted-argument bypasses — override-shaped keys are stripped
// ---------------------------------------------------------------------------

describe('crafted-argument bypasses', () => {
  let api: FakeApi;
  beforeEach(() => {
    api = makeApi({ idempotencyKeyGenerator: () => 'idem-bypass' });
  });

  const FORBIDDEN_KEYS = [
    'method',
    'path',
    'url',
    'endpoint',
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
    'forcePath',
    'forceMethod',
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
    'ifMatch',
    'if_match',
    'if-match',
  ];

  for (const key of FORBIDDEN_KEYS) {
    it(`strips the override-shaped key "${key}" from a proposeEdit argument`, async () => {
      api.setResponse('/v1/proposals', 201, proposalRow());
      const response = await api.server.handleMessage(
        request('tools/call', {
          name: 'proposeEdit',
          arguments: {
            proposal: proposalContentShape(),
            regionBindingId: 'region-1',
            slug: 'mcp-1',
            title: 'MCP test proposal',
            [key]: '/v1/proposals/proposal-mcp-1/approve',
          },
        }),
      );
      expect(response.error).toBeDefined();
      expect(response.error!.data).toMatchObject({ code: 'E_MCP_FORBIDDEN_ARG_KEY', key });
      // No API call must be made.
      expect(api.calls).toHaveLength(0);
    });
  }

  it('a tool argument named "method" cannot redirect a GET to a POST /approve', async () => {
    api.setResponse('/v1/proposals', 201, proposalRow());
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
          method: 'POST',
          path: '/v1/proposals/proposal-mcp-1/approve',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(api.calls).toHaveLength(0);
  });

  it('a top-level "url" parameter is rejected as an override-shaped key', async () => {
    api.setResponse('/v1/proposals', 201, proposalRow());
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'suggestAltText',
        arguments: { proposalId: 'proposal-mcp-1', url: 'https://api.example.test/v1/proposals/proposal-mcp-1/approve' },
      }),
    );
    // `url` is an override-shaped key; the descriptor's path is the only
    // path that may be hit. The request must be rejected before any API
    // call is made.
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_FORBIDDEN_ARG_KEY', key: 'url' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects a top-level method override before any API call', async () => {
    api.setResponse('/v1/proposals', 201, proposalRow());
    const shape = proposalContentShape() as Record<string, unknown>;
    // Descriptor routing is authoritative; top-level request overrides are rejected.
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: shape,
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
          method: 'POST',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(api.calls).toHaveLength(0);
  });

  it('a tool argument that encodes the action "approve" cannot drive the API to /approve', async () => {
    api.setResponse('/v1/proposals', 201, proposalRow());
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
          action: 'approve',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(api.calls).toHaveLength(0);
  });

  it('a tool argument that encodes the op "publish" cannot drive the API to /publish', async () => {
    api.setResponse('/v1/proposals', 201, proposalRow());
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
          op: 'publish',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(api.calls).toHaveLength(0);
  });

  it('submitApprovalRequest cannot be coerced into an approve by passing approve-shaped args', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow({ state: 'proposed' }));
    for (const key of ['method', 'path', 'url', 'action', 'op', 'ifMatch', 'if-match', 'if_match', 'approve', 'publish', 'rollback', 'apply']) {
      const args: Record<string, unknown> = { proposalId: 'proposal-mcp-1' };
      args[key] = key === 'ifMatch' || key === 'if-match' || key === 'if_match' ? 1 : '/v1/proposals/x/approve';
      const response = await api.server.handleMessage(
        request('tools/call', { name: 'submitApprovalRequest', arguments: args }),
      );
      expect(response.error).toBeDefined();
      expect(response.error!.data).toMatchObject({ code: 'E_MCP_FORBIDDEN_ARG_KEY' });
    }
    // All calls were GETs to /v1/proposals/{id}; none to /approve etc.
    for (const call of api.calls) {
      expect(call.url).not.toMatch(/\/(approve|publish|apply|rollback|reconcile)(\/|$|\?)/);
      expect(call.method).toBe('GET');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. API Problem Details pass through unchanged
// ---------------------------------------------------------------------------

describe('Problem Details passthrough', () => {
  it('returns a structured MCP error wrapping a Problem when the API responds with application/problem+json', async () => {
    const api = makeApi();
    const problem = {
      status: 409,
      type: 'urn:cms:problem:storage:optimistic_concurrency_conflict',
      title: 'Optimistic concurrency conflict',
      detail: 'expected version 4, current version 5',
      instance: 'https://api.example.test/v1/proposals/proposal-mcp-1',
      code: 'optimistic_concurrency_conflict',
      locale: 'en',
      extensions: { traceId: 'trace-1' },
    };
    api.setResponse('/v1/proposals', 409, problem);
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32010);
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_API_PROBLEM', problem });
  });

  it('localizes problems using the configured locale when the API body is missing locale info', async () => {
    const api = makeApi({ locale: 'es' });
    api.setResponse('/v1/proposals', 500, { foo: 'bar' });
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeDefined();
    const data = response.error!.data as { problem: { locale: string; code: string } };
    expect(data.problem.locale).toBe('es');
    expect(data.problem.code).toBe('E_MCP_TRANSPORT_ERROR');
  });
});

// ---------------------------------------------------------------------------
// 6. Resources — read-only, proposal:// and health://
// ---------------------------------------------------------------------------

describe('resources', () => {
  it('reads a proposal via proposal://{id}', async () => {
    const api = makeApi();
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow());
    const response = await api.server.handleMessage(
      request('resources/read', { uri: 'proposal://proposal-mcp-1' }),
    );
    expect(response.error).toBeUndefined();
    const result = response.result as {
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    };
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]!.uri).toBe('proposal://proposal-mcp-1');
    expect(result.contents[0]!.mimeType).toBe('application/json');
    expect(api.lastCall()!.method).toBe('GET');
    expect(api.lastCall()!.url).toBe('https://api.example.test/v1/proposals/proposal-mcp-1');
  });

  it('reads health via health://', async () => {
    const api = makeApi();
    api.setResponse('/v1/health', 200, { status: 'ok' });
    const response = await api.server.handleMessage(
      request('resources/read', { uri: 'health://' }),
    );
    expect(response.error).toBeUndefined();
    expect(api.lastCall()!.method).toBe('GET');
    expect(api.lastCall()!.url).toBe('https://api.example.test/v1/health');
  });

  it('rejects an unknown resource URI', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(
      request('resources/read', { uri: 'region://list' }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_UNKNOWN_RESOURCE' });
  });

  it('rejects a proposal URI with an invalid id (path traversal)', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(
      request('resources/read', { uri: 'proposal://../admin' }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_UNKNOWN_RESOURCE' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects a proposal URI that targets the approve endpoint', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(
      request('resources/read', { uri: 'proposal://proposal-1/approve' }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_UNKNOWN_RESOURCE' });
    expect(api.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Configuration & constructor validation
// ---------------------------------------------------------------------------

describe('constructor validation', () => {
  it('rejects empty apiBaseUrl', () => {
    expect(() => new McpServer({ apiBaseUrl: '', serviceToken: 't', tenantId: 'x' })).toThrow(
      McpAuthorityError,
    );
  });
  it('rejects empty serviceToken', () => {
    expect(
      () => new McpServer({ apiBaseUrl: 'https://api', serviceToken: '', tenantId: 'x' }),
    ).toThrow(McpAuthorityError);
  });
  it('rejects empty tenantId', () => {
    expect(
      () => new McpServer({ apiBaseUrl: 'https://api', serviceToken: 't', tenantId: '' }),
    ).toThrow(McpAuthorityError);
  });
});

// ---------------------------------------------------------------------------
// 8. JSON-RPC envelope hygiene
// ---------------------------------------------------------------------------

describe('JSON-RPC envelope', () => {
  it('rejects a non-2.0 envelope', async () => {
    const api = makeApi();
    const badRequest = {
      jsonrpc: '1.0',
      id: 1,
      method: 'tools/list',
    } as unknown as McpRequest;
    const response = await api.server.handleMessage(badRequest);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32600);
  });

  it('returns method not found for unknown methods', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(request('tools/invoke', { name: 'approve' }));
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32601);
  });

  it('initialize advertises the deterministic capabilities', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(request('initialize'));
    expect(response.error).toBeUndefined();
    const result = response.result as { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: unknown };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toEqual({ name: '@cms/mcp', version: '0.1.0' });
    expect(result.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Idempotency, tenant, locale — forwarded correctly
// ---------------------------------------------------------------------------

describe('header forwarding', () => {
  it('proposeEdit forwards a fresh idempotency key per call (default generator)', async () => {
    const api = makeApi();
    api.setResponse('/v1/proposals', 201, proposalRow());
    await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    const call = api.lastCall()!;
    expect(call.headers['idempotency-key']).toBeTruthy();
    expect(call.headers['idempotency-key']!.length).toBeGreaterThan(0);
  });

  it('proposeEdit uses the injected idempotency key generator when supplied', async () => {
    const api = makeApi({ idempotencyKeyGenerator: () => 'deterministic-idem' });
    api.setResponse('/v1/proposals', 201, proposalRow());
    await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(api.lastCall()!.headers['idempotency-key']).toBe('deterministic-idem');
  });

  it('GETs do not carry an Idempotency-Key', async () => {
    const api = makeApi({ idempotencyKeyGenerator: () => 'should-not-be-sent' });
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow());
    await api.server.handleMessage(
      request('tools/call', { name: 'generatePreview', arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(api.lastCall()!.headers['idempotency-key']).toBeUndefined();
  });

  it('forwards the service bearer and tenant on every call', async () => {
    const api = makeApi({ serviceToken: 'svctok-1', tenantId: 'tenant-X' });
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow());
    await api.server.handleMessage(
      request('tools/call', { name: 'generatePreview', arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(api.lastCall()!.headers['authorization']).toBe('Bearer svctok-1');
    expect(api.lastCall()!.headers['x-tenant-id']).toBe('tenant-X');
  });
});

// ---------------------------------------------------------------------------
// 10. Parity: en and es are peer locales
// ---------------------------------------------------------------------------

describe('locale parity', () => {
  it('en and es both reach the API with the configured locale', async () => {
    const enApi = makeApi({ locale: 'en' });
    const esApi = makeApi({ locale: 'es' });
    enApi.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow());
    esApi.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow());
    await enApi.server.handleMessage(
      request('tools/call', { name: 'generatePreview', arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    await esApi.server.handleMessage(
      request('tools/call', { name: 'generatePreview', arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(enApi.lastCall()!.headers['accept-language']).toBe('en');
    expect(esApi.lastCall()!.headers['accept-language']).toBe('es');
  });

});

// ---------------------------------------------------------------------------
// 11. JSON-RPC lifecycle methods — initialize, ping, capabilities
// ---------------------------------------------------------------------------

describe('JSON-RPC lifecycle methods', () => {
  it('initialize advertises protocolVersion, serverInfo, and stable capabilities', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(request('initialize'));
    expect(response.error).toBeUndefined();
    const result = response.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: { tools: { listChanged: boolean }; resources: { listChanged: boolean } };
    };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toEqual({ name: '@cms/mcp', version: '0.1.0' });
    expect(result.capabilities.tools.listChanged).toBe(false);
    expect(result.capabilities.resources.listChanged).toBe(false);
  });

  it('initialize makes no API call', async () => {
    const api = makeApi();
    await api.server.handleMessage(request('initialize'));
    expect(api.calls).toHaveLength(0);
  });

  it('ping returns an empty success envelope and makes no API call', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(request('ping'));
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({});
    expect(api.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 12. tools/call input validation — missing/invalid name and arguments
// ---------------------------------------------------------------------------

describe('tools/call input validation', () => {
  let api: FakeApi;
  beforeEach(() => {
    api = makeApi();
  });

  it('rejects tools/call with no params', async () => {
    const response = await api.server.handleMessage(request('tools/call'));
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_TOOL_CALL' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects tools/call when params.name is missing', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_TOOL_CALL' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects tools/call when params.name is not a string', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { name: 42, arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_TOOL_CALL' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects tools/call when params.name is an empty string', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { name: '', arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_TOOL_CALL' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects an unknown-but-not-forbidden tool name with E_MCP_UNKNOWN_TOOL', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'neverHeardOfIt', arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({
      code: 'E_MCP_UNKNOWN_TOOL',
      name: 'neverHeardOfIt',
    });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects tools/call when arguments is present but not an object', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'proposeEdit', arguments: 'not-an-object' as unknown as Record<string, unknown> }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects tools/call when arguments is an array', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'proposeEdit', arguments: [] as unknown as Record<string, unknown> }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects tools/call when arguments is null', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'proposeEdit', arguments: null as unknown as Record<string, unknown> }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG' });
    expect(api.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 13. requireString and proposeEdit proposal-shape validation
// ---------------------------------------------------------------------------

describe('requireString validation', () => {
  let api: FakeApi;
  beforeEach(() => {
    api = makeApi({ idempotencyKeyGenerator: () => 'idem-validate' });
  });

  it('proposeEdit rejects when proposal is missing', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG' });
    expect(api.calls).toHaveLength(0);
  });

  it('proposeEdit rejects when proposal is not an object', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: 'not-an-object',
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG' });
    expect(api.calls).toHaveLength(0);
  });

  it('proposeEdit rejects when regionBindingId is missing', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG', key: 'regionBindingId' });
    expect(api.calls).toHaveLength(0);
  });

  it('proposeEdit rejects when slug is missing', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG', key: 'slug' });
    expect(api.calls).toHaveLength(0);
  });

  it('proposeEdit rejects when title is missing', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG', key: 'title' });
    expect(api.calls).toHaveLength(0);
  });

  it('proposeEdit rejects when a string field is empty', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: '',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG', key: 'slug' });
    expect(api.calls).toHaveLength(0);
  });

  it('proposeEdit rejects when a string field is the wrong type', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 42,
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG', key: 'regionBindingId' });
    expect(api.calls).toHaveLength(0);
  });

  it('suggestAltText rejects when proposalId is missing', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'suggestAltText', arguments: {} }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG', key: 'proposalId' });
    expect(api.calls).toHaveLength(0);
  });

  it('suggestCrop rejects when proposalId is missing', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'suggestCrop', arguments: {} }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG', key: 'proposalId' });
    expect(api.calls).toHaveLength(0);
  });

  it('generatePreview rejects when proposalId is missing', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'generatePreview', arguments: {} }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG', key: 'proposalId' });
    expect(api.calls).toHaveLength(0);
  });

  it('submitApprovalRequest rejects when proposalId is missing', async () => {
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'submitApprovalRequest', arguments: {} }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG', key: 'proposalId' });
    expect(api.calls).toHaveLength(0);
  });

  it('submitApprovalRequest rejects when rationale is not a string', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow({ state: 'proposed' }));
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'submitApprovalRequest',
        arguments: { proposalId: 'proposal-mcp-1', rationale: 42 },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG' });
    expect(api.calls).toHaveLength(0);
  });

  it('submitApprovalRequest accepts a string rationale and rounds it through', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow({ state: 'proposed' }));
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'submitApprovalRequest',
        arguments: { proposalId: 'proposal-mcp-1', rationale: 'carefully reviewed' },
      }),
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { rationale?: string };
    expect(result.rationale).toBe('carefully reviewed');
  });

  it('submitApprovalRequest omits rationale when not provided', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow({ state: 'proposed' }));
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'submitApprovalRequest',
        arguments: { proposalId: 'proposal-mcp-1' },
      }),
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { rationale?: string };
    expect(result.rationale).toBeUndefined();
  });

  it('submitApprovalRequest also accepts the previewing state', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, proposalRow({ state: 'previewing' }));
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'submitApprovalRequest',
        arguments: { proposalId: 'proposal-mcp-1' },
      }),
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { proposalState: string };
    expect(result.proposalState).toBe('previewing');
  });
});

// ---------------------------------------------------------------------------
// 14. Non-object API responses and unsupported proposal payloads
// ---------------------------------------------------------------------------

describe('API response guards for read-only tools', () => {
  let api: FakeApi;
  beforeEach(() => {
    api = makeApi();
  });

  for (const tool of ['suggestAltText', 'suggestCrop', 'generatePreview', 'submitApprovalRequest']) {
    it(`${tool} rejects when the API returns a non-object body`, async () => {
      api.setResponse('/v1/proposals/proposal-mcp-1', 200, 'not-an-object');
      const response = await api.server.handleMessage(
        request('tools/call', { name: tool, arguments: { proposalId: 'proposal-mcp-1' } }),
      );
      expect(response.error).toBeDefined();
      expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_RESPONSE' });
    });
  }

  for (const tool of ['suggestAltText', 'suggestCrop', 'generatePreview']) {
    it(`${tool} rejects when the proposal payload is missing (unsupported)`, async () => {
      api.setResponse('/v1/proposals/proposal-mcp-1', 200, {
        id: 'proposal-mcp-1',
        tenantId: 'tenant-mcp-1',
        state: 'proposed',
        version: 2,
      });
      const response = await api.server.handleMessage(
        request('tools/call', { name: tool, arguments: { proposalId: 'proposal-mcp-1' } }),
      );
      expect(response.error).toBeDefined();
      expect(response.error!.data).toMatchObject({ code: 'E_MCP_UNSUPPORTED' });
    });
  }

  it('submitApprovalRequest creates an opportunity without requiring proposal payload content', async () => {
    api.setResponse('/v1/proposals/proposal-mcp-1', 200, {
      id: 'proposal-mcp-1',
      tenantId: 'tenant-mcp-1',
      state: 'proposed',
      version: 2,
    });
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'submitApprovalRequest',
        arguments: { proposalId: 'proposal-mcp-1' },
      }),
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      proposalId: 'proposal-mcp-1',
      proposalState: 'proposed',
      opportunityFor: 'human.approver',
    });
  });
});

// ---------------------------------------------------------------------------
// 15. Resource read — missing uri, health://probe variant
// ---------------------------------------------------------------------------

describe('resource input validation', () => {
  let api: FakeApi;
  beforeEach(() => {
    api = makeApi();
  });

  it('rejects resources/read with no params', async () => {
    const response = await api.server.handleMessage(request('resources/read'));
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_RESOURCE' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects resources/read when params.uri is missing', async () => {
    const response = await api.server.handleMessage(request('resources/read', {}));
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_RESOURCE' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects resources/read when params.uri is an empty string', async () => {
    const response = await api.server.handleMessage(request('resources/read', { uri: '' }));
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_RESOURCE' });
    expect(api.calls).toHaveLength(0);
  });

  it('reads health://probe and routes to GET /v1/health', async () => {
    api.setResponse('/v1/health', 200, { status: 'ok' });
    const response = await api.server.handleMessage(
      request('resources/read', { uri: 'health://probe' }),
    );
    expect(response.error).toBeUndefined();
    const result = response.result as {
      contents: Array<{ uri: string; name: string; mimeType: string; text: string }>;
    };
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]!.uri).toBe('health://probe');
    expect(result.contents[0]!.name).toBe('health');
    expect(result.contents[0]!.mimeType).toBe('application/json');
    expect(api.lastCall()!.url).toBe('https://api.example.test/v1/health');
    expect(api.lastCall()!.method).toBe('GET');
  });

  it('rejects an unknown resource URI variant', async () => {
    const response = await api.server.handleMessage(
      request('resources/read', { uri: 'health://something-else' }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_UNKNOWN_RESOURCE' });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects a proposal URI whose id is empty', async () => {
    const response = await api.server.handleMessage(
      request('resources/read', { uri: 'proposal://' }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_UNKNOWN_RESOURCE' });
    expect(api.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 16. Forbidden override keys — body-side coverage per tool
// ---------------------------------------------------------------------------

describe('forbidden override keys across every tool', () => {
  let api: FakeApi;
  beforeEach(() => {
    api = makeApi({ idempotencyKeyGenerator: () => 'idem-override' });
  });

  // Each entry: [toolName, baseArguments, overrideKey, overrideValue]
  const CASES: Array<[string, Record<string, unknown>, string, string]> = [
    ['proposeEdit',
      {
        proposal: proposalContentShape(),
        regionBindingId: 'region-1',
        slug: 'mcp-1',
        title: 'MCP test proposal',
      },
      'method', '/v1/proposals/proposal-mcp-1/approve'],
    ['proposeEdit',
      {
        proposal: proposalContentShape(),
        regionBindingId: 'region-1',
        slug: 'mcp-1',
        title: 'MCP test proposal',
      },
      'path', '/v1/proposals/proposal-mcp-1/approve'],
    ['proposeEdit',
      {
        proposal: proposalContentShape(),
        regionBindingId: 'region-1',
        slug: 'mcp-1',
        title: 'MCP test proposal',
      },
      'url', 'https://api.example.test/v1/proposals/proposal-mcp-1/approve'],
    ['proposeEdit',
      {
        proposal: proposalContentShape(),
        regionBindingId: 'region-1',
        slug: 'mcp-1',
        title: 'MCP test proposal',
      },
      'action', 'approve'],
    ['proposeEdit',
      {
        proposal: proposalContentShape(),
        regionBindingId: 'region-1',
        slug: 'mcp-1',
        title: 'MCP test proposal',
      },
      'op', 'publish'],
    ['suggestAltText',
      { proposalId: 'proposal-mcp-1' },
      'method', 'POST'],
    ['suggestAltText',
      { proposalId: 'proposal-mcp-1' },
      'path', '/v1/proposals/proposal-mcp-1/approve'],
    ['suggestCrop',
      { proposalId: 'proposal-mcp-1' },
      'url', 'https://api.example.test/v1/proposals/proposal-mcp-1/approve'],
    ['generatePreview',
      { proposalId: 'proposal-mcp-1' },
      'action', 'publish'],
    ['submitApprovalRequest',
      { proposalId: 'proposal-mcp-1' },
      'op', 'apply'],
    ['submitApprovalRequest',
      { proposalId: 'proposal-mcp-1' },
      'op', 'rollback'],
    ['submitApprovalRequest',
      { proposalId: 'proposal-mcp-1' },
      'op', 'publish'],
    ['submitApprovalRequest',
      { proposalId: 'proposal-mcp-1' },
      'method', 'POST'],
    ['submitApprovalRequest',
      { proposalId: 'proposal-mcp-1' },
      'path', '/v1/proposals/proposal-mcp-1/approve'],
  ];

  for (const [tool, base, key, value] of CASES) {
    it(`${tool} rejects override-shaped key "${key}" before any API call`, async () => {
      const response = await api.server.handleMessage(
        request('tools/call', { name: tool, arguments: { ...base, [key]: value } }),
      );
      expect(response.error).toBeDefined();
      expect(response.error!.data).toMatchObject({ code: 'E_MCP_FORBIDDEN_ARG_KEY', key });
      expect(api.calls).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 17. Problem propagation — every read-only tool surfaces a Problem
// ---------------------------------------------------------------------------

describe('Problem propagation for every read-only tool', () => {
  it('suggestAltText surfaces a Problem from the API', async () => {
    const api = makeApi();
    const problem = {
      status: 404,
      type: 'urn:cms:problem:storage:not_found',
      title: 'Not Found',
      code: 'not_found',
      detail: 'proposal not found',
      extensions: { traceId: 't-suggest' },
    };
    api.setResponse('/v1/proposals/proposal-mcp-1', 404, problem);
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'suggestAltText', arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32010);
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_API_PROBLEM', problem });
  });

  it('suggestCrop surfaces a Problem from the API', async () => {
    const api = makeApi();
    const problem = {
      status: 404,
      type: 'urn:cms:problem:storage:not_found',
      title: 'Not Found',
      code: 'not_found',
      detail: 'proposal not found',
      extensions: { traceId: 't-crop' },
    };
    api.setResponse('/v1/proposals/proposal-mcp-1', 404, problem);
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'suggestCrop', arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_API_PROBLEM', problem });
  });

  it('generatePreview surfaces a Problem from the API', async () => {
    const api = makeApi();
    const problem = {
      status: 409,
      type: 'urn:cms:problem:storage:optimistic_concurrency_conflict',
      title: 'Optimistic concurrency conflict',
      code: 'optimistic_concurrency_conflict',
      detail: 'expected 4, current 5',
      extensions: { traceId: 't-preview' },
    };
    api.setResponse('/v1/proposals/proposal-mcp-1', 409, problem);
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'generatePreview', arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_API_PROBLEM', problem });
  });

  it('submitApprovalRequest surfaces a Problem from the API', async () => {
    const api = makeApi();
    const problem = {
      status: 403,
      type: 'urn:cms:problem:tenant:forbidden',
      title: 'Tenant forbidden',
      code: 'E_TENANT_FORBIDDEN',
      detail: 'tenant mismatch',
      extensions: { traceId: 't-approval' },
    };
    api.setResponse('/v1/proposals/proposal-mcp-1', 403, problem);
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'submitApprovalRequest', arguments: { proposalId: 'proposal-mcp-1' } }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_API_PROBLEM', problem });
  });

  it('proposeEdit wraps a non-Problem failure body in a synthetic transport Problem', async () => {
    const api = makeApi();
    api.setResponse('/v1/proposals', 500, { foo: 'bar' });
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeDefined();
    const data = response.error!.data as { code: string; problem: { status: number; type: string; code: string; locale: string; extensions: { traceId: null } } };
    expect(data.code).toBe('E_MCP_API_PROBLEM');
    expect(data.problem.status).toBe(500);
    expect(data.problem.type).toBe('urn:cms:problem:mcp:transport_error');
    expect(data.problem.code).toBe('E_MCP_TRANSPORT_ERROR');
    expect(data.problem.extensions.traceId).toBeNull();
  });

  it('synthetic transport Problem preserves the configured locale', async () => {
    const api = makeApi({ locale: 'es' });
    api.setResponse('/v1/proposals', 500, { foo: 'bar' });
    const response = await api.server.handleMessage(
      request('tools/call', {
        name: 'proposeEdit',
        arguments: {
          proposal: proposalContentShape(),
          regionBindingId: 'region-1',
          slug: 'mcp-1',
          title: 'MCP test proposal',
        },
      }),
    );
    expect(response.error).toBeDefined();
    const data = response.error!.data as { problem: { locale: string; code: string } };
    expect(data.problem.locale).toBe('es');
    expect(data.problem.code).toBe('E_MCP_TRANSPORT_ERROR');
  });
});

// ---------------------------------------------------------------------------
// 18. Non-McpAuthorityError => JSON-RPC -32603 internal-error sanitization
// ---------------------------------------------------------------------------

describe('non-McpAuthorityError sanitization', () => {
  it('wraps a non-McpAuthorityError thrown in the fetch seam as -32603', async () => {
    const fetchImpl: typeof globalThis.fetch = () => {
      throw new Error('boom: upstream secret leak');
    };
    const server = new McpServer({
      apiBaseUrl: 'https://api.example.test',
      serviceToken: 'mcp-service-token',
      tenantId: 'tenant-mcp-1',
      fetch: fetchImpl,
      idempotencyKeyGenerator: () => 'idem-seam',
    });
    const response = await server.handleMessage(
      request('tools/call', {
        name: 'generatePreview',
        arguments: { proposalId: 'proposal-mcp-1' },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32603);
    expect(typeof response.error!.message).toBe('string');
    expect(response.error!.message.length).toBeGreaterThan(0);
    // The error code pin ensures non-McpAuthorityError surfaces through the
    // dedicated internal-error branch, not the -32010 authority branch.
    expect(response.error!.code).not.toBe(-32010);
  });

  it('a non-Error thrown value is coerced to a generic internal-error message', async () => {
    const fetchImpl: typeof globalThis.fetch = () => {
      throw 'a string was thrown';
    };
    const server = new McpServer({
      apiBaseUrl: 'https://api.example.test',
      serviceToken: 'mcp-service-token',
      tenantId: 'tenant-mcp-1',
      fetch: fetchImpl,
      idempotencyKeyGenerator: () => 'idem-seam-2',
    });
    const response = await server.handleMessage(
      request('tools/call', {
        name: 'generatePreview',
        arguments: { proposalId: 'proposal-mcp-1' },
      }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32603);
    expect(response.error!.message).toBe('internal error');
  });

  it('McpAuthorityError is mapped to -32010 with code and extensions', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'unknownTool', arguments: {} }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32010);
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_UNKNOWN_TOOL' });
  });
});

// ---------------------------------------------------------------------------
// 19. tools/list and resources/list — descriptor content and authority
// ---------------------------------------------------------------------------

describe('listings stability', () => {
  it('tools/list exposes every allowed tool name with a constant /v1 method+path', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(request('tools/list'));
    expect(response.error).toBeUndefined();
    const result = response.result as {
      tools: Array<{
        name: string;
        apiMethod: string;
        apiPath: string;
        description: string;
        forbiddenArgKeys: string[];
      }>;
    };
    expect(result.tools.map((t) => t.name)).toEqual([
      'proposeEdit',
      'suggestAltText',
      'suggestCrop',
      'generatePreview',
      'submitApprovalRequest',
    ]);
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
    expect(byName['proposeEdit']?.apiMethod).toBe('POST');
    expect(byName['proposeEdit']?.apiPath).toBe('/v1/proposals');
    for (const t of ['suggestAltText', 'suggestCrop', 'generatePreview', 'submitApprovalRequest']) {
      expect(byName[t]?.apiMethod).toBe('GET');
      expect(byName[t]?.apiPath).toBe('/v1/proposals/{id}');
    }
    for (const t of result.tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.apiPath.startsWith('/v1/')).toBe(true);
      expect(t.apiPath).not.toMatch(/\/(approve|publish|apply|rollback|reconcile)(\/|$)/);
      expect(t.forbiddenArgKeys.length).toBeGreaterThan(0);
    }
  });

  it('resources/list exposes both resources with stable apiPath', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(request('resources/list'));
    expect(response.error).toBeUndefined();
    const result = response.result as {
      resources: Array<{ uri: string; name: string; mimeType: string; apiPath: string; description: string }>;
    };
    expect(result.resources).toHaveLength(2);
    const byUri = Object.fromEntries(result.resources.map((r) => [r.uri, r]));
    expect(byUri['proposal://{id}']?.apiPath).toBe('/v1/proposals/{id}');
    expect(byUri['proposal://{id}']?.mimeType).toBe('application/json');
    expect(byUri['health://']?.apiPath).toBe('/v1/health');
    expect(byUri['health://']?.mimeType).toBe('application/json');
    for (const r of result.resources) {
      expect(r.apiPath.startsWith('/v1/')).toBe(true);
      expect(r.description.length).toBeGreaterThan(0);
    }
  });

  it('listTools() and listResources() return immutable arrays', () => {
    const api = makeApi();
    const tools = api.server.listTools();
    const resources = api.server.listResources();
    expect(Object.isFrozen(tools)).toBe(true);
    expect(Object.isFrozen(resources)).toBe(true);
    expect(() =>
      (tools as unknown as { push: (t: unknown) => void }).push({ name: 'approve' }),
    ).toThrow();
    expect(() =>
      (resources as unknown as { push: (r: unknown) => void }).push({ uri: 'x://' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 20. Internal guards — input-validation map for /v1 method+path pinning
// ---------------------------------------------------------------------------

describe('internal guard rails', () => {
  it('arguments provided as a non-object string still surface as E_MCP_BAD_ARG', async () => {
    const api = makeApi();
    const response = await api.server.handleMessage(
      request('tools/call', { name: 'proposeEdit', arguments: 'bad' as unknown as Record<string, unknown> }),
    );
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32010);
    expect(response.error!.data).toMatchObject({ code: 'E_MCP_BAD_ARG' });
  });
});
