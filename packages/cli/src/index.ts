/**
 * @cms/cli — thin CLI projection over the authoritative @cms/api HTTP surface.
 *
 * Design rules:
 *
 *   1. The CLI never re-implements policy or state logic; every write is a
 *      single fetch into `/v1/...`. The API is the only authority surface.
 *   2. All I/O is injected (`fetchFn`, `stdout`, `stderr`, `now`, `uuid`,
 *      `auth`, `browser`). Defaults use globalThis / process / `crypto`.
 *   3. Privileged commands — approve, publish, rollback — fail closed unless
 *      the active credential proves to be a `delegated_human_fresh_interactive`
 *      session established by the injected browser seam. Service, MCP, and
 *      static env credentials are forbidden for those actions and the gate
 *      surfaces `E_SERVICE_APPROVAL_FORBIDDEN` / `E_TOKEN_KIND_FORBIDDEN`.
 *   4. Writes always carry `Idempotency-Key` (auto-generated if absent) and
 *      approve / publish / rollback carry `If-Match` from `--expect-version`.
 *   5. RFC 9457 Problem Details are preserved verbatim with the negotiated
 *      locale (en / es). Non-2xx responses render the problem and the runner
 *      sets `exitCode` from `problemCodeScope`.
 *   6. The CLI is the single place that interprets API responses for
 *      humans; the API still emits machine-readable codes and trace ids.
 *
 * The exported API is stable: `runCli(argv, options)` plus per-command
 * helpers the bin can wire up directly. The `CliDeps` interface makes every
 * side-effect observable in tests.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Public types: configuration, context, results
// ---------------------------------------------------------------------------

/**
 * The credential the CLI is currently executing under. The runner derives
 * this from the deps. Service / MCP / env credentials can never carry a
 * privileged delegation; only `delegated_human_fresh_interactive` may.
 */
export type CliCredentialKind =
  | 'none'
  | 'env_token'
  | 'cli_service'
  | 'mcp_identity'
  | 'delegated_human_fresh_interactive';

/**
 * A live, short-lived interactive session the CLI obtained by opening the
 * browser via the injected `browser` seam. Required for approve / publish /
 * rollback. The browser seam is responsible for completing the device-code
 * flow against the `deviceAuthorizationEndpoint` exposed by the host and
 * returning a fresh bearer plus the operator's display name.
 */
export interface DelegatedHumanSession {
  readonly token: string;
  readonly subject: string;
  readonly displayName: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly tenantId: string;
}

/** Injected browser/device-authorization flow used to obtain a privileged token. */
export interface BrowserAuthorizationSeam {
  requestInteractiveDelegatedSession(input: {
    readonly tenantId: string;
    readonly audience: string;
    readonly verificationUri: string;
  }): Promise<DelegatedHumanSession>;
}

/**
 * Static / pre-issued credentials. The deps `auth` resolver classifies
 * tokens by their claim shape and shape alone — never by trust. A token
 * with `kind: 'service'`, `scope: ['mcp']`, or no `delegatorId` cannot
 * authorize approve / publish / rollback regardless of where it came from.
 */
export interface CliAuthSeam {
  classify(input: {
    readonly token: string | null;
    readonly env: Readonly<Record<string, string | undefined>>;
  }): {
    readonly kind: CliCredentialKind;
    readonly token: string | null;
    readonly subject: string | null;
  };
}

export interface CliRandomSeam {
  uuid(): string;
}

export interface CliClockSeam {
  now(): Date;
}

/** Subset of fetch the CLI relies on; injectable so tests can fake it. */
export type FetchFn = typeof globalThis.fetch;

export interface CliDeps {
  readonly fetchFn: FetchFn;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly auth: CliAuthSeam;
  readonly browser: BrowserAuthorizationSeam;
  readonly now: CliClockSeam;
  readonly uuid: CliRandomSeam;
  /** Resolved audience for delegated-device login; injected to keep the CLI host-agnostic. */
  readonly audience: string;
  /** Default device-verification URI used by the browser seam when the host does not override. */
  readonly defaultDeviceVerificationUri: string;
}

export interface CliRuntimeOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly deps?: Partial<CliDeps>;
  /** Defaults pulled from flags; tests inject directly. */
  readonly config?: CliConfig;
}

export interface CliConfig {
  readonly apiBaseUrl: string;
  readonly tenantId: string;
  readonly locale: 'en' | 'es';
  readonly format: 'json' | 'human';
  readonly expectVersion: number | null;
  readonly idempotencyKey: string | null;
}

