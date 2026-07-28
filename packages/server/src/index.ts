#!/usr/bin/env node
/**
 * @cms/server — Apache-2.0 self-hosted Handoff CMS server entry point.
 *
 * Wires:
 *   - `@cms/storage` Postgres (real governance persistence).
 *   - `@cms/api` Hono transport over that storage.
 *   - The Node-Web OIDC verifier from `./auth.ts`.
 *   - A bounded HTTP server with `/health/live`, `/health/ready`, `/metrics`,
 *     body-size cap, and per-tenant request quota.
 *   - PII-free structured JSON logs.
 *
 * The server is operator-managed: it never owns a UI, never touches an
 * external control plane, and never embeds proprietary dependencies. The
 * only required connection at boot is the configured Postgres database
 * and the configured OIDC JWKS endpoint (which is fetched lazily).
 */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname as osHostname } from 'node:os';
import { fileURLToPath } from 'node:url';

import { type Storage, createPostgresStorage, PostgresStorage } from '@cms/storage';
import {
  type Audience,
  type IdentityResolver,
  type TokenVerifier,
  createApi,
  type ApiServices,
} from '@cms/api';
import { Hono } from 'hono';

import {
  describeServerConfig,
  loadServerConfig,
  ServerConfigError,
  type ServerConfig,
} from './config.js';
import {
  createOidcVerifier,
  createStorageIdentityResolver,
  type JwksSource,
} from './auth.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface CreateServerOptions {
  /** Operator-managed config. Tests can override `nodeEnv` to skip log emission. */
  readonly config: ServerConfig;
  /** Optional Postgres storage injection (tests inject a PGlite handle). */
  readonly storage?: Storage;
  /** Optional OIDC verifier injection (tests inject a local JWKS). */
  readonly tokenVerifier?: TokenVerifier;
  /** Optional identity resolver injection. */
  readonly identityResolver?: IdentityResolver;
  /** Optional JWKS source for tests. */
  readonly jwks?: JwksSource;
  /** Optional deterministic clock (seconds). */
  readonly nowSeconds?: () => number;
  /** Optional deterministic trace id generator. */
  readonly traceId?: () => string;
}

export interface SelfHostedServer {
  /** Hono app; tests may mount additional routes. */
  readonly app: Hono;
  /** Underlying Node http.Server. Null until `listen()` has been called. */
  readonly httpServer: Server | null;
  /** Run readiness probes (DB, object-store, and OIDC JWKS reachability). */
  readonly readiness: () => Promise<ReadinessReport>;
  /** Collect Prometheus-format metrics. */
  readonly metrics: () => Promise<string>;
  /** Stop the server, close the HTTP listener and the Postgres pool. */
  readonly close: () => Promise<void>;
  /** Start listening on the configured host/port. */
  readonly listen: () => Promise<{ readonly port: number; readonly hostname: string }>;
}

export interface ReadinessReport {
  readonly status: 'ready' | 'degraded';
  readonly checks: Readonly<{
    readonly database: ReadinessCheck;
    readonly objectStore: ReadinessCheck;
    readonly oidc: ReadinessCheck;
  }>;
}

export interface ReadinessCheck {
  readonly ok: boolean;
  readonly detail: string;
}

export interface StartServerOptions extends CreateServerOptions {
  /** Optional logger override for tests (defaults to a JSON stderr logger). */
  readonly logger?: ServerLogger;
}

export interface ServerLogger {
  log(level: ServerLogLevel, event: ServerLogEvent): void;
}

export type ServerLogLevel = 'silent' | 'debug' | 'info' | 'warn' | 'error';

