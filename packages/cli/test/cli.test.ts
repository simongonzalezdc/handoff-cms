/**
 * Behavioural tests for @cms/cli.
 *
 * These tests run the real `runCli` function with deterministic fakes:
 *   - a `fetchFn` that records each request and replies with a canned
 *     success or RFC 9457 Problem JSON based on a programmable matrix;
 *   - a `browser` seam that records each call and returns a delegated
 *     session only when the matrix allows it;
 *   - a `uuid` that emits a fixed idempotency key for assertions.
 *
 * Coverage targets:
 *   1. Help / health.
 *   2. Read commands (proposal.get / proposal.deploy.status) do NOT call
 *      the browser and accept any token kind.
 *   3. Propose (proposal.create) accepts configured credentials but never
 *      calls the browser seam.
 *   4. Privileged commands (approve / publish / rollback) MUST fail closed
 *      for `cli_service`, `mcp_identity`, `env_token`, and `none` kinds.
 *      They MUST succeed only via a fresh interactive delegated-human
 *      session returned by the injected browser seam.
 *   5. The runner preserves RFC 9457 Problem Details (en / es) and
 *      forwards Idempotency-Key, If-Match, X-Tenant-Id, and the
 *      Authorization header through the fetch call.
 *   6. Exit codes come from the Problem `code` and CLI-internal errors.
 *
 * No API / storage mocking; the API is the authority surface and the CLI
 * verifies only that it calls the right paths, with the right headers,
 * and interprets the wire shape faithfully.
 */
import { describe, expect, it } from 'vitest';
import {
  __testing,
  ensureProposalShape,
  exitCodeForProblem,
  parseArgv,
  resolveCommand,
  resolveConfig,
  runCli,
  type BrowserAuthorizationSeam,
  type CliDeps,
  type DelegatedHumanSession,
} from '../src/index.js';
import { loadBrowserSeam } from '../src/bin.js';

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Record<string, string>;
}

interface FetchHarness {
  readonly fetchFn: CliDeps['fetchFn'];
  readonly calls: FetchCall[];
}

function makeFetch(): FetchHarness {
  const calls: FetchCall[] = [];
  const fetchFn = (async (url: string, init: RequestInit): Promise<Response> => {
    const headers = lowerHeaders(init.headers);
    calls.push({ url, init, headers });
    if (headers['authorization'] === undefined) {
      return problemResponse(401, 'en', 'unauthorized', 'missing bearer token', 'E_UNAUTHORIZED');
    }
    const auth = headers['authorization'];
    if (auth === 'Bearer human.fake.token') {
      return url.endsWith('/v1/health')
        ? okResponse({ status: 'ok' })
        : okResponse({ id: 'p1', tenant_id: 'tnt-1', state: 'proposed', version: 1 });
    }
    if (auth === 'Bearer human.fake.session') {
      return okResponse({ id: 'p1', tenant_id: 'tnt-1', state: 'proposed', version: 1 });
    }
    if (auth === 'Bearer env.static.token') {
      return problemResponse(403, 'en', 'forbidden', 'service identity not allowed', 'E_SERVICE_APPROVAL_FORBIDDEN');
    }
    if (auth === 'Bearer svc.cli.token') {
      return problemResponse(403, 'en', 'forbidden', 'service identity not allowed', 'E_SERVICE_APPROVAL_FORBIDDEN');
    }
    if (auth === 'Bearer mcp.identity.token') {
      return problemResponse(403, 'en', 'forbidden', 'mcp identity cannot approve', 'E_TOKEN_KIND_FORBIDDEN');
    }
    return problemResponse(500, 'en', 'server', 'unhandled', 'E_INTERNAL');
  }) as CliDeps['fetchFn'];
  return { fetchFn, calls };
}

interface BrowserHarness {
  readonly seam: BrowserAuthorizationSeam;
  readonly calls: number;
}

function makeBrowser(allow: boolean, session?: DelegatedHumanSession): BrowserHarness {
  const fixedSession: DelegatedHumanSession = session ?? {
    token: 'human.fake.session',
    subject: 'fake-human-actor',
    displayName: 'Fake Operator',
    issuedAt: '2026-07-27T12:00:00.000Z',
    expiresAt: '2099-07-27T13:00:00.000Z',
    deviceCode: 'dev-1',
    userCode: 'USR-CODE',
    verificationUri: 'https://device.example/activate',
    tenantId: 'tnt-1',
  };
  const harness: BrowserHarness = {
    calls: 0,
    seam: {
      async requestInteractiveDelegatedSession({ tenantId }) {
        harness.calls += 1;
        if (!allow) {
          throw new Error('browser seam was denied');
        }
        if (tenantId !== 'tnt-1') {
          throw new Error('browser seam tenant mismatch');
        }
        return { ...fixedSession, tenantId };
      },
    },
  };
  return harness;
}

function silentStream(): NodeJS.WritableStream {
  return {
    writable: true,
    write: () => true,
    once(_event: 'finish' | 'error' | 'close', _listener: (...args: unknown[]) => void): NodeJS.WritableStream {
      return this as unknown as NodeJS.WritableStream;
    },
    on(_event: string, _listener: (...args: unknown[]) => void): NodeJS.WritableStream {
      return this as unknown as NodeJS.WritableStream;
    },
    off(_event: string, _listener: (...args: unknown[]) => void): NodeJS.WritableStream {
      return this as unknown as NodeJS.WritableStream;
    },
    emit(_event: string, ..._args: unknown[]): boolean {
      return true;
    },
    end(_cb?: (...args: unknown[]) => void): NodeJS.WritableStream {
      return this as unknown as NodeJS.WritableStream;
    },
    removeListener(_event: string, _listener: (...args: unknown[]) => void): NodeJS.WritableStream {
      return this as unknown as NodeJS.WritableStream;
    },
    removeAllListeners(_event?: string): NodeJS.WritableStream {
      return this as unknown as NodeJS.WritableStream;
    },
    setMaxListeners(_n: number): NodeJS.WritableStream {
      return this as unknown as NodeJS.WritableStream;
    },
    getMaxListeners(): number {
      return 0;
    },
    listeners(_event: string): Array<(...args: unknown[]) => void> {
      return [];
    },
    rawListeners(_event: string): Array<(...args: unknown[]) => void> {
      return [];
    },
    listenerCount(_event: string): number {
      return 0;
    },
    eventNames(): Array<string | symbol> {
      return [];
    },
    addListener(_event: string, _listener: (...args: unknown[]) => void): NodeJS.WritableStream {
      return this as unknown as NodeJS.WritableStream;
    },
  } as unknown as NodeJS.WritableStream;
}

function lowerHeaders(input: RequestInit['headers']): Record<string, string> {
  if (input === undefined) return {};
  if (input instanceof Headers) {
    const record: Record<string, string> = {};
    input.forEach((value, key) => {
      record[key.toLowerCase()] = value;
    });
    return record;
  }
  if (Array.isArray(input)) {
    const record: Record<string, string> = {};
    for (const [k, v] of input) {
      record[k.toLowerCase()] = String(v);
    }
    return record;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, string>)) {
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function problemResponse(
  status: number,
  locale: 'en' | 'es',
  title: string,
  detail: string,
  code: string,
): Response {
  return new Response(
    JSON.stringify({
      type: `urn:cms:${code.toLowerCase()}`,
      title,
      status,
      detail,
      instance: '/v1/example',
      code,
      locale,
      extensions: { traceId: 'trace-1' },
    }),
    {
      status,
      headers: { 'content-type': 'application/problem+json; charset=UTF-8' },
    },
  );
}

function baseEnv(token: string | undefined): Record<string, string | undefined> {
  return {
    CMS_API_BASE_URL: 'https://api.test',
    CMS_TENANT_ID: 'tnt-1',
    CMS_LOCALE: 'en',
    ...(token !== undefined ? { CMS_TOKEN: token } : {}),
  };
}

const PROPOSAL_BODY = JSON.stringify({
  proposal: {
    kind: 'content',
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: 'tnt-1',
    contentType: 'post',
    environment: 'staging',
    action: 'create',
    createdAt: '2026-07-27T12:00:00.000Z',
    localizedTitle: { en: 'Title EN', es: 'Título ES' },
    localizedBody: { en: 'Body EN', es: 'Cuerpo ES' },
    canonicalRepoPath: 'content/posts/2026/07/27/hello.md',
  },
  regionBindingId: '11111111-1111-1111-1111-111111111112',
  slug: 'hello-world',
  title: 'Hello world',
});

describe('@cms/cli', () => {
  it('help renders the command reference and exits 0', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(false);
    const result = await runCli({
      argv: ['help'],
      env: baseEnv(undefined),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe('help');
    expect(fetch.calls).toHaveLength(0);
    expect(result.stdout).toContain('handoff-cms CLI');
  });

  it('ships no fake delegated-human seam and fails closed without device endpoints', async () => {
    const fake = await loadBrowserSeam({ CMS_BROWSER_SEAM: 'fake' });
    expect(fake.name).toBe('unknown');
    await expect(
      fake.seam.requestInteractiveDelegatedSession({
        tenantId: 'tnt-1',
        audience: 'cms-api-aud',
        verificationUri: 'https://device.example/activate',
      }),
    ).rejects.toThrow(/only 'deny' and 'device'/);

    const device = await loadBrowserSeam({ CMS_BROWSER_SEAM: 'device' });
    await expect(
      device.seam.requestInteractiveDelegatedSession({
        tenantId: 'tnt-1',
        audience: 'cms-api-aud',
        verificationUri: 'https://device.example/activate',
      }),
    ).rejects.toThrow(/requires CMS_DEVICE_AUTHORIZATION_ENDPOINT/);
  });

  it('health performs a GET to /v1/health and unwraps json body', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(false);
    const result = await runCli({
      argv: ['health', '--tenant', 'tnt-1', '--format', 'json'],
      env: baseEnv('human.fake.token'),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe('https://api.test/v1/health');
    expect(fetch.calls[0]?.headers['x-tenant-id']).toBe('tnt-1');
    expect(fetch.calls[0]?.headers['accept-language']).toBe('en');
    expect(result.stdout).toContain('"status"');
  });

  it('proposal.get reads without invoking the browser seam', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(false);
    const result = await runCli({
      argv: ['proposal', 'get', 'p1', '--tenant', 'tnt-1'],
      env: baseEnv('human.fake.token'),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(browser.calls).toBe(0);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe('https://api.test/v1/proposals/p1');
    expect(result.stdout).toContain('"state": "proposed"');
  });

  it('proposal.create attaches Idempotency-Key and the configured bearer', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(false);
    const env = baseEnv('human.fake.token');
    const result = await runCli({
      argv: [
        'proposal',
        'create',
        '--tenant',
        'tnt-1',
        '--idempotency-key',
        'cli-2026-07-27-fixed-1',
        '--data',
        PROPOSAL_BODY,
        '--format',
        'json',
      ],
      env,
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(browser.calls).toBe(0);
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0];
    expect(call?.url).toBe('https://api.test/v1/proposals');
    expect(call?.headers['idempotency-key']).toBe('cli-2026-07-27-fixed-1');
    expect(call?.headers['authorization']).toBe('Bearer human.fake.token');
    expect(call?.headers['x-tenant-id']).toBe('tnt-1');
    expect(call?.headers['content-type']).toBe('application/json');
    const bodyText = (call?.init.body as string) ?? '';
    expect(bodyText).toContain('"regionBindingId"');
    expect(bodyText).toContain('"proposal"');
  });

  it('privilege gate: service token cannot approve', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(false);
    const result = await runCli({
      argv: [
        'proposal',
        'approve',
        'p1',
        '--tenant',
        'tnt-1',
        '--expect-version',
        '1',
        '--data',
        PROPOSAL_BODY,
      ],
      env: baseEnv('svc:cli-token'),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(77);
    expect(result.command).toBe('proposal.approve');
    expect(fetch.calls).toHaveLength(0);
    expect(browser.calls).toBe(1);
    expect(result.stderr).toContain('E_SERVICE_APPROVAL_FORBIDDEN');
  });

  it('privilege gate: MCP identity token cannot publish', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(false);
    const result = await runCli({
      argv: [
        'proposal',
        'publish',
        'p1',
        '--tenant',
        'tnt-1',
        '--expect-version',
        '1',
        '--data',
        PROPOSAL_BODY,
      ],
      env: baseEnv('mcp:mcp-token'),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(77);
    expect(fetch.calls).toHaveLength(0);
    expect(browser.calls).toBe(1);
    expect(result.stderr).toContain('E_TOKEN_KIND_FORBIDDEN');
  });

  it('privilege gate: static env token cannot rollback', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(false);
    const result = await runCli({
      argv: [
        'proposal',
        'rollback',
        'p1',
        '--tenant',
        'tnt-1',
        '--expect-version',
        '1',
        '--data',
        PROPOSAL_BODY,
      ],
      env: baseEnv('static-token'),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(77);
    expect(fetch.calls).toHaveLength(0);
    expect(browser.calls).toBe(1);
    expect(result.stderr).toContain('E_INTERACTIVE_AUTH_REQUIRED');
  });

  it('privilege gate: missing token also fails closed', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(false);
    const result = await runCli({
      argv: [
        'proposal',
        'approve',
        'p1',
        '--tenant',
        'tnt-1',
        '--expect-version',
        '1',
        '--data',
        PROPOSAL_BODY,
      ],
      env: baseEnv(undefined),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(77);
    expect(fetch.calls).toHaveLength(0);
    expect(browser.calls).toBe(1);
    expect(result.stderr).toContain('E_INTERACTIVE_AUTH_REQUIRED');
  });

  it('approve forwards If-Match and Authorization when a delegated session is supplied', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(true);
    // Use the classifier-escaped path: ship a delegated token that the
    // auth seam recognizes as `delegated_human_fresh_interactive`.
    const delegatedToken = encodeDelegatedJwt('tnt-1', 'human-actor-1');
    const result = await runCli({
      argv: [
        'proposal',
        'approve',
        'p1',
        '--tenant',
        'tnt-1',
        '--expect-version',
        '7',
        '--data',
        PROPOSAL_BODY,
      ],
      env: baseEnv(delegatedToken),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(browser.calls).toBe(1);
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0];
    expect(call?.headers['if-match']).toBe('7');
    expect(call?.headers['idempotency-key']).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(call?.headers['authorization']).toBe('Bearer human.fake.session');
  });

  it('approve forwards fetch with the delegated bearer derived via the browser seam (auto-token)', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(true);
    // No CMS_TOKEN supplied; the runner must use the browser seam to
    // produce a delegated-human credential. We model that by routing
    // through a thin orchestrator that wraps `runCli` and uses the same
    // public surface.
    const result = await runCli({
      argv: [
        'proposal',
        'approve',
        'p1',
        '--tenant',
        'tnt-1',
        '--expect-version',
        '3',
        '--data',
        PROPOSAL_BODY,
      ],
      env: baseEnv(undefined),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(browser.calls).toBe(1);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.headers['authorization']).toBe('Bearer human.fake.session');
  });

  it.each(['publish', 'rollback'] as const)(
    '%s uses a fresh interactive bearer and forwards mutation guards',
    async (action) => {
      const fetch = makeFetch();
      const browser = makeBrowser(true);
      const result = await runCli({
        argv: [
          'proposal',
          action,
          'p1',
          '--tenant',
          'tnt-1',
          '--expect-version',
          '9',
          '--data',
          PROPOSAL_BODY,
        ],
        env: baseEnv('svc:cli-token'),
        deps: {
          fetchFn: fetch.fetchFn,
          stdout: silentStream(),
          stderr: silentStream(),
          browser: browser.seam,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(browser.calls).toBe(1);
      expect(fetch.calls).toHaveLength(1);
      expect(fetch.calls[0]?.url).toBe(`https://api.test/v1/proposals/p1/${action}`);
      expect(fetch.calls[0]?.headers['authorization']).toBe('Bearer human.fake.session');
      expect(fetch.calls[0]?.headers['if-match']).toBe('9');
      expect(fetch.calls[0]?.headers['idempotency-key']).toMatch(/^[A-Za-z0-9._:-]+$/);
    },
  );

  it('locale: rejects invalid locale and forwards Accept-Language per flag', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(false);
    const bad = await runCli({
      argv: ['health', '--tenant', 'tnt-1', '--locale', 'fr'],
      env: baseEnv(undefined),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(bad.exitCode).toBe(64);

    const good = await runCli({
      argv: ['health', '--tenant', 'tnt-1', '--locale', 'es', '--format', 'json'],
      env: baseEnv('human.fake.token'),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(good.exitCode).toBe(0);
    expect(fetch.calls[0]?.headers['accept-language']).toBe('es');
  });

  it('problem responses propagate to stderr with the right exit code and trace id', async () => {
    const fetchFn: CliDeps['fetchFn'] = (async (_url: string, _init: RequestInit): Promise<Response> => {
      return problemResponse(428, 'es', 'requiere version', 'falta If-Match', 'E_VERSION_HEADER_REQUIRED');
    }) as CliDeps['fetchFn'];
    const result = await runCli({
      argv: ['proposal', 'get', 'p1', '--tenant', 'tnt-1', '--locale', 'es'],
      env: baseEnv('svc:cli-token'),
      deps: {
        fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: makeBrowser(false).seam,
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('E_VERSION_HEADER_REQUIRED');
    expect(result.stderr).toContain('locale=es');
    expect(result.stderr).toContain('trace: trace-1');
  });

  it('network errors surface as exit code 3', async () => {
    const fetchFn: CliDeps['fetchFn'] = (async (): Promise<Response> => {
      throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:8787');
    }) as CliDeps['fetchFn'];
    const result = await runCli({
      argv: ['health', '--tenant', 'tnt-1'],
      env: baseEnv(undefined),
      deps: {
        fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: makeBrowser(false).seam,
      },
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('ECONNREFUSED');
  });

  it('reconcile succeeds only via delegated token and forwards If-Match', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(true);
    const delegatedToken = encodeDelegatedJwt('tnt-1', 'human-actor-1');
    const result = await runCli({
      argv: [
        'proposal',
        'deploy',
        'reconcile',
        'p1',
        '--tenant',
        'tnt-1',
        '--expect-version',
        '4',
        '--success',
        'true',
        '--format',
        'json',
      ],
      env: baseEnv(delegatedToken),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(browser.calls).toBe(1);
    expect(fetch.calls[0]?.url).toBe('https://api.test/v1/proposals/p1/reconcile');
    expect(fetch.calls[0]?.headers['if-match']).toBe('4');
    expect(fetch.calls[0]?.headers['authorization']).toBe('Bearer human.fake.session');
  });

  it('deploy status is a read and uses the configured bearer (no browser)', async () => {
    const fetch = makeFetch();
    const browser = makeBrowser(false);
    const result = await runCli({
      argv: ['proposal', 'deploy', 'status', 'p1', '--tenant', 'tnt-1', '--format', 'json'],
      env: baseEnv('env.static.token'),
      deps: {
        fetchFn: fetch.fetchFn,
        stdout: silentStream(),
        stderr: silentStream(),
        browser: browser.seam,
      },
    });
    // Reads do not invoke the browser. The configured bearer is forwarded,
    // and the API's authority response maps to a stable CLI exit code.
    expect(browser.calls).toBe(0);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe('https://api.test/v1/proposals/p1');
    expect(fetch.calls[0]?.headers['authorization']).toBe('Bearer env.static.token');
    expect(result.exitCode).toBe(77);
  });

  it('expect-version is required for approve / publish / rollback / reconcile', async () => {
    const fetch = makeFetch();
    const delegated = encodeDelegatedJwt('tnt-1', 'human-actor-1');
    const bases = [
      ['proposal', 'approve', 'p1'],
      ['proposal', 'publish', 'p1'],
      ['proposal', 'rollback', 'p1'],
      ['proposal', 'deploy', 'reconcile', 'p1', '--success', 'true'],
    ];
    for (const base of bases) {
      const result = await runCli({
        argv: [...base, '--tenant', 'tnt-1', '--data', PROPOSAL_BODY],
        env: baseEnv(delegated),
        deps: {
          fetchFn: fetch.fetchFn,
          stdout: silentStream(),
          stderr: silentStream(),
          browser: makeBrowser(false).seam,
        },
      });
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain('--expect-version');
    }
  });

  it('argv parser tolerates --flag=value forms and combined values', async () => {
    const { parseArgv } = await import('../src/index.js');
    const parsed = parseArgv([
      'proposal',
      'create',
      '--tenant=alpha',
      '--locale',
      'es',
      '--format',
      'json',
    ]);
    expect(parsed.positional).toEqual(['proposal', 'create']);
    expect(parsed.flags.get('tenant')).toBe('alpha');
    expect(parsed.flags.get('locale')).toBe('es');
    expect(parsed.flags.get('format')).toBe('json');
    expect(parsed.flags.get('not-set')).toBeUndefined();
  });
  it.each([
    ['E_BAD_REQUEST', 65],
    ['invalid_input', 65],
    ['E_SERVICE_APPROVAL_FORBIDDEN', 77],
    ['E_MCP_APPROVAL_FORBIDDEN', 77],
    ['E_TOKEN_KIND_FORBIDDEN', 77],
    ['E_INTERACTIVE_AUTH_REQUIRED', 77],
    ['E_TENANT_MISMATCH', 77],
    ['E_TOKEN_EXPIRED', 77],
    ['E_INVALID_IDENTITY', 77],
    ['E_TENANT_FORBIDDEN', 77],
    ['E_INSUFFICIENT_AUTHORITY', 77],
    ['E_ACTION_FORBIDDEN', 77],
    ['E_SELF_APPROVAL_FORBIDDEN', 77],
    ['not_found', 2],
    ['E_OPTIMISTIC_CONCURRENCY_CONFLICT', 4],
    ['optimistic_concurrency_conflict', 4],
    ['idempotency_replay_mismatch', 4],
    ['idempotency_in_progress', 4],
    ['connection_failed', 3],
    ['E_UNKNOWN', 2],
    ['unknown', 1],
  ] as const)('maps API problem %s to exit code %s', (code, expected) => {
    expect(exitCodeForProblem({
      type: 'urn:test',
      title: 'test',
      status: 400,
      detail: 'test',
      instance: 'test',
      code,
      locale: 'en',
      extensions: {},
    })).toBe(expected);
  });

  it.each([
    [[], 'help'],
    [['proposals', 'get', 'p1'], 'proposal.get'],
    [['deploy', 'status', 'p1'], 'proposal.deploy.status'],
  ] as const)('resolves command alias %j to %s', (argv, expected) => {
    expect(resolveCommand(argv)).toBe(expected);
  });

  it.each([
    [['unknown'], 'unknown command'],
    [['proposal', 'get'], 'proposal get <id>'],
    [['proposal', 'approve'], 'proposal approve <id>'],
    [['proposal', 'publish'], 'proposal publish <id>'],
    [['proposal', 'rollback'], 'proposal rollback <id>'],
    [['proposal', 'deploy', 'status'], 'proposal deploy status <proposalId>'],
    [['proposal', 'deploy', 'reconcile'], 'proposal deploy reconcile <proposalId>'],
    [['proposal', 'deploy'], 'unknown command'],
    [['deploy', 'reconcile', 'p1'], 'unknown command'],
  ] as const)('fails closed for invalid command argv %j', (argv, message) => {
    expect(() => resolveCommand(argv)).toThrow(message);
  });

  it('fails closed for invalid format, locale, and missing tenant configuration', () => {
    expect(() => resolveConfig(['--tenant', 'tnt-1', '--format', 'yaml'], {}, undefined)).toThrow('--format');
    expect(() => resolveConfig(['--tenant', 'tnt-1', '--locale', 'fr'], {}, undefined)).toThrow('--locale');
    expect(() => resolveConfig([], {}, undefined)).toThrow('--tenant');
  });

  it('rejects proposal payloads without a proposal object', () => {
    expect(() => ensureProposalShape({}, 'proposal.create')).toThrow('proposal');
    expect(() => ensureProposalShape({ proposal: null }, 'proposal.create')).toThrow('proposal');
    expect(ensureProposalShape({ proposal: { kind: 'content' } }, 'proposal.create')).toEqual({
      proposal: { kind: 'content' },
    });
  });
});

// ---------------------------------------------------------------------------
// `loadBrowserSeam` device authorization seam — direct coverage of every
// while-loop branch and response validator. Runs the production seam with a
// deterministic runtime: scripted fetch, virtual clock, and a no-op sleep.
// No real network or setTimeout is used.
// ---------------------------------------------------------------------------

async function loadDeviceSeam(input: {
  readonly fetchFn: CliDeps['fetchFn'];
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly writeStderr: (chunk: string) => void;
}): Promise<Awaited<ReturnType<typeof loadBrowserSeam>>['seam']> {
  const loaded = await loadBrowserSeam(
    {
      CMS_BROWSER_SEAM: 'device',
      CMS_DEVICE_AUTHORIZATION_ENDPOINT: 'https://idp.test/device/authorize',
      CMS_DEVICE_TOKEN_ENDPOINT: 'https://idp.test/device/token',
    },
    {
      fetchFn: input.fetchFn,
      now: input.now,
      sleep: input.sleep,
      writeStderr: input.writeStderr,
    },
  );
  return loaded.seam;
}

describe('loadBrowserSeam device authorization', () => {
  it('returns a delegated session on the first successful token poll', async () => {
    const fetchCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const stderr: string[] = [];
    const fetchFn: CliDeps['fetchFn'] = (async (url: string, init: RequestInit) => {
      const lower = lowerHeaders(init.headers);
      fetchCalls.push({ url, body: JSON.parse(String(init.body)), headers: lower });
      const payload = url.endsWith('/authorize')
        ? {
            device_code: 'dev-immediate',
            user_code: 'USR-IMMED',
            verification_uri: 'https://device.test/activate',
            verification_uri_complete: 'https://device.test/activate?code=USR-IMMED',
            expires_in: 600,
            interval: 0,
          }
        : {
            access_token: 'tok-immediate',
            token_type: 'Bearer',
            subject: 'human-immediate',
            display_name: 'Operator Immediate',
            expires_in: 300,
            scope: 'human',
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as CliDeps['fetchFn'];
    const seam = await loadDeviceSeam({
      fetchFn,
      now: () => 0,
      sleep: async () => undefined,
      writeStderr: (chunk: string) => {
        stderr.push(chunk);
      },
    });
    const session = await seam.requestInteractiveDelegatedSession({
      tenantId: 'tnt-1',
      audience: 'cms-api-aud',
      verificationUri: 'https://device.test/activate',
    });
    expect(session.token).toBe('tok-immediate');
    expect(session.subject).toBe('human-immediate');
    expect(session.displayName).toBe('Operator Immediate');
    expect(session.deviceCode).toBe('dev-immediate');
    expect(session.userCode).toBe('USR-IMMED');
    expect(session.verificationUri).toBe('https://device.test/activate');
    expect(session.tenantId).toBe('tnt-1');
    expect(fetchCalls).toHaveLength(2);
    expect(stderr.join('')).toContain('USR-IMMED');
    expect(stderr.join('')).toContain('https://device.test/activate');
    const authCall = fetchCalls[0];
    const tokenCall = fetchCalls[1];
    expect(authCall?.body).toMatchObject({ tenant_id: 'tnt-1', audience: 'cms-api-aud' });
    expect(tokenCall?.body).toMatchObject({ device_code: 'dev-immediate', tenant_id: 'tnt-1' });
  });

  it('keeps polling on authorization_pending then succeeds', async () => {
    const stderr: string[] = [];
    let tokenCalls = 0;
    const fetchFn: CliDeps['fetchFn'] = (async (url: string, init: RequestInit) => {
      void init;
      if (url.endsWith('/authorize')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev-pending',
            user_code: 'USR-PEND',
            verification_uri: 'https://device.test/activate',
            expires_in: 600,
            interval: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      tokenCalls += 1;
      const payload =
        tokenCalls === 1
          ? { error: 'authorization_pending' }
          : {
              access_token: 'tok-pending',
              token_type: 'Bearer',
              subject: 'human-pending',
              expires_in: 300,
            };
      return new Response(JSON.stringify(payload), {
        status: tokenCalls === 1 ? 400 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as CliDeps['fetchFn'];
    const seam = await loadDeviceSeam({
      fetchFn,
      now: () => 0,
      sleep: async () => undefined,
      writeStderr: (chunk: string) => {
        stderr.push(chunk);
      },
    });
    const session = await seam.requestInteractiveDelegatedSession({
      tenantId: 'tnt-1',
      audience: 'cms-api-aud',
      verificationUri: 'https://device.test/activate',
    });
    expect(tokenCalls).toBe(2);
    expect(session.token).toBe('tok-pending');
    expect(session.subject).toBe('human-pending');
    expect(stderr.join('')).toContain('USR-PEND');
  });

  it('increments interval on slow_down then succeeds', async () => {
    const stderr: string[] = [];
    let tokenCalls = 0;
    const fetchFn: CliDeps['fetchFn'] = (async (url: string, init: RequestInit) => {
      void init;
      if (url.endsWith('/authorize')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev-slow',
            user_code: 'USR-SLOW',
            verification_uri: 'https://device.test/activate',
            expires_in: 600,
            interval: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      tokenCalls += 1;
      const payload =
        tokenCalls === 1
          ? { error: 'slow_down' }
          : {
              access_token: 'tok-slow',
              token_type: 'Bearer',
              subject: 'human-slow',
              expires_in: 300,
            };
      return new Response(JSON.stringify(payload), {
        status: tokenCalls === 1 ? 400 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as CliDeps['fetchFn'];
    const sleepCalls: number[] = [];
    const seam = await loadDeviceSeam({
      fetchFn,
      now: () => 0,
      sleep: async (ms: number): Promise<void> => {
        sleepCalls.push(ms);
      },
      writeStderr: (chunk: string) => {
        stderr.push(chunk);
      },
    });
    const session = await seam.requestInteractiveDelegatedSession({
      tenantId: 'tnt-1',
      audience: 'cms-api-aud',
      verificationUri: 'https://device.test/activate',
    });
    expect(tokenCalls).toBe(2);
    expect(session.token).toBe('tok-slow');
    // First sleep = 1 * 1000ms (initial interval). After slow_down the
    // interval grows by 5 to 6, so the second sleep = 6 * 1000ms.
    expect(sleepCalls).toEqual([1000, 6000]);
  });

  it('throws on an explicit non-pending OAuth error from the token endpoint', async () => {
    const stderr: string[] = [];
    const fetchFn: CliDeps['fetchFn'] = (async (url: string, init: RequestInit) => {
      void init;
      if (url.endsWith('/authorize')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev-deny',
            user_code: 'USR-DENY',
            verification_uri: 'https://device.test/activate',
            expires_in: 600,
            interval: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'access_denied' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as CliDeps['fetchFn'];
    const seam = await loadDeviceSeam({
      fetchFn,
      now: () => 0,
      sleep: async () => undefined,
      writeStderr: (chunk: string) => {
        stderr.push(chunk);
      },
    });
    await expect(
      seam.requestInteractiveDelegatedSession({
        tenantId: 'tnt-1',
        audience: 'cms-api-aud',
        verificationUri: 'https://device.test/activate',
      }),
    ).rejects.toThrow(/device authorization failed: access_denied/);
  });

  it('throws when the deadline passes before the human approves', async () => {
    const stderr: string[] = [];
    let tokenCalls = 0;
    const fetchFn: CliDeps['fetchFn'] = (async (url: string, init: RequestInit) => {
      void init;
      if (url.endsWith('/authorize')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev-deadline',
            user_code: 'USR-DEAD',
            verification_uri: 'https://device.test/activate',
            expires_in: 10,
            interval: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      tokenCalls += 1;
      return new Response(JSON.stringify({ error: 'authorization_pending' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as CliDeps['fetchFn'];
    // Loop guard reads `now()` once (0 < 10_000). After each sleep, the
    // next `now()` call jumps past the deadline so the inner `break` /
    // expired-throw path fires.
    const nowValues = [0, 20_000];
    let nowIdx = 0;
    const now = (): number => nowValues[Math.min(nowIdx++, nowValues.length - 1)] ?? 0;
    const seam = await loadDeviceSeam({
      fetchFn,
      now,
      sleep: async () => undefined,
      writeStderr: (chunk: string) => {
        stderr.push(chunk);
      },
    });
    await expect(
      seam.requestInteractiveDelegatedSession({
        tenantId: 'tnt-1',
        audience: 'cms-api-aud',
        verificationUri: 'https://device.test/activate',
      }),
    ).rejects.toThrow(/device authorization expired before human approval/);
    expect(tokenCalls).toBe(0);
  });

  it('throws when the authorization endpoint returns a non-2xx response', async () => {
    const stderr: string[] = [];
    const fetchFn: CliDeps['fetchFn'] = (async (_url: string, _init: RequestInit) => {
      return new Response(JSON.stringify({ status: 503, reason: 'unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }) as CliDeps['fetchFn'];
    const seam = await loadDeviceSeam({
      fetchFn,
      now: () => 0,
      sleep: async () => undefined,
      writeStderr: (chunk: string) => {
        stderr.push(chunk);
      },
    });
    await expect(
      seam.requestInteractiveDelegatedSession({
        tenantId: 'tnt-1',
        audience: 'cms-api-aud',
        verificationUri: 'https://device.test/activate',
      }),
    ).rejects.toThrow(/status 503/);
  });

  it('throws when the token endpoint returns a non-2xx response without an OAuth error', async () => {
    const stderr: string[] = [];
    const fetchFn: CliDeps['fetchFn'] = (async (url: string, _init: RequestInit) => {
      if (url.endsWith('/authorize')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev-500',
            user_code: 'USR-500',
            verification_uri: 'https://device.test/activate',
            expires_in: 600,
            interval: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ status: 502, reason: 'bad gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }) as CliDeps['fetchFn'];
    const seam = await loadDeviceSeam({
      fetchFn,
      now: () => 0,
      sleep: async () => undefined,
      writeStderr: (chunk: string) => {
        stderr.push(chunk);
      },
    });
    await expect(
      seam.requestInteractiveDelegatedSession({
        tenantId: 'tnt-1',
        audience: 'cms-api-aud',
        verificationUri: 'https://device.test/activate',
      }),
    ).rejects.toThrow(/status 502/);
  });

  it.each(['device_code', 'user_code', 'access_token', 'subject'] as const)(
    'throws when the authorization or token response is missing %s',
    async (field) => {
      const stderr: string[] = [];
      const omit = (payload: Record<string, unknown>, key: string): Record<string, unknown> => {
        const next = { ...payload };
        delete next[key];
        return next;
      };
      const fetchFn: CliDeps['fetchFn'] = (async (url: string, _init: RequestInit) => {
        if (url.endsWith('/authorize')) {
          const payload = {
            device_code: 'dev-missing',
            user_code: 'USR-MISS',
            verification_uri: 'https://device.test/activate',
            expires_in: 600,
            interval: 0,
          };
          return new Response(JSON.stringify(omit(payload, field)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const payload = {
          access_token: 'tok-missing',
          token_type: 'Bearer',
          subject: 'human-missing',
          expires_in: 300,
        };
        return new Response(JSON.stringify(omit(payload, field)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as CliDeps['fetchFn'];
      const seam = await loadDeviceSeam({
        fetchFn,
        now: () => 0,
        sleep: async () => undefined,
        writeStderr: (chunk: string) => {
          stderr.push(chunk);
        },
      });
      await expect(
        seam.requestInteractiveDelegatedSession({
          tenantId: 'tnt-1',
          audience: 'cms-api-aud',
          verificationUri: 'https://device.test/activate',
        }),
      ).rejects.toThrow(new RegExp(`device authorization response missing ${field}`));
    },
  );

  it('defaults expires_in, interval, display_name, and falls back to the supplied verificationUri', async () => {
    const stderr: string[] = [];
    const fetchFn: CliDeps['fetchFn'] = (async (url: string, _init: RequestInit) => {
      if (url.endsWith('/authorize')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev-defaults',
            user_code: 'USR-DEF',
            // No verification_uri, expires_in, or interval supplied.
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: 'tok-defaults',
          token_type: 'Bearer',
          subject: 'human-defaults',
          // No display_name or expires_in.
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as CliDeps['fetchFn'];
    const seam = await loadDeviceSeam({
      fetchFn,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      writeStderr: (chunk: string) => {
        stderr.push(chunk);
      },
    });
    const session = await seam.requestInteractiveDelegatedSession({
      tenantId: 'tnt-1',
      audience: 'cms-api-aud',
      verificationUri: 'https://fallback.device/activate',
    });
    expect(session.displayName).toBe('Authenticated operator');
    expect(session.verificationUri).toBe('https://fallback.device/activate');
    expect(session.issuedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(session.expiresAt).toBe(new Date(1_700_000_000_000 + 300_000).toISOString());
    expect(stderr.join('')).toContain('https://fallback.device/activate');
  });

  it('accepts an explicit expires_at, display_name, and verification_uri from the IdP', async () => {
    const stderr: string[] = [];
    const fetchFn: CliDeps['fetchFn'] = (async (url: string, _init: RequestInit) => {
      if (url.endsWith('/authorize')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev-explicit',
            user_code: 'USR-EXP',
            verification_uri: 'https://idp.device/activate',
            expires_in: 900,
            interval: 7,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: 'tok-explicit',
          token_type: 'Bearer',
          subject: 'human-explicit',
          display_name: 'Operator Explicit',
          expires_at: '2099-12-31T23:59:59.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as CliDeps['fetchFn'];
    const seam = await loadDeviceSeam({
      fetchFn,
      now: () => 0,
      sleep: async () => undefined,
      writeStderr: (chunk: string) => {
        stderr.push(chunk);
      },
    });
    const session = await seam.requestInteractiveDelegatedSession({
      tenantId: 'tnt-1',
      audience: 'cms-api-aud',
      verificationUri: 'https://fallback.device/activate',
    });
    expect(session.displayName).toBe('Operator Explicit');
    expect(session.verificationUri).toBe('https://idp.device/activate');
    expect(session.expiresAt).toBe('2099-12-31T23:59:59.000Z');
  });
  it('throws when the token endpoint returns malformed JSON', async () => {
    const stderr: string[] = [];
    const fetchFn: CliDeps['fetchFn'] = (async (url: string, _init: RequestInit) => {
      if (url.endsWith('/authorize')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev-bad',
            user_code: 'USR-BAD',
            verification_uri: 'https://device.test/activate',
            expires_in: 600,
            interval: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not-json-at-all', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as CliDeps['fetchFn'];
    const seam = await loadDeviceSeam({
      fetchFn,
      now: () => 0,
      sleep: async () => undefined,
      writeStderr: (chunk: string) => {
        stderr.push(chunk);
      },
    });
    await expect(
      seam.requestInteractiveDelegatedSession({
        tenantId: 'tnt-1',
        audience: 'cms-api-aud',
        verificationUri: 'https://device.test/activate',
      }),
    ).rejects.toThrow(/malformed JSON/);
  });
});
/**
 * Encode a JWT-shaped string the CLI classifies as
 * `delegated_human_fresh_interactive`. The CLI only inspects claim shape;
 * the API does the signature verification.
 */
function encodeDelegatedJwt(tenantId: string, subject: string): string {
  const header = Buffer.from('{"alg":"none"}').toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'test',
      sub: subject,
      aud: 'cms-api-aud',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      tenantId,
      actorId: subject,
      kind: 'human',
      scope: ['human'],
      delegatorId: 'human-operator',
      delegatedAt: new Date().toISOString(),
      delegatedUntil: new Date(Date.now() + 3600_000).toISOString(),
    }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}