export type CliCommand =
  | 'help'
  | 'health'
  | 'proposal.get'
  | 'proposal.create'
  | 'proposal.approve'
  | 'proposal.publish'
  | 'proposal.rollback'
  | 'proposal.deploy.status'
  | 'proposal.deploy.reconcile';

export interface CliRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface CliResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly command: CliCommand | null;
  readonly request: CliRequest | null;
  readonly responseStatus: number | null;
  readonly responseBody: unknown;
}

/** RFC 9457 Problem Details shape; CLI preserves the wire shape. */
export interface ProblemJson {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly locale: 'en' | 'es';
  readonly extensions: Readonly<Record<string, unknown>>;
}

export type CliErrorCode =
  | 'usage'
  | 'credential_forbidden'
  | 'network'
  | 'problem'
  | 'unexpected'
  | 'conflict'
  | 'not_found'
  | 'validation';

export interface CliError extends Error {
  readonly code: CliErrorCode;
  readonly extensions: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Default deps
// ---------------------------------------------------------------------------

const defaultDeps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
  fetchFn: globalThis.fetch.bind(globalThis) as FetchFn,
  stdout: process.stdout,
  stderr: process.stderr,
  audience: 'cms-api-aud',
  defaultDeviceVerificationUri: 'https://device.example/activate',
  now: { now: () => new Date() },
  uuid: { uuid: () => randomUUID() },
  auth: defaultAuthSeam,
  browser: denyBrowserSeam,
  ...overrides,
});

export const defaultAuthSeam: CliAuthSeam = {
  classify({ token, env }) {
    if (token !== null && token.length > 0) {
      return classifyToken(token);
    }
    const envToken = env['CMS_TOKEN'] ?? env['CMS_API_TOKEN'];
    if (typeof envToken === 'string' && envToken.length > 0) {
      return classifyToken(envToken);
    }
    return { kind: 'none', token: null, subject: null };
  },
};

function classifyToken(token: string): {
  kind: CliCredentialKind;
  token: string;
  subject: string | null;
} {
  return { kind: detectEnvTokenKind(token), token, subject: extractSubjectClaim(token) };
}

/**
 * Detect a token's credential kind from a parseable claim shape. The CLI
 * does not verify signatures; the API does. The shape alone is enough to
 * refuse privileged actions ahead of any network call. Hosts may prefix
 * tokens (`svc:…`, `mcp:…`, `human:…`, `env:…`) to express kind in tests
 * or to gate the browser seam; JWT-encoded claims are also recognized.
 */
function detectEnvTokenKind(token: string): CliCredentialKind {
  const claim = parseTokenClaims(token);
  if (claim === null) return token.length > 0 ? 'env_token' : 'none';
  if (claim.kind === 'service') {
    return claim.scope === 'mcp' ? 'mcp_identity' : 'cli_service';
  }
  if (claim.delegatorId !== null && claim.delegatedUntil !== null) {
    return 'delegated_human_fresh_interactive';
  }
  return 'env_token';
}

interface ParsedClaims {
  kind: 'human' | 'service' | 'unknown';
  scope: string | null;
  delegatorId: string | null;
  delegatedUntil: string | null;
  tokenPrefixed: boolean;
}

function parseTokenClaims(token: string): ParsedClaims | null {
  const idx = token.indexOf(':');
  if (idx > 0 && idx < 16) {
    const head = token.slice(0, idx);
    if (head === 'svc' || head === 'service' || head === 'mcp' || head === 'human' || head === 'env') {
      return {
        kind:
          head === 'service' || head === 'svc' || head === 'mcp' ? 'service' : head === 'human' ? 'human' : 'unknown',
        scope: head === 'mcp' ? 'mcp' : null,
        delegatorId: null,
        delegatedUntil: null,
        tokenPrefixed: true,
      };
    }
  }
  const parts = token.split('.');
  if (parts.length >= 2) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
      const kindRaw = payload['kind'];
      const kind: 'human' | 'service' | 'unknown' =
        kindRaw === 'human' ? 'human' : kindRaw === 'service' ? 'service' : 'unknown';
      const scope = Array.isArray(payload['scope'])
        ? (payload['scope'] as readonly unknown[]).find((s) => typeof s === 'string')
        : null;
      return {
        kind,
        scope: typeof scope === 'string' ? scope : null,
        delegatorId: typeof payload['delegatorId'] === 'string' ? payload['delegatorId'] : null,
        delegatedUntil: typeof payload['delegatedUntil'] === 'string' ? payload['delegatedUntil'] : null,
        tokenPrefixed: false,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function extractSubjectClaim(token: string): string | null {
  const claim = parseTokenClaims(token);
  if (claim === null) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof payload['sub'] === 'string' ? payload['sub'] : null;
  } catch {
    return null;
  }
}

/** Default browser seam refuses every call so tests must inject a permissive one. */
const denyBrowserSeam: BrowserAuthorizationSeam = {
  async requestInteractiveDelegatedSession() {
    throw makeCliError(
      'credential_forbidden',
      'interactive browser session was not configured',
      { code: 'E_BROWSER_DISABLED' },
    );
  },
};

function makeCliError(
  kind: CliErrorCode,
  message: string,
  extensions: Readonly<Record<string, unknown>>,
): CliError {
  const err = new Error(message) as CliError;
  (err as unknown as { code: CliErrorCode }).code = kind;
  (err as unknown as { extensions: Readonly<Record<string, unknown>> }).extensions = extensions;
  return err;
}

// ---------------------------------------------------------------------------
// Argument parsing (zero deps, stable subset)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  flags: Map<string, string | boolean>;
  positional: string[];
}

export function parseArgv(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    let key: string;
    let inlineValue: string | null;
    if (eq > 0) {
      key = arg.slice(2, eq);
      inlineValue = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      inlineValue = null;
    }
    const next = argv[i + 1];
    if (inlineValue !== null) {
      flags.set(key, inlineValue);
    } else if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { flags, positional };
}

function flagString(flags: Map<string, string | boolean>, key: string): string | null {
  const v = flags.get(key);
  return typeof v === 'string' ? v : null;
}


// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

const COMMANDS = new Set<CliCommand>([
  'help',
  'health',
  'proposal.get',
  'proposal.create',
  'proposal.approve',
  'proposal.publish',
  'proposal.rollback',
  'proposal.deploy.status',
  'proposal.deploy.reconcile',
]);

const PRIVILEGED_COMMANDS = new Set<CliCommand>([
  'proposal.approve',
  'proposal.publish',
  'proposal.rollback',
  'proposal.deploy.reconcile',
]);

export function resolveCommand(positional: readonly string[]): CliCommand {
  const head = positional[0];
  if (head === undefined) return 'help';
  if (head === 'help') return 'help';
  if (head === 'health') return 'health';
  if (head === 'proposal' || head === 'proposals') {
    const second = positional[1];
    if (second === 'get') {
      if (positional[2] === undefined) {
        throw makeCliError('usage', 'proposal get <id>', { pointer: 'argv[2]' });
      }
      return 'proposal.get';
    }
    if (second === 'create') return 'proposal.create';
    if (second === 'approve') {
      if (positional[2] === undefined) {
        throw makeCliError('usage', 'proposal approve <id> --file <path>', {
          pointer: 'argv[2]',
        });
      }
      return 'proposal.approve';
    }
    if (second === 'publish') {
      if (positional[2] === undefined) {
        throw makeCliError('usage', 'proposal publish <id> --file <path>', {
          pointer: 'argv[2]',
        });
      }
      return 'proposal.publish';
    }
    if (second === 'rollback') {
      if (positional[2] === undefined) {
        throw makeCliError('usage', 'proposal rollback <id> --file <path>', {
          pointer: 'argv[2]',
        });
      }
      return 'proposal.rollback';
    }
    if (second === 'deploy') {
      const third = positional[2];
      if (third === 'status') {
        const proposalId = positional[3];
        if (proposalId === undefined) {
          throw makeCliError('usage', 'proposal deploy status <proposalId>', {
            pointer: 'argv[3]',
          });
        }
        return 'proposal.deploy.status';
      }
      if (third === 'reconcile') {
        const proposalId = positional[3];
        if (proposalId === undefined) {
          throw makeCliError(
            'usage',
            'proposal deploy reconcile <proposalId> --success <true|false>',
            { pointer: 'argv[3]' },
          );
        }
        return 'proposal.deploy.reconcile';
      }
    }
  }
  if (head === 'deploy') {
    const second = positional[1];
    if (second === 'status') {
      const proposalId = positional[2];
      if (proposalId === undefined) {
        throw makeCliError('usage', 'deploy status <proposalId>', {
          pointer: 'argv[2]',
        });
      }
      return 'proposal.deploy.status';
    }
  }
  throw makeCliError('usage', `unknown command: ${head ?? ''}`, { pointer: 'argv[0]' });
}

function describeCommand(command: CliCommand): string {
  switch (command) {
    case 'help':
      return 'Display command reference.';
    case 'health':
      return 'GET /v1/health — liveness probe.';
    case 'proposal.get':
      return 'GET /v1/proposals/{id} — read a proposal row.';
    case 'proposal.create':
      return 'POST /v1/proposals — submit a content or asset proposal.';
    case 'proposal.approve':
      return 'POST /v1/proposals/{id}/approve — requires a fresh interactive delegated-human session.';
    case 'proposal.publish':
      return 'POST /v1/proposals/{id}/publish — requires a fresh interactive delegated-human session.';
    case 'proposal.rollback':
      return 'POST /v1/proposals/{id}/rollback — single compensating action; requires a fresh interactive delegated-human session.';
    case 'proposal.deploy.status':
      return 'Read the live host-deploy state for a proposal via GET /v1/proposals/{id}.';
    case 'proposal.deploy.reconcile':
      return 'POST /v1/proposals/{id}/reconcile — record host reconcile success or failure; requires a fresh interactive delegated-human session.';
  }
  return command satisfies never;
}

function renderHelp(_deps: CliDeps): string {
  const rows: { command: string; description: string }[] = [];
  for (const c of COMMANDS) {
    rows.push({ command: c, description: describeCommand(c) });
  }
  const lines: string[] = ['handoff-cms CLI — projection over @cms/api', ''];
  const pad = rows.reduce((max, r) => Math.max(max, r.command.length), 0);
  for (const r of rows) {
    lines.push(`  ${r.command.padEnd(pad, ' ')}  ${r.description}`);
  }
  lines.push('');
  lines.push('Privileged actions (approve / publish / rollback / reconcile) refuse');
  lines.push('noninteractive, service, MCP, and env-supplied credentials. They require a');
  lines.push('fresh interactive delegated-human session obtained via the configured');
  lines.push('browser/device-authorization seam.');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export async function runCli(options: CliRuntimeOptions): Promise<CliResult> {
  const deps: CliDeps = { ...defaultDeps(), ...(options.deps ?? {}) };
  let stdout = '';
  let stderr = '';
  let command: CliCommand | null = null;
  const captureStdout = (chunk: string): void => {
    stdout += chunk;
  };
  const captureStderr = (chunk: string): void => {
    stderr += chunk;
  };

  try {
    const parsed = parseArgv(options.argv);
    command = resolveCommand(parsed.positional);
    if (command === 'help') {
      const helpText = renderHelp(deps);
      captureStdout(helpText);
      deps.stdout.write(helpText);
      return finish(0, command, null, null, stdout, stderr);
    }
    const config = resolveConfig(options.argv, options.env, options.config);

    let credential = resolveCredential(deps, options.env);
    if (PRIVILEGED_COMMANDS.has(command)) {
      assertExpectVersion(config);
      try {
        const session = await runPrivilegedCommand({
          config,
          deps,
        });
        credential = {
          kind: 'delegated_human_fresh_interactive',
          token: session.token,
          subject: session.subject,
        };
      } catch (error) {
        if (isCliError(error)) throw error;
        const refusalCode =
          credential.kind === 'cli_service'
            ? 'E_SERVICE_APPROVAL_FORBIDDEN'
            : credential.kind === 'mcp_identity'
              ? 'E_TOKEN_KIND_FORBIDDEN'
              : 'E_INTERACTIVE_AUTH_REQUIRED';
        throw makeCliError(
          'credential_forbidden',
          error instanceof Error ? error.message : 'interactive delegated-human authorization failed',
          { code: refusalCode },
        );
      }
    }

    const request = buildRequest(command, parsed, config, credential);
    const url = buildUrl(config.apiBaseUrl, request.path);
    const res = await deps.fetchFn(url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== null ? { body: request.body } : {}),
    });
    const text = await res.text();
    const body = parseBody(text);
    const response: CliResponse = { status: res.status, body };
    if (res.status >= 200 && res.status < 300) {
      const formatted =
        config.format === 'json'
          ? `${JSON.stringify(body, null, 2)}\n`
          : renderHuman(command, body);
      captureStdout(formatted);
      deps.stdout.write(formatted);
      return finish(0, command, request, response, stdout, stderr);
    }
    if (isProblemJson(body)) {
      const problem = body as ProblemJson;
      const message = renderProblem(problem);
      captureStderr(message);
      deps.stderr.write(message);
      return finish(exitCodeForProblem(problem), command, request, response, stdout, stderr);
    }
    const fallback = renderUnexpected(res.status, text);
    captureStderr(fallback);
    deps.stderr.write(fallback);
    return finish(1, command, request, response, stdout, stderr);
  } catch (error) {
    return handleError(
      error,
      command,
      null,
      deps,
      captureStdout,
      captureStderr,
      stdout,
      stderr,
    );
  }
}

function finish(
  exitCode: number,
  command: CliCommand | null,
  request: CliRequest | null,
  response: CliResponse | null,
  stdout: string,
  stderr: string,
): CliResult {
  return {
    exitCode,
    stdout,
    stderr,
    command,
    request,
    responseStatus: response === null ? null : response.status,
    responseBody: response === null ? null : response.body,
  };
}

export function resolveConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  overrides: CliConfig | undefined,
): CliConfig {
  const parsed = parseArgv(argv);
  const apiBaseUrl = overrideString(
    flagString(parsed.flags, 'api-base-url'),
    env['CMS_API_BASE_URL'],
    overrides?.apiBaseUrl ?? 'http://localhost:8787',
  );
  const tenantId = overrideString(
    flagString(parsed.flags, 'tenant'),
    env['CMS_TENANT_ID'],
    overrides?.tenantId ?? '',
  );
  if (tenantId.length === 0) {
    throw makeCliError('usage', '--tenant (or CMS_TENANT_ID) is required', {
      pointer: '--tenant',
    });
  }
  const localeRaw = overrideString(
    flagString(parsed.flags, 'locale'),
    env['CMS_LOCALE'],
    overrides?.locale ?? 'en',
  );
  if (localeRaw !== 'en' && localeRaw !== 'es') {
    throw makeCliError('usage', '--locale must be one of: en, es', {
      pointer: '--locale',
    });
  }
  const formatRaw = overrideString(
    flagString(parsed.flags, 'format'),
    env['CMS_OUTPUT_FORMAT'],
    overrides?.format ?? 'human',
  );
  if (formatRaw !== 'json' && formatRaw !== 'human') {
    throw makeCliError('usage', '--format must be one of: json, human', {
      pointer: '--format',
    });
  }
  const expectVersionRaw = flagString(parsed.flags, 'expect-version');
  let expectVersion: number | null = null;
  if (expectVersionRaw !== null) {
    const parsedNumber = Number.parseInt(expectVersionRaw, 10);
    if (!Number.isFinite(parsedNumber) || parsedNumber < 1) {
      throw makeCliError('usage', '--expect-version must be a positive integer', {
        pointer: '--expect-version',
      });
    }
    expectVersion = parsedNumber;
  } else if (overrides?.expectVersion !== undefined && overrides.expectVersion !== null) {
    expectVersion = overrides.expectVersion;
  }
  const idempotencyKey =
    flagString(parsed.flags, 'idempotency-key') ??
    env['CMS_IDEMPOTENCY_KEY'] ??
    overrides?.idempotencyKey ??
    null;
  return {
    apiBaseUrl,
    tenantId,
    locale: localeRaw,
    format: formatRaw,
    expectVersion,
    idempotencyKey: idempotencyKey === '' ? null : idempotencyKey,
  };
}

function overrideString(flag: string | null, envValue: string | undefined, fallback: string): string {
  if (flag !== null && flag.length > 0) return flag;
  if (typeof envValue === 'string' && envValue.length > 0) return envValue;
  return fallback;
}

interface ResolvedCredential {
  readonly kind: CliCredentialKind;
  readonly token: string | null;
  readonly subject: string | null;
}

function resolveCredential(
  deps: CliDeps,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedCredential {
  const envToken = typeof env['CMS_TOKEN'] === 'string' ? env['CMS_TOKEN'] : null;
  const classified = deps.auth.classify({ token: envToken, env });
  return {
    kind: classified.kind,
    token: classified.token,
    subject: classified.subject,
  };
}

export interface RunPrivilegedCommandInput {
  readonly config: CliConfig;
  readonly deps?: Partial<CliDeps>;
}
export async function runPrivilegedCommand(input: RunPrivilegedCommandInput): Promise<DelegatedHumanSession> {
  const deps: CliDeps = { ...defaultDeps(), ...(input.deps ?? {}) };
  const session = await deps.browser.requestInteractiveDelegatedSession({
    tenantId: input.config.tenantId,
    audience: deps.audience,
    verificationUri: deps.defaultDeviceVerificationUri,
  });
  if (session.tenantId !== input.config.tenantId) {
    throw makeCliError('credential_forbidden', 'delegated session tenant mismatch', {
      code: 'E_TENANT_MISMATCH',
    });
  }
  const expiry = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= deps.now.now().getTime()) {
    throw makeCliError('credential_forbidden', 'delegated session already expired', {
      code: 'E_TOKEN_EXPIRED',
    });
  }
  return session;
}

export function buildRequest(
  command: CliCommand,
  parsed: ParsedArgs,
  config: CliConfig,
  credential: ResolvedCredential,
): CliRequest {
  const headers: Record<string, string> = {
    'x-tenant-id': config.tenantId,
    'accept-language': config.locale,
    'accept': 'application/json',
  };

  // Authorization: bearer. Delegated sessions override static tokens for
  // privileged commands; noninteractive tokens authorize non-privileged
  // commands only. Approve, publish, rollback, reconcile ALWAYS need a
  // fresh interactive delegated-human session — known statically or via
  // a synchronous browser call the caller pre-resolves.
  const needsDelegation = PRIVILEGED_COMMANDS.has(command);
  if (needsDelegation) {
    if (credential.kind !== 'delegated_human_fresh_interactive') {
      throw makeCliError(
        'credential_forbidden',
        `command '${command}' requires a fresh interactive delegated-human session; refused for credential kind '${credential.kind}'`,
        {
          code:
            credential.kind === 'cli_service'
              ? 'E_SERVICE_APPROVAL_FORBIDDEN'
              : credential.kind === 'mcp_identity'
                ? 'E_TOKEN_KIND_FORBIDDEN'
                : 'E_INTERACTIVE_AUTH_REQUIRED',
        },
      );
    }
    if (credential.token === null) {
      throw makeCliError(
        'credential_forbidden',
        `command '${command}' requires a delegated-human bearer; none was supplied`,
        { code: 'E_INTERACTIVE_AUTH_REQUIRED' },
      );
    }
  }
  if (credential.token !== null) {
    headers['authorization'] = `Bearer ${credential.token}`;
  }

  const positional = parsed.positional;
  const file = flagString(parsed.flags, 'file');
  const dataJson = flagString(parsed.flags, 'data');
  let body: string | null = null;
  let path = '';

  switch (command) {
    case 'help':
    case 'health':
      path = '/v1/health';
      break;
    case 'proposal.get': {
      const id = positional[2];
      if (id === undefined) throw makeCliError('usage', 'proposal get <id>', { pointer: 'argv[2]' });
      path = `/v1/proposals/${encodePathParam(id)}`;
      break;
    }
    case 'proposal.create': {
      headers['idempotency-key'] = config.idempotencyKey ?? randomUUID();
      headers['content-type'] = 'application/json';
      body = JSON.stringify(loadProposalBody(file, dataJson, 'proposal.create'));
      path = '/v1/proposals';
      break;
    }
    case 'proposal.approve': {
      assertExpectVersion(config);
      const id = positional[2];
      if (id === undefined) {
        throw makeCliError('usage', 'proposal approve <id> --file <path>', {
          pointer: 'argv[2]',
        });
      }
      headers['idempotency-key'] = config.idempotencyKey ?? randomUUID();
      headers['if-match'] = String(config.expectVersion);
      headers['content-type'] = 'application/json';
      body = JSON.stringify(loadProposalBody(file, dataJson, 'proposal.approve'));
      path = `/v1/proposals/${encodePathParam(id)}/approve`;
      break;
    }
    case 'proposal.publish': {
      assertExpectVersion(config);
      const id = positional[2];
      if (id === undefined) {
        throw makeCliError('usage', 'proposal publish <id> --file <path>', {
          pointer: 'argv[2]',
        });
      }
      headers['idempotency-key'] = config.idempotencyKey ?? randomUUID();
      headers['if-match'] = String(config.expectVersion);
      headers['content-type'] = 'application/json';
      body = JSON.stringify(loadProposalBody(file, dataJson, 'proposal.publish'));
      path = `/v1/proposals/${encodePathParam(id)}/publish`;
      break;
    }
    case 'proposal.rollback': {
      assertExpectVersion(config);
      const id = positional[2];
      if (id === undefined) {
        throw makeCliError('usage', 'proposal rollback <id> --file <path>', {
          pointer: 'argv[2]',
        });
      }
      headers['idempotency-key'] = config.idempotencyKey ?? randomUUID();
      headers['if-match'] = String(config.expectVersion);
      headers['content-type'] = 'application/json';
      body = JSON.stringify(loadProposalBody(file, dataJson, 'proposal.rollback'));
      path = `/v1/proposals/${encodePathParam(id)}/rollback`;
      break;
    }
    case 'proposal.deploy.status': {
      const proposalId = positional[3] ?? positional[2];
      if (proposalId === undefined) {
        throw makeCliError('usage', 'proposal deploy status <proposalId>', {
          pointer: 'argv[3]',
        });
      }
      path = `/v1/proposals/${encodePathParam(proposalId)}`;
      break;
    }
    case 'proposal.deploy.reconcile': {
      assertExpectVersion(config);
      const proposalId = positional[3];
      if (proposalId === undefined) {
        throw makeCliError(
          'usage',
          'proposal deploy reconcile <proposalId> --success <true|false>',
          { pointer: 'argv[3]' },
        );
      }
      headers['idempotency-key'] = config.idempotencyKey ?? randomUUID();
      headers['if-match'] = String(config.expectVersion);
      headers['content-type'] = 'application/json';
      body = JSON.stringify(buildReconcileBody(parsed.flags));
      path = `/v1/proposals/${encodePathParam(proposalId)}/reconcile`;
      break;
    }
  }

  if (path === '') {
    throw makeCliError('usage', `command ${command} produced no path`, { command });
  }
  return {
    method:
      command === 'health' || command === 'proposal.get' || command === 'proposal.deploy.status'
        ? 'GET'
        : 'POST',
    headers,
    body,
    path,
  } as CliRequest;
}

function assertExpectVersion(config: CliConfig): void {
  if (config.expectVersion === null) {
    throw makeCliError(
      'usage',
      'this command requires --expect-version <n> for optimistic concurrency',
      { pointer: '--expect-version' },
    );
  }
}

function buildReconcileBody(flags: Map<string, string | boolean>): { success: boolean } {
  const successRaw = flagString(flags, 'success') ?? 'true';
  if (successRaw !== 'true' && successRaw !== 'false') {
    throw makeCliError('usage', '--success must be one of: true, false', {
      pointer: '--success',
    });
  }
  return { success: successRaw === 'true' };
}

function loadProposalBody(
  file: string | null,
  dataJson: string | null,
  command: CliCommand,
): Record<string, unknown> {
  if (file !== null) {
    const data = readBodyFromDisk(file);
    return ensureProposalShape(data, command);
  }
  if (dataJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataJson);
    } catch {
      throw makeCliError('validation', '--data is not valid JSON', { pointer: '--data' });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw makeCliError('validation', '--data must be a JSON object', {
        pointer: '--data',
      });
    }
    return ensureProposalShape(parsed as Record<string, unknown>, command);
  }
  throw makeCliError('usage', `${command} requires --file <path> or --data <json>`, {
    pointer: '--file',
  });
}

export function ensureProposalShape(
  value: Record<string, unknown>,
  command: CliCommand,
): Record<string, unknown> {
  const proposal = value['proposal'];
  if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw makeCliError('validation', `${command} body must include a 'proposal' object`, {
      pointer: '/proposal',
    });
  }
  return value;
}

function readBodyFromDisk(filePath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw makeCliError('validation', `cannot read --file ${filePath}`, { pointer: '--file' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw makeCliError('validation', `--file ${filePath} is not valid JSON`, {
      pointer: '--file',
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw makeCliError('validation', `--file ${filePath} must contain a JSON object`, {
      pointer: '--file',
    });
  }
  return parsed as Record<string, unknown>;
}

function encodePathParam(value: string): string {
  return encodeURIComponent(value);
}

function buildUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}${path}`;
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function isProblemJson(body: unknown): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return (
    typeof record['type'] === 'string' &&
    typeof record['title'] === 'string' &&
    typeof record['status'] === 'number' &&
    typeof record['code'] === 'string' &&
    typeof record['locale'] === 'string' &&
    (record['locale'] === 'en' || record['locale'] === 'es')
  );
}

function renderProblem(problem: ProblemJson): string {
  const ext = (problem.extensions ?? {}) as Record<string, unknown>;
  const traceId = ext['traceId'];
  const tail = typeof traceId === 'string' ? ` [trace: ${traceId}]` : '';
  return `error: ${problem.code} (status ${problem.status}) ${problem.title} — ${problem.detail} (locale=${problem.locale})${tail}\n`;
}

function renderUnexpected(status: number, text: string): string {
  return `error: unexpected response ${status}\n${text}\n`;
}

function renderHuman(command: CliCommand, body: unknown): string {
  if (
    (command === 'health' || command === 'proposal.get' || command === 'proposal.deploy.status') &&
    body !== null &&
    typeof body === 'object' &&
    'status' in (body as Record<string, unknown>)
  ) {
    const status = (body as { status: unknown }).status;
    if (typeof status === 'string') {
      const id =
        'id' in (body as Record<string, unknown>)
          ? ` id=${(body as { id: unknown }).id}`
          : '';
      const state =
        'state' in (body as Record<string, unknown>)
          ? ` state=${(body as { state: unknown }).state}`
          : '';
      const version =
        'version' in (body as Record<string, unknown>)
          ? ` v=${(body as { version: unknown }).version}`
          : '';
      return `ok — ${status}${id}${state}${version}\n`;
    }
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function exitCodeForProblem(problem: ProblemJson): number {
  switch (problem.code) {
    case 'E_BAD_REQUEST':
    case 'invalid_input':
      return 65;
    case 'E_SERVICE_APPROVAL_FORBIDDEN':
    case 'E_MCP_APPROVAL_FORBIDDEN':
    case 'E_TOKEN_KIND_FORBIDDEN':
    case 'E_INTERACTIVE_AUTH_REQUIRED':
    case 'E_TENANT_MISMATCH':
    case 'E_TOKEN_EXPIRED':
    case 'E_INVALID_IDENTITY':
    case 'E_TENANT_FORBIDDEN':
    case 'E_INSUFFICIENT_AUTHORITY':
    case 'E_ACTION_FORBIDDEN':
    case 'E_SELF_APPROVAL_FORBIDDEN':
      return 77;
    case 'not_found':
      return 2;
    case 'E_OPTIMISTIC_CONCURRENCY_CONFLICT':
    case 'optimistic_concurrency_conflict':
    case 'idempotency_replay_mismatch':
    case 'idempotency_in_progress':
      return 4;
    case 'connection_failed':
      return 3;
    default:
      return problem.code.startsWith('E_') ? 2 : 1;
  }
}

async function handleError(
  err: unknown,
  command: CliCommand | null,
  request: CliRequest | null,
  deps: CliDeps,
  _captureStdout: (chunk: string) => void,
  captureStderr: (chunk: string) => void,
  stdout: string,
  stderr: string,
): Promise<CliResult> {
  if (isCliError(err)) {
    const machineCode =
      typeof err.extensions['code'] === 'string' ? `/${err.extensions['code']}` : '';
    const msg = `error: [${err.code}${machineCode}] ${err.message}\n`;
    captureStderr(msg);
    deps.stderr.write(msg);
    const exitCode = cliErrorToExitCode(err.code);
    return finish(exitCode, command, request, null, stdout, `${stderr}${msg}`);
  }
  if (err instanceof Error) {
    const msg = `error: ${err.message}\n`;
    captureStderr(msg);
    deps.stderr.write(msg);
    if (/fetch|network|ENOTFOUND|ECONN/i.test(err.message)) {
      return finish(3, command, request, null, stdout, `${stderr}${msg}`);
    }
    return finish(1, command, request, null, stdout, `${stderr}${msg}`);
  } else {
    const msg = `error: ${String(err)}\n`;
    captureStderr(msg);
    deps.stderr.write(msg);
    return finish(1, command, request, null, stdout, `${stderr}${msg}`);
  }
}

function cliErrorToExitCode(code: CliErrorCode): number {
  switch (code) {
    case 'usage':
      return 64;
    case 'credential_forbidden':
      return 77;
    case 'network':
      return 3;
    case 'problem':
      return 2;
    case 'conflict':
      return 4;
    case 'not_found':
      return 2;
    case 'validation':
      return 65;
    case 'unexpected':
      return 1;
  }
  return 1;
}

function isCliError(err: unknown): err is CliError {
  return (
    err instanceof Error &&
    typeof (err as unknown as { code?: unknown }).code === 'string' &&
    typeof (err as unknown as { extensions?: unknown }).extensions === 'object'
  );
}

// ---------------------------------------------------------------------------
// Re-exports for the bin
// ---------------------------------------------------------------------------

export const __testing = {
  parseArgv,
  resolveCommand,
  resolveConfig,
  buildRequest,
  parseTokenClaims,
  detectEnvTokenKind,
  extractSubjectClaim,
  isProblemJson,
  exitCodeForProblem,
  ensureProposalShape,
};