export interface ServerLogEvent {
  readonly level?: ServerLogLevel;
  readonly event: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly latencyMs?: number;
  readonly bytes?: number;
  readonly code?: string;
  readonly detail?: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Server-internal error codes. Closed union, stable across patch versions. */
export const SERVER_ERROR_CODES = [
  'E_SERVER_NOT_READY',
  'E_SERVER_ALREADY_LISTENING',
  'E_SERVER_QUOTA_BYTES',
  'E_SERVER_QUOTA_RATE',
  'E_SERVER_INTERNAL',
] as const;
Object.freeze(SERVER_ERROR_CODES);

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

export class ServerError extends Error {
  public readonly code: ServerErrorCode;
  constructor(code: ServerErrorCode, message: string) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

const LOG_LEVEL_ORDER: Readonly<Record<ServerLogLevel, number>> = Object.freeze({
  silent: -1,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
});

function isLoggable(level: ServerLogLevel, threshold: number): boolean {
  return LOG_LEVEL_ORDER[level] >= threshold;
}

function defaultLogger(config: ServerConfig): ServerLogger {
  const threshold = LOG_LEVEL_ORDER[config.logLevel];
  const host = osHostname();
  return Object.freeze({
    log(level: ServerLogLevel, event: ServerLogEvent) {
      if (level === 'silent' || !isLoggable(level, threshold)) return;
      const record: ServerLogEvent & { readonly timestamp: string; readonly host: string } = {
        ...event,
        level,
        timestamp: new Date().toISOString(),
        host,
        service: '@cms/server',
        version: '0.1.0',
      };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    },
  });
}

// ---------------------------------------------------------------------------
// Rate-limit / body-size quotas
// ---------------------------------------------------------------------------

interface QuotaState {
  readonly requestBytesCap: number;
  /** Per-tenant sliding-window counters; pruned on every check. */
  readonly tenantWindows: Map<string, TenantWindow>;
}

interface TenantWindow {
  readonly windowStartMs: number;
  readonly count: number;
}

function createQuotaState(config: ServerConfig): QuotaState {
  return Object.freeze({
    requestBytesCap: config.quotas.requestBytesCap,
    tenantWindows: new Map<string, TenantWindow>(),
  });
}

function checkRateLimit(
  tenantWindows: Map<string, TenantWindow>,
  tenantId: string,
  limitPerMinute: number,
  nowMs: number,
): boolean {
  const windowMs = 60_000;
  const existing = tenantWindows.get(tenantId);
  if (existing === undefined) {
    tenantWindows.set(tenantId, { windowStartMs: nowMs, count: 1 });
    return true;
  }
  if (nowMs - existing.windowStartMs >= windowMs) {
    tenantWindows.set(tenantId, { windowStartMs: nowMs, count: 1 });
    return true;
  }
  if (existing.count + 1 > limitPerMinute) return false;
  tenantWindows.set(tenantId, { windowStartMs: existing.windowStartMs, count: existing.count + 1 });
  return true;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface MetricsState {
  readonly startedAtMs: number;
  requestCount: number;
  readonly statusCounts: Map<number, number>;
  bytesIn: number;
  bytesOut: number;
  rateLimited: number;
  oversized: number;
  readinessFailures: number;
}

function createMetricsState(): MetricsState {
  return {
    startedAtMs: Date.now(),
    requestCount: 0,
    statusCounts: new Map<number, number>(),
    bytesIn: 0,
    bytesOut: 0,
    rateLimited: 0,
    oversized: 0,
    readinessFailures: 0,
  };
}

function metricsToText(state: MetricsState): string {
  const lines: string[] = [];
  lines.push('# HELP cms_server_uptime_seconds Process uptime in seconds.');
  lines.push('# TYPE cms_server_uptime_seconds gauge');
  lines.push(`cms_server_uptime_seconds ${(Date.now() - state.startedAtMs) / 1000}`);
  lines.push('# HELP cms_server_requests_total Total HTTP requests handled.');
  lines.push('# TYPE cms_server_requests_total counter');
  lines.push(`cms_server_requests_total ${state.requestCount}`);
  lines.push('# HELP cms_server_request_bytes_in_total Total bytes read from request bodies.');
  lines.push('# TYPE cms_server_request_bytes_in_total counter');
  lines.push(`cms_server_request_bytes_in_total ${state.bytesIn}`);
  lines.push('# HELP cms_server_response_bytes_out_total Total bytes written to response bodies.');
  lines.push('# TYPE cms_server_response_bytes_out_total counter');
  lines.push(`cms_server_response_bytes_out_total ${state.bytesOut}`);
  lines.push('# HELP cms_server_rate_limited_total Requests rejected with 429.');
  lines.push('# TYPE cms_server_rate_limited_total counter');
  lines.push(`cms_server_rate_limited_total ${state.rateLimited}`);
  lines.push('# HELP cms_server_oversized_total Requests rejected with 413.');
  lines.push('# TYPE cms_server_oversized_total counter');
  lines.push(`cms_server_oversized_total ${state.oversized}`);
  lines.push('# HELP cms_server_readiness_failures_total Failed readiness checks.');
  lines.push('# TYPE cms_server_readiness_failures_total counter');
  lines.push(`cms_server_readiness_failures_total ${state.readinessFailures}`);
  lines.push('# HELP cms_server_requests_by_status_total Request count partitioned by response status.');
  lines.push('# TYPE cms_server_requests_by_status_total counter');
  for (const [status, count] of state.statusCounts.entries()) {
    lines.push(`cms_server_requests_by_status_total{status="${status}"} ${count}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Body collection with quota enforcement
// ---------------------------------------------------------------------------

async function readBoundedBody(
  req: IncomingMessage,
  cap: number,
  onOversize: () => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  let aborted = false;
  return await new Promise<Buffer>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      received += chunk.length;
      if (received > cap) {
        aborted = true;
        onOversize();
        req.destroy();
        reject(new ServerError('E_SERVER_QUOTA_BYTES', 'request body exceeds the configured byte cap'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (aborted) return;
      aborted = true;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a self-hosted server. The factory is the single integration point
 * for tests and production; both paths share the same wire shape and the
 * same hooks. Tests inject `storage`, `tokenVerifier`, `identityResolver`,
 * and `jwks`; production always constructs each one itself from the config.
 */
export function createSelfHostedServer(options: CreateServerOptions): SelfHostedServer {
  const config = options.config;
  const audience: Audience = config.oidc.audience as Audience;

  // Storage: production uses real Postgres; tests inject.
  let ownsStorage = false;
  let storage: Storage;
  if (options.storage !== undefined) {
    storage = options.storage;
  } else {
    storage = createPostgresStorage(config.databaseUrl, '@cms/server');
    ownsStorage = true;
  }

  // OIDC verifier.
  const tokenVerifier: TokenVerifier = options.tokenVerifier
    ? options.tokenVerifier
    : createOidcVerifier({
        oidc: config.oidc,
        ...(options.jwks !== undefined ? { jwks: options.jwks } : {}),
        ...(options.nowSeconds !== undefined ? { nowSeconds: options.nowSeconds } : {}),
      });

  // Identity resolver.
  const identityResolver: IdentityResolver = options.identityResolver
    ? options.identityResolver
    : createStorageIdentityResolver(storage);

  const services: ApiServices = {
    storage,
    tokenVerifier,
    identityResolver,
    audience,
    now: () => new Date(),
    ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
  };

  // Build the api app and overlay server-only routes. Server-only routes
  // (health, metrics) are registered FIRST so they short-circuit before
  // the api's tenant-required auth middleware runs.
  const quotas = createQuotaState(config);
  const metrics = createMetricsState();
  const logger = defaultLogger(config);

  let httpServer: Server | null = null;
  let counter = 0;
  const localTraceId = (): string => {
    if (options.traceId !== undefined) return options.traceId();
    counter += 1;
    return createHash('sha256').update(`${Date.now()}:${counter}:${randomUUID()}`).digest('hex');
  };

  const readinessFn = async (): Promise<ReadinessReport> => {
    const [dbCheck, objCheck, oidcCheck] = await Promise.all([
      probeDatabase(storage),
      probeObjectStore(config),
      probeOidc(config),
    ]);
    const ok = dbCheck.ok && objCheck.ok && oidcCheck.ok;
    if (!ok) {
      metricsStateInc(metrics, 'readinessFailures', 1);
    }
    return Object.freeze({
      status: ok ? 'ready' : 'degraded',
      checks: Object.freeze({
        database: dbCheck,
        objectStore: objCheck,
        oidc: oidcCheck,
      }),
    });
  };
  const metricsFn = async (): Promise<string> => metricsToText(metrics);

  const app = new Hono();
  app.get('/health/live', (c) =>
    c.json(
      Object.freeze({
        status: 'alive',
        service: '@cms/server',
        version: '0.1.0',
        timestamp: new Date().toISOString(),
      }),
      200,
    ),
  );
  app.get('/health/ready', async (c) => {
    const report = await readinessFn();
    return c.json(report, report.status === 'ready' ? 200 : 503);
  });
  app.get('/metrics', async (c) => {
    const body = await metricsFn();
    return c.body(body, 200, { 'content-type': 'text/plain; version=0.0.4; charset=UTF-8' });
  });
  const apiApp = createApi({ services });
  app.route('/', apiApp);



  const server: SelfHostedServer = Object.freeze({
    app,
    get httpServer() {
      return httpServer;
    },
    readiness: readinessFn,
    metrics: metricsFn,
    listen: async () => {
      if (httpServer !== null) {
        throw new ServerError('E_SERVER_ALREADY_LISTENING', 'server is already listening');
      }
      const httpSrv = createServer((req, res) => {
        void handleNodeRequest(req, res, {
          app,
          config,
          quotas,
          metrics,
          logger,
          traceId: localTraceId,
        });
      });
      httpServer = httpSrv;
      await new Promise<void>((resolve, reject) => {
        httpSrv.once('error', reject);
        httpSrv.listen(config.port, config.hostname, () => {
          httpSrv.off('error', reject);
          resolve();
        });
      });
      const address = httpSrv.address();
      const port = typeof address === 'object' && address !== null ? address.port : config.port;
      logger.log('info', {
        event: 'server.listening',
        port,
        hostname: config.hostname,
        traceId: localTraceId(),
      });
      return Object.freeze({ port, hostname: config.hostname });
    },
    close: async () => {
      const serverRef = httpServer;
      if (serverRef !== null) {
        await new Promise<void>((resolve) => serverRef.close(() => resolve()));
        httpServer = null;
      }
      if (ownsStorage && storage instanceof PostgresStorage) {
        await storage.close();
      }
    },
  });

  return server;
}

// ---------------------------------------------------------------------------
// Node HTTP adapter
// ---------------------------------------------------------------------------

interface NodeRequestContext {
  readonly app: Hono;
  readonly config: ServerConfig;
  readonly quotas: QuotaState;
  readonly metrics: MetricsState;
  readonly logger: ServerLogger;
  readonly traceId: () => string;
}

async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: NodeRequestContext,
): Promise<void> {
  const { config, quotas, metrics, logger, app, traceId } = ctx;
  const startedAt = Date.now();
  const trace = traceId();
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  const safePath = new URL(url, config.publicUrl).pathname;

  // Negotiate the peer locale from the inbound `accept-language` header so
  // 400/413/429/500 problems never silently fall back to English.
  const locale = negotiateServerLocale(req.headers['accept-language']);

  metricsStateInc(metrics, 'requestCount', 1);

  // Body-size cap (413).
  let body: Buffer | null = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const contentLengthHeader = req.headers['content-length'];
    const declared =
      typeof contentLengthHeader === 'string' ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;
    if (Number.isFinite(declared) && declared > config.quotas.requestBytesCap) {
      metricsStateInc(metrics, 'oversized', 1);
      writeProblem(
        res,
        413,
        trace,
        'E_PAYLOAD_TOO_LARGE',
        'payload_too_large',
        'The request body exceeds the configured byte cap.',
        {},
        locale,
      );
      logger.log('warn', {
        event: 'request.oversized',
        method,
        path: safePath,
        traceId: trace,
        bytes: declared,
      });
      return;
    }
    try {
      body = await readBoundedBody(req, config.quotas.requestBytesCap, () => {
        metricsStateInc(metrics, 'oversized', 1);
      });
    } catch (err) {
      if (err instanceof ServerError && err.code === 'E_SERVER_QUOTA_BYTES') {
        writeProblem(
          res,
          413,
          trace,
          'E_PAYLOAD_TOO_LARGE',
          'payload_too_large',
          'The request body exceeds the configured byte cap.',
          {},
          locale,
        );
        logger.log('warn', {
          event: 'request.oversized',
          method,
          path: safePath,
          traceId: trace,
          code: 'E_PAYLOAD_TOO_LARGE',
        });
        return;
      }
      logger.log('error', {
        event: 'request.body_read_failed',
        method,
        path: safePath,
        traceId: trace,
        detail: 'request body read failed',
      });
      writeProblem(
        res,
        400,
        trace,
        'E_BAD_REQUEST',
        'bad_request',
        'The request body could not be read.',
        {},
        locale,
      );
      return;
    }
  }
  if (body !== null) {
    metricsStateAdd(metrics, 'bytesIn', body.length);
  }

  // The Node boundary rate-limits by remote source before authentication.
  // Using the unverified tenant header here would let an attacker consume a
  // victim tenant's quota. Tenant authorization remains enforced inside API.
  const remoteAddress = req.socket.remoteAddress ?? 'unknown';
  const rateKey = `source:${remoteAddress}`;
  const allowed = checkRateLimit(
    quotas.tenantWindows,
    rateKey,
    config.quotas.tenantRequestsPerMinute,
    Date.now(),
  );
  if (!allowed) {
    metricsStateInc(metrics, 'rateLimited', 1);
    writeProblem(
      res,
      429,
      trace,
      'E_TOO_MANY_REQUESTS',
      'rate_limited',
      'Request quota exceeded; retry after a minute.',
      { 'retry-after': '60' },
      locale,
    );
    logger.log('warn', {
      event: 'request.rate_limited',
      method,
      path: safePath,
      traceId: trace,
    });
    return;
  }

  // Build the upstream Web Request.
  const headers = sanitizeHeaders(req.headers);
  headers.set('x-trace-id', trace);
  const webRequest = new Request(buildPublicUrl(config, url), {
    method,
    headers,
    ...(body !== null ? { body, duplex: 'half' } : {}),
  });

  let webResponse: Response;
  try {
    webResponse = await app.fetch(webRequest);
  } catch (err) {
    logger.log('error', {
      event: 'request.unhandled_error',
      method,
      path: safePath,
      traceId: trace,
      detail: 'request handler failed',
    });
    writeProblem(
      res,
      500,
      trace,
      'E_INTERNAL',
      'internal_error',
      'An unexpected error occurred.',
      {},
      locale,
    );
    return;
  }

  // Copy upstream response into Node response.
  webResponse.headers.forEach((value, key) => {
    if (key === 'content-encoding' || key === 'transfer-encoding') return;
    res.setHeader(key, value);
  });
  res.statusCode = webResponse.status;
  const responseBuffer = Buffer.from(await webResponse.arrayBuffer());
  metricsStateAdd(metrics, 'bytesOut', responseBuffer.length);
  metricsStateIncStatus(metrics, webResponse.status);

  logger.log(webResponse.status >= 500 ? 'error' : webResponse.status >= 400 ? 'warn' : 'info', {
    event: 'request.completed',
    method,
    path: safePath,
    traceId: trace,
    status: webResponse.status,
    latencyMs: Date.now() - startedAt,
  });
  res.end(responseBuffer);
}

function sanitizeHeaders(raw: IncomingMessage['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  // The authoritative API must receive the bearer credential so its verifier
  // can authenticate and authorize the request. Logging never serializes
  // request headers; browser cookies and proxy credentials are still removed.
  headers.delete('cookie');
  headers.delete('proxy-authorization');
  return headers;
}

function buildPublicUrl(config: ServerConfig, url: string): string {
  const pathQuery = url.startsWith('/') ? url : `/${url}`;
  return `${config.publicUrl.replace(/\/$/, '')}${pathQuery}`;
}
// ---------------------------------------------------------------------------
// Localized problem catalog for Node-adapter transport errors.
//
// Mirrors the closed-union behavior of `@cms/api/problem.ts` so that the
// server-emitted 400/413/429/500 problems negotiate en/es with the same
// `accept-language` semantics as the API. There is no silent fallback to
// English: the negotiated locale is always part of the response so the
// client can verify the resolved peer.
// ---------------------------------------------------------------------------
const SERVER_PROBLEM_LOCALES = ['en', 'es'] as const;
type ServerProblemLocale = (typeof SERVER_PROBLEM_LOCALES)[number];

function isServerProblemLocale(value: string): value is ServerProblemLocale {
  return value === 'en' || value === 'es';
}

function negotiateServerLocale(acceptLanguage: string | string[] | undefined): ServerProblemLocale {
  if (typeof acceptLanguage === 'string') {
    const primary = acceptLanguage.split(',')[0]?.trim().split(';')[0]?.split('-')[0]?.toLowerCase() ?? '';
    if (isServerProblemLocale(primary)) return primary;
    return 'en';
  }
  if (Array.isArray(acceptLanguage)) {
    for (const entry of acceptLanguage) {
      const primary = entry.split(';')[0]?.trim().split('-')[0]?.toLowerCase() ?? '';
      if (isServerProblemLocale(primary)) return primary;
    }
  }
  return 'en';
}

interface ServerProblemMessage {
  readonly title: string;
  readonly detail: string;
}

const SERVER_PROBLEM_MESSAGES: Readonly<Record<ServerProblemLocale, Readonly<Record<string, ServerProblemMessage>>>> = Object.freeze({
  en: Object.freeze({
    E_BAD_REQUEST: Object.freeze({ title: 'Bad request', detail: 'The request body could not be read.' }),
    E_PAYLOAD_TOO_LARGE: Object.freeze({ title: 'Payload too large', detail: 'The request body exceeds the configured byte cap.' }),
    E_TOO_MANY_REQUESTS: Object.freeze({ title: 'Too many requests', detail: 'Request quota exceeded; retry after a minute.' }),
    E_INTERNAL: Object.freeze({ title: 'Internal server error', detail: 'An unexpected error occurred.' }),
  }),
  es: Object.freeze({
    E_BAD_REQUEST: Object.freeze({ title: 'Solicitud incorrecta', detail: 'No se pudo leer el cuerpo de la solicitud.' }),
    E_PAYLOAD_TOO_LARGE: Object.freeze({ title: 'Carga demasiado grande', detail: 'El cuerpo de la solicitud excede el tamaño máximo configurado.' }),
    E_TOO_MANY_REQUESTS: Object.freeze({ title: 'Demasiadas solicitudes', detail: 'Se excedió la cuota de solicitudes; reintente después de un minuto.' }),
    E_INTERNAL: Object.freeze({ title: 'Error interno del servidor', detail: 'Ocurrió un error inesperado.' }),
  }),
});

function serverProblemMessage(code: string, locale: ServerProblemLocale): ServerProblemMessage {
  const bundle = SERVER_PROBLEM_MESSAGES[locale] ?? SERVER_PROBLEM_MESSAGES.en;
  return bundle[code] ?? bundle.E_INTERNAL!;
}

function inferServerProblemCode(status: number): string {
  if (status === 400) return 'E_BAD_REQUEST';
  if (status === 413) return 'E_PAYLOAD_TOO_LARGE';
  if (status === 429) return 'E_TOO_MANY_REQUESTS';
  return 'E_INTERNAL';
}

function inferServerProblemType(code: string): string {
  switch (code) {
    case 'E_BAD_REQUEST':
      return 'bad_request';
    case 'E_PAYLOAD_TOO_LARGE':
      return 'payload_too_large';
    case 'E_TOO_MANY_REQUESTS':
      return 'rate_limited';
    default:
      return 'internal_error';
  }
}

function writeProblem(
  res: ServerResponse,
  status: number,
  traceId: string,
  code: string,
  type: string,
  _detail: string,
  extraHeaders: Readonly<Record<string, string>> = {},
  locale: ServerProblemLocale = 'en',
): void {
  const resolvedCode = code === 'E_PAYLOAD_TOO_LARGE' || code === 'E_TOO_MANY_REQUESTS' || code === 'E_BAD_REQUEST' || code === 'E_INTERNAL'
    ? code
    : inferServerProblemCode(status);
  const resolvedType = type === 'bad_request' || type === 'payload_too_large' || type === 'rate_limited' || type === 'internal_error'
    ? type
    : inferServerProblemType(resolvedCode);
  const message = serverProblemMessage(resolvedCode, locale);
  const problem = {
    type: `urn:cms:problem:server:${resolvedType}`,
    title: message.title,
    status,
    detail: message.detail,
    instance: '',
    code: resolvedCode,
    locale,
    extensions: { traceId },
  };
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.setHeader('content-type', 'application/problem+json; charset=UTF-8');
  res.statusCode = status;
  res.end(JSON.stringify(problem));
}


// ---------------------------------------------------------------------------
// Metrics mutators
// ---------------------------------------------------------------------------

function metricsStateInc(state: MetricsState, key: 'requestCount' | 'rateLimited' | 'oversized' | 'readinessFailures', by: number): void {
  if (key === 'requestCount') (state as { requestCount: number }).requestCount += by;
  else if (key === 'rateLimited') (state as { rateLimited: number }).rateLimited += by;
  else if (key === 'oversized') (state as { oversized: number }).oversized += by;
  else (state as { readinessFailures: number }).readinessFailures += by;
}

function metricsStateAdd(state: MetricsState, key: 'bytesIn' | 'bytesOut', by: number): void {
  if (key === 'bytesIn') (state as { bytesIn: number }).bytesIn += by;
  else (state as { bytesOut: number }).bytesOut += by;
}

function metricsStateIncStatus(state: MetricsState, status: number): void {
  state.statusCounts.set(status, (state.statusCounts.get(status) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Readiness probes
// ---------------------------------------------------------------------------

async function probeDatabase(storage: Storage): Promise<ReadinessCheck> {
  try {
    // `getTenantById` round-trips a SELECT; if the connection fails the
    // storage layer surfaces a `transaction_aborted` StorageError.
    await storage.getTenantById('00000000-0000-0000-0000-000000000000');
    return Object.freeze({ ok: true, detail: 'postgres reachable' });
  } catch {
    return Object.freeze({
      ok: false,
      detail: 'database unavailable',
    });
  }
}

async function probeObjectStore(config: ServerConfig): Promise<ReadinessCheck> {
  const endpoint = config.objectStore.endpoint.replace(/\/$/, '');
  const url = `${endpoint}/${config.objectStore.bucket}`;
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(config.oidc.fetchTimeoutMs),
    });
    if (response.ok || response.status === 403) {
      return Object.freeze({ ok: true, detail: 'object store endpoint reachable' });
    }
    return Object.freeze({ ok: false, detail: `object store returned status ${response.status}` });
  } catch {
    return Object.freeze({ ok: false, detail: 'object store unavailable' });
  }
}

async function probeOidc(config: ServerConfig): Promise<ReadinessCheck> {
  try {
    const response = await fetch(config.oidc.jwksUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(config.oidc.fetchTimeoutMs),
    });
    if (!response.ok) {
      return Object.freeze({ ok: false, detail: `OIDC JWKS returned status ${response.status}` });
    }
    const body: unknown = await response.json();
    const valid = typeof body === 'object'
      && body !== null
      && Array.isArray((body as { keys?: unknown }).keys);
    return Object.freeze({
      ok: valid,
      detail: valid ? 'OIDC JWKS reachable' : 'OIDC JWKS response invalid',
    });
  } catch {
    return Object.freeze({ ok: false, detail: 'OIDC JWKS unavailable' });
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * Boot the server. Loads config from `process.env`, constructs the
 * self-hosted server, runs an initial readiness probe, then starts the
 * HTTP listener. Failures during boot emit a redacted diagnostic and
 * exit non-zero.
 */
export async function startSelfHostedServer(options?: StartServerOptions): Promise<SelfHostedServer> {
  let config: ServerConfig;
  try {
    config = options?.config ?? loadServerConfig(process.env);
  } catch (err) {
    if (err instanceof ServerConfigError) {
      process.stderr.write(
        `${JSON.stringify({
          level: 'error',
          event: 'config.invalid',
          service: '@cms/server',
          timestamp: new Date().toISOString(),
          code: err.code,
          message: err.message,
          details: err.details,
        })}\n`,
      );
      process.exit(1);
    }
    throw err;
  }
  const effectiveOptions: StartServerOptions = { ...options, config };

  const server = createSelfHostedServer(effectiveOptions);

  const logger = effectiveOptions.logger ?? defaultLogger(config);
  logger.log('info', {
    event: 'config.loaded',
    config: describeServerConfig(config),
  });

  // Initial readiness: log only; do not block boot on transient backend outages.
  try {
    const report = await server.readiness();
    logger.log(report.status === 'ready' ? 'info' : 'warn', {
      event: 'readiness.boot',
      readinessStatus: report.status,
      database: report.checks.database.ok,
      objectStore: report.checks.objectStore.ok,
    });
  } catch (err) {
    logger.log('warn', {
      event: 'readiness.boot_failed',
      detail: err instanceof Error ? err.message : 'unknown',
    });
  }

  await server.listen();

  process.on('SIGINT', () => {
    void server.close().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void server.close().then(() => process.exit(0));
  });

  return server;
}

// Re-export config + auth surface for downstream tests and tooling.
export {
  loadServerConfig,
  describeServerConfig,
  ServerConfigError,
  SERVER_CONFIG_ERROR_CODES,
  type ServerConfig,
  type ServerConfigErrorCode,
  type ServerOidc,
  type ServerObjectStore,
  type ServerQuotas,
} from './config.js';
export {
  createOidcVerifier,
  createStorageIdentityResolver,
  ServerAuthError,
  SERVER_AUTH_ERROR_CODES,
  type JwksSource,
  type OidcVerifierOptions,
  type ServerAuthErrorCode,
} from './auth.js';

const executablePath = process.argv[1];
if (
  executablePath !== undefined
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(executablePath)
) {
  void startSelfHostedServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'server startup failed';
    process.stderr.write(`${JSON.stringify({
      level: 'error',
      event: 'server.start_failed',
      service: '@cms/server',
      message,
    })}\n`);
    process.exitCode = 1;
  });
}