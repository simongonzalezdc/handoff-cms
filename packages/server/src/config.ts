/**
 * @cms/server — strict portable server configuration.
 *
 * The server is operator-managed: every value comes from environment
 * variables prefixed `CMS_`. `loadServerConfig(env)` returns an immutable
 * `ServerConfig` or throws a `ServerConfigError`. The server is fail-closed:
 * missing or malformed values produce a startup error, never a silent
 * default. Operator diagnostics redact secret values so the same error is
 * safe to paste into an incident channel.
 *
 * Quotas are explicit and bounded; rate / request / upload limits are all
 * required, with deterministic integer parsing. The config layer never
 * reaches for the network, never parses JSON, and never trusts the env to
 * shape the server's behavior beyond these typed fields.
 */
import type { Locale } from '@cms/core';

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/** Stable machine-readable server config error codes. */
export const SERVER_CONFIG_ERROR_CODES = [
  'E_CONFIG_MISSING_REQUIRED',
  'E_CONFIG_INVALID_TYPE',
  'E_CONFIG_OUT_OF_RANGE',
  'E_CONFIG_INVALID_URL',
  'E_CONFIG_INVALID_LOG_LEVEL',
] as const;
Object.freeze(SERVER_CONFIG_ERROR_CODES);

export type ServerConfigErrorCode = (typeof SERVER_CONFIG_ERROR_CODES)[number];

/**
 * Thrown by `loadServerConfig`. Carries a stable code and a redacted,
 * operator-safe `details` bag. Never embeds secret values.
 */
export class ServerConfigError extends Error {
  public readonly code: ServerConfigErrorCode;
  public readonly details: Readonly<Record<string, string>>;
  constructor(
    code: ServerConfigErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'ServerConfigError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// ---------------------------------------------------------------------------
// Quota surface
// ---------------------------------------------------------------------------

/**
 * Operational quotas. All values are positive integers. `requestBytesCap`
 * bounds the per-request body size (413 once exceeded); `tenantRequestsPerMinute`
 * bounds the per-tenant request rate (429 once exceeded). The server never
 * silently relaxes these — they are the operator's contract with their users.
 */
export interface ServerQuotas {
  readonly requestBytesCap: number;
  readonly tenantRequestsPerMinute: number;
}

// ---------------------------------------------------------------------------
// S3-compatible object store
// ---------------------------------------------------------------------------

/** S3-compatible endpoint credentials. Used by readiness probes and adapters. */
export interface ServerObjectStore {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly forcePathStyle: boolean;
}

// ---------------------------------------------------------------------------
// OIDC surface
// ---------------------------------------------------------------------------

/**
 * OIDC verifier parameters. The host runs an OIDC issuer (Keycloak,
 * Authentik, Cognito, etc.) and publishes a JWKS endpoint. The verifier
 * fetches and caches keys, then checks audience, issuer, exp, nbf, and
 * signature. Symmetric (`HS*`) and `none` algorithms are refused.
 */
export interface ServerOidc {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  /** Bounded JWKS cache lifetime in seconds. */
  readonly jwksCacheSeconds: number;
  /** Bounded fetch timeout for JWKS / discovery in milliseconds. */
  readonly fetchTimeoutMs: number;
  /** Allowed JWS algorithms. The verifier refuses everything outside this list. */
  readonly algorithms: readonly string[];
}

// ---------------------------------------------------------------------------
// Final config
// ---------------------------------------------------------------------------

export interface ServerConfig {
  readonly nodeEnv: 'production' | 'staging' | 'development' | 'test';
  readonly port: number;
  readonly hostname: string;
  readonly publicUrl: string;
  readonly databaseUrl: string;
  readonly oidc: ServerOidc;
  readonly objectStore: ServerObjectStore;
  readonly quotas: ServerQuotas;
  readonly logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  readonly defaultLocale: Locale;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EnvSource = Readonly<Record<string, string | undefined>>;

function getString(env: EnvSource, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function requireString(
  env: EnvSource,
  key: string,
  details: Record<string, string>,
): string {
  const value = getString(env, key);
  if (value === undefined) {
    details['missing'] = key;
    throw new ServerConfigError(
      'E_CONFIG_MISSING_REQUIRED',
      `required configuration value ${key} is missing`,
      details,
    );
  }
  return value;
}

function parsePort(env: EnvSource, key: string, details: Record<string, string>): number {
  const raw = requireString(env, key, details);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || `${parsed}` !== raw || parsed < 1 || parsed > 65535) {
    details['invalid'] = key;
    throw new ServerConfigError(
      'E_CONFIG_INVALID_TYPE',
      `value of ${key} must be an integer port in [1, 65535]`,
      details,
    );
  }
  return parsed;
}

function parseNonNegativeInt(
  env: EnvSource,
  key: string,
  details: Record<string, string>,
): number {
  const raw = requireString(env, key, details);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || `${parsed}` !== raw || parsed < 0) {
    details['invalid'] = key;
    throw new ServerConfigError(
      'E_CONFIG_INVALID_TYPE',
      `value of ${key} must be a non-negative integer`,
      details,
    );
  }
  return parsed;
}

function parsePositiveInt(
  env: EnvSource,
  key: string,
  details: Record<string, string>,
): number {
  const parsed = parseNonNegativeInt(env, key, details);
  if (parsed === 0) {
    details['invalid'] = key;
    throw new ServerConfigError(
      'E_CONFIG_OUT_OF_RANGE',
      `value of ${key} must be greater than zero`,
      details,
    );
  }
  return parsed;
}

function parseUrl(
  env: EnvSource,
  key: string,
  details: Record<string, string>,
): string {
  const raw = requireString(env, key, details);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    details['invalid'] = key;
    throw new ServerConfigError(
      'E_CONFIG_INVALID_URL',
      `value of ${key} is not a valid URL`,
      details,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    details['invalid'] = key;
    throw new ServerConfigError(
      'E_CONFIG_INVALID_URL',
      `value of ${key} must use http:// or https://`,
      details,
    );
  }
  return parsed.toString();
}

function parseBool(
  env: EnvSource,
  key: string,
  defaultValue: boolean,
  details: Record<string, string>,
): boolean {
  const raw = getString(env, key);
  if (raw === undefined) return defaultValue;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  details['invalid'] = key;
  throw new ServerConfigError(
    'E_CONFIG_INVALID_TYPE',
    `value of ${key} must be true, false, 1, or 0`,
    details,
  );
}

const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'] as const;
type AllowedAlgorithm = (typeof ALLOWED_ALGORITHMS)[number];

const ALLOWED_LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;

function parseAlgorithms(
  env: EnvSource,
  key: string,
  details: Record<string, string>,
): readonly AllowedAlgorithm[] {
  const raw = requireString(env, key, details);
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    details['invalid'] = key;
    throw new ServerConfigError(
      'E_CONFIG_INVALID_TYPE',
      `value of ${key} must list at least one JWS algorithm`,
      details,
    );
  }
  const out: AllowedAlgorithm[] = [];
  for (const token of tokens) {
    if ((ALLOWED_ALGORITHMS as readonly string[]).includes(token)) {
      const algorithm = token as AllowedAlgorithm;
      if (!out.includes(algorithm)) out.push(algorithm);
      continue;
    }
    details['invalid'] = key;
    details['rejected'] = token;
    throw new ServerConfigError(
      'E_CONFIG_INVALID_TYPE',
      `value of ${key} includes a disallowed JWS algorithm: ${token}`,
      details,
    );
  }
  return Object.freeze(out);
}

function parseLogLevel(
  env: EnvSource,
  key: string,
  details: Record<string, string>,
): ServerConfig['logLevel'] {
  const raw = requireString(env, key, details);
  if ((ALLOWED_LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as ServerConfig['logLevel'];
  }
  details['invalid'] = key;
  details['rejected'] = raw;
  throw new ServerConfigError(
    'E_CONFIG_INVALID_LOG_LEVEL',
    `value of ${key} must be one of: ${ALLOWED_LOG_LEVELS.join(', ')}`,
    details,
  );
}

function parseLocale(
  env: EnvSource,
  key: string,
  details: Record<string, string>,
): Locale {
  const raw = requireString(env, key, details);
  if (raw === 'en' || raw === 'es') return raw;
  details['invalid'] = key;
  details['rejected'] = raw;
  throw new ServerConfigError(
    'E_CONFIG_INVALID_TYPE',
    `value of ${key} must be 'en' or 'es'`,
    details,
  );
}

function parseNodeEnv(
  env: EnvSource,
  key: string,
  details: Record<string, string>,
): ServerConfig['nodeEnv'] {
  const raw = requireString(env, key, details);
  if (
    raw === 'production' ||
    raw === 'staging' ||
    raw === 'development' ||
    raw === 'test'
  ) {
    return raw;
  }
  details['invalid'] = key;
  details['rejected'] = raw;
  throw new ServerConfigError(
    'E_CONFIG_INVALID_TYPE',
    `value of ${key} must be one of: production, staging, development, test`,
    details,
  );
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate the server configuration. The loader is pure: it does
 * not perform I/O, does not resolve env references at runtime, and never
 * throws for "missing optional" values — only for malformed or absent
 * required ones. Operator diagnostics on error never include the secret
 * values themselves; they only mention which key failed to parse.
 */
export function loadServerConfig(env: EnvSource): ServerConfig {
  const details: Record<string, string> = {};

  const nodeEnv = parseNodeEnv(env, 'CMS_NODE_ENV', { ...details });
  const port = parsePort(env, 'CMS_PORT', { ...details });
  const hostname = getString(env, 'CMS_HOSTNAME') ?? '0.0.0.0';
  const publicUrl = parseUrl(env, 'CMS_PUBLIC_URL', { ...details });
  const databaseUrl = requireString(env, 'CMS_DATABASE_URL', { ...details });

  const issuer = requireString(env, 'CMS_OIDC_ISSUER', { ...details });
  const audience = requireString(env, 'CMS_OIDC_AUDIENCE', { ...details });
  const jwksUrl = parseUrl(env, 'CMS_OIDC_JWKS_URL', { ...details });
  const jwksCacheSeconds = parsePositiveInt(env, 'CMS_OIDC_JWKS_CACHE_SECONDS', { ...details });
  const fetchTimeoutMs = parsePositiveInt(env, 'CMS_OIDC_FETCH_TIMEOUT_MS', { ...details });
  const algorithms = parseAlgorithms(env, 'CMS_OIDC_ALGORITHMS', { ...details });

  const objectEndpoint = parseUrl(env, 'CMS_OBJECT_ENDPOINT', { ...details });
  const objectBucket = requireString(env, 'CMS_OBJECT_BUCKET', { ...details });
  const objectAccessKeyId = requireString(env, 'CMS_OBJECT_ACCESS_KEY_ID', { ...details });
  const objectSecretAccessKey = requireString(env, 'CMS_OBJECT_SECRET_ACCESS_KEY', { ...details });
  const objectRegion = getString(env, 'CMS_OBJECT_REGION') ?? 'us-east-1';
  const objectForcePathStyle = parseBool(env, 'CMS_OBJECT_FORCE_PATH_STYLE', true, { ...details });

  const requestBytesCap = parsePositiveInt(env, 'CMS_QUOTA_REQUEST_BYTES_CAP', { ...details });
  const tenantRequestsPerMinute = parsePositiveInt(
    env,
    'CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE',
    { ...details },
  );

  const logLevel = parseLogLevel(env, 'CMS_LOG_LEVEL', { ...details });
  const defaultLocale = parseLocale(env, 'CMS_DEFAULT_LOCALE', { ...details });

  return Object.freeze({
    nodeEnv,
    port,
    hostname,
    publicUrl,
    databaseUrl,
    oidc: Object.freeze({
      issuer,
      audience,
      jwksUrl,
      jwksCacheSeconds,
      fetchTimeoutMs,
      algorithms,
    }),
    objectStore: Object.freeze({
      endpoint: objectEndpoint,
      bucket: objectBucket,
      accessKeyId: objectAccessKeyId,
      secretAccessKey: objectSecretAccessKey,
      region: objectRegion,
      forcePathStyle: objectForcePathStyle,
    }),
    quotas: Object.freeze({
      requestBytesCap,
      tenantRequestsPerMinute,
    }),
    logLevel,
    defaultLocale,
  });
}

// ---------------------------------------------------------------------------
// Diagnostics: redacted summary safe for operator logs / incident channels.
// ---------------------------------------------------------------------------

/**
 * Produce a redacted operator diagnostic summary of the loaded config.
 * Secret values are replaced with `***`. This is what `startSelfHostedServer`
 * emits at boot so operators can paste it into an incident channel without
 * leaking credentials.
 */
export function describeServerConfig(config: ServerConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    nodeEnv: config.nodeEnv,
    port: config.port,
    hostname: config.hostname,
    publicUrl: config.publicUrl,
    databaseUrl: redactDatabaseUrl(config.databaseUrl),
    oidc: Object.freeze({
      issuer: config.oidc.issuer,
      audience: config.oidc.audience,
      jwksUrl: config.oidc.jwksUrl,
      jwksCacheSeconds: config.oidc.jwksCacheSeconds,
      fetchTimeoutMs: config.oidc.fetchTimeoutMs,
      algorithms: config.oidc.algorithms,
    }),
    objectStore: Object.freeze({
      endpoint: config.objectStore.endpoint,
      bucket: config.objectStore.bucket,
      accessKeyId: '***',
      secretAccessKey: '***',
      region: config.objectStore.region,
      forcePathStyle: config.objectStore.forcePathStyle,
    }),
    quotas: config.quotas,
    logLevel: config.logLevel,
    defaultLocale: config.defaultLocale,
  });
}

function redactDatabaseUrl(raw: string): string {
  // Preserve scheme + host so the operator can confirm the database target,
  // but redact username, password, query, and the path tail that could carry
  // identifiers.
  try {
    const parsed = new URL(raw);
    parsed.username = '***';
    parsed.password = '***';
    parsed.pathname = '/***';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return '***';
  }
}