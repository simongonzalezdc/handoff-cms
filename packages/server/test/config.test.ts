/**
 * @cms/server — focused Vitest suite for `./src/config.ts`.
 *
 * Each test pins an observable contract of `loadServerConfig` /
 * `describeServerConfig`: required/invalid env inputs must fail closed
 * with a `ServerConfigError` carrying the right code, optional defaults
 * must be portable across hosts, quota bounds must reject non-positive
 * values, and the operator-facing diagnostic must never carry the DB
 * password, the object-store secret, or any configured OIDC token
 * material.
 *
 * The suite never builds a real Postgres / S3 / OIDC endpoint; it treats
 * the loader as pure.
 */
import { describe, expect, it } from 'vitest';
import {
  describeServerConfig,
  loadServerConfig,
  SERVER_CONFIG_ERROR_CODES,
  ServerConfigError,
  type ServerConfig,
  type ServerOidc,
} from '../src/config.js';

/** A baseline env that satisfies every required key with safe values. */
function baseline(overrides: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return Object.freeze({
    CMS_NODE_ENV: 'test',
    CMS_PORT: '8787',
    CMS_HOSTNAME: '127.0.0.1',
    CMS_PUBLIC_URL: 'https://cms.example.test',
    CMS_DATABASE_URL: 'postgres://appuser:s3cr3t@db.example.test:5432/cms',

    CMS_OIDC_ISSUER: 'https://issuer.example.test',
    CMS_OIDC_AUDIENCE: 'https://cms.example.test',
    CMS_OIDC_JWKS_URL: 'https://issuer.example.test/.well-known/jwks.json',
    CMS_OIDC_JWKS_CACHE_SECONDS: '300',
    CMS_OIDC_FETCH_TIMEOUT_MS: '4000',
    CMS_OIDC_ALGORITHMS: 'RS256,ES256',

    CMS_OBJECT_ENDPOINT: 'https://s3.example.test',
    CMS_OBJECT_BUCKET: 'cms-prod',
    CMS_OBJECT_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    CMS_OBJECT_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    CMS_OBJECT_REGION: 'us-east-1',
    CMS_OBJECT_FORCE_PATH_STYLE: 'true',

    CMS_QUOTA_REQUEST_BYTES_CAP: '65536',
    CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE: '120',

    CMS_LOG_LEVEL: 'info',
    CMS_DEFAULT_LOCALE: 'en',

    ...overrides,
  });
}

function oidc(overrides: Partial<ServerOidc> = {}): ServerOidc {
  return {
    issuer: 'https://issuer.example.test',
    audience: 'https://cms.example.test',
    jwksUrl: 'https://issuer.example.test/.well-known/jwks.json',
    jwksCacheSeconds: 300,
    fetchTimeoutMs: 4000,
    algorithms: ['RS256', 'ES256'],
    ...overrides,
  };
}

function loadBaseline(): ServerConfig {
  return loadServerConfig(baseline());
}

describe('loadServerConfig — required/invalid env fails closed', () => {
  it('loads a complete env into a frozen ServerConfig', () => {
    const config = loadBaseline();
    expect(config.port).toBe(8787);
    expect(config.nodeEnv).toBe('test');
    expect(config.quotas.requestBytesCap).toBe(65536);
    expect(config.quotas.tenantRequestsPerMinute).toBe(120);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.oidc)).toBe(true);
    expect(Object.isFrozen(config.quotas)).toBe(true);
    expect(Object.isFrozen(config.objectStore)).toBe(true);
    expect(Object.isFrozen(config.oidc.algorithms)).toBe(true);
  });

  it.each([
    'CMS_NODE_ENV',
    'CMS_PORT',
    'CMS_PUBLIC_URL',
    'CMS_DATABASE_URL',
    'CMS_OIDC_ISSUER',
    'CMS_OIDC_AUDIENCE',
    'CMS_OIDC_JWKS_URL',
    'CMS_OIDC_JWKS_CACHE_SECONDS',
    'CMS_OIDC_FETCH_TIMEOUT_MS',
    'CMS_OIDC_ALGORITHMS',
    'CMS_OBJECT_ENDPOINT',
    'CMS_OBJECT_BUCKET',
    'CMS_OBJECT_ACCESS_KEY_ID',
    'CMS_OBJECT_SECRET_ACCESS_KEY',
    'CMS_QUOTA_REQUEST_BYTES_CAP',
    'CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE',
    'CMS_LOG_LEVEL',
    'CMS_DEFAULT_LOCALE',
  ])('refuses to load when %s is missing (E_CONFIG_MISSING_REQUIRED)', (key) => {
    const env = { ...baseline() } as Record<string, string>;
    delete env[key];
    expect(() => loadServerConfig(env)).toThrow(ServerConfigError);
    try {
      loadServerConfig(env);
    } catch (err) {
      expect(err).toBeInstanceOf(ServerConfigError);
      const e = err as ServerConfigError;
      expect(e.code).toBe('E_CONFIG_MISSING_REQUIRED');
      expect(e.details['missing']).toBe(key);
    }
  });

  it.each([
    ['CMS_NODE_ENV', '', 'E_CONFIG_MISSING_REQUIRED'],
    ['CMS_PORT', 'abc', 'E_CONFIG_INVALID_TYPE'],
    ['CMS_PORT', '0', 'E_CONFIG_INVALID_TYPE'],
    ['CMS_PORT', '65536', 'E_CONFIG_INVALID_TYPE'],
    ['CMS_PORT', '-1', 'E_CONFIG_INVALID_TYPE'],
    ['CMS_PORT', '99999', 'E_CONFIG_INVALID_TYPE'],
    ['CMS_OIDC_JWKS_CACHE_SECONDS', '0', 'E_CONFIG_OUT_OF_RANGE'],
    ['CMS_OIDC_JWKS_CACHE_SECONDS', '-5', 'E_CONFIG_INVALID_TYPE'],
    ['CMS_QUOTA_REQUEST_BYTES_CAP', '0', 'E_CONFIG_OUT_OF_RANGE'],
    ['CMS_OIDC_ALGORITHMS', 'none', 'E_CONFIG_INVALID_TYPE'],
    ['CMS_OIDC_ALGORITHMS', 'HS256', 'E_CONFIG_INVALID_TYPE'],
    ['CMS_OIDC_ALGORITHMS', '', 'E_CONFIG_MISSING_REQUIRED'],
    ['CMS_PUBLIC_URL', 'not a url', 'E_CONFIG_INVALID_URL'],
    ['CMS_PUBLIC_URL', 'ftp://example.test/x', 'E_CONFIG_INVALID_URL'],
    ['CMS_LOG_LEVEL', 'loud', 'E_CONFIG_INVALID_LOG_LEVEL'],
    ['CMS_DEFAULT_LOCALE', 'fr', 'E_CONFIG_INVALID_TYPE'],
  ] as const)('refuses to load when %s=%j (typed error code)', (key, value, expectedCode) => {
    const env = { ...baseline(), [key]: value };
    const allowed = new Set<string>(SERVER_CONFIG_ERROR_CODES);
    expect(allowed.has(expectedCode)).toBe(true);
    try {
      loadServerConfig(env);
      throw new Error('expected loadServerConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServerConfigError);
      const e = err as ServerConfigError;
      expect(e.code).toBe(expectedCode);
      // details must identify the offending key (or its absence) and never
      // include the rejected secret value.
      const serialized = JSON.stringify(e.details);
      expect(serialized).toContain(key);
      expect(serialized).not.toMatch(/s3cr3t|password|secret/i);
    }
  });

  it('uses a deterministic, short list of error codes (closed union)', () => {
    expect([...SERVER_CONFIG_ERROR_CODES]).toEqual([
      'E_CONFIG_MISSING_REQUIRED',
      'E_CONFIG_INVALID_TYPE',
      'E_CONFIG_OUT_OF_RANGE',
      'E_CONFIG_INVALID_URL',
      'E_CONFIG_INVALID_LOG_LEVEL',
    ]);
  });

  it('whitespace-only values are treated as missing (fail closed)', () => {
    const env = { ...baseline(), CMS_DATABASE_URL: '   ' };
    expect(() => loadServerConfig(env)).toThrow(ServerConfigError);
    try {
      loadServerConfig(env);
    } catch (err) {
      expect((err as ServerConfigError).code).toBe('E_CONFIG_MISSING_REQUIRED');
      expect((err as ServerConfigError).details['missing']).toBe('CMS_DATABASE_URL');
    }
  });

  it('never throws a non-ServerConfigError for malformed env', () => {
    const env = { ...baseline(), CMS_PORT: 'NaN' };
    expect(() => loadServerConfig(env)).toThrow(ServerConfigError);
  });
});

describe('loadServerConfig — portable defaults', () => {
  it('defaults the listen host to 0.0.0.0 when CMS_HOSTNAME is absent', () => {
    const env = { ...baseline() } as Record<string, string>;
    delete env['CMS_HOSTNAME'];
    const config = loadServerConfig(env);
    expect(config.hostname).toBe('0.0.0.0');
  });

  it('defaults the object-store region to us-east-1 when CMS_OBJECT_REGION is absent', () => {
    const env = { ...baseline() } as Record<string, string>;
    delete env['CMS_OBJECT_REGION'];
    const config = loadServerConfig(env);
    expect(config.objectStore.region).toBe('us-east-1');
  });

  it('honors CMS_OBJECT_FORCE_PATH_STYLE only for the exact true/false tokens', () => {
    const truthy = ['true', '1'];
    const falsy = ['false', '0'];
    const invalid = ['unknown', 'TRUE', 'yes', 'no', 'on', 'off'];
    for (const raw of truthy) {
      const env = { ...baseline(), CMS_OBJECT_FORCE_PATH_STYLE: raw };
      expect(loadServerConfig(env).objectStore.forcePathStyle).toBe(true);
    }
    for (const raw of falsy) {
      const env = { ...baseline(), CMS_OBJECT_FORCE_PATH_STYLE: raw };
      expect(loadServerConfig(env).objectStore.forcePathStyle).toBe(false);
    }
    const absent = { ...baseline() } as Record<string, string>;
    delete absent['CMS_OBJECT_FORCE_PATH_STYLE'];
    expect(loadServerConfig(absent).objectStore.forcePathStyle).toBe(true);
    for (const raw of invalid) {
      const env = { ...baseline(), CMS_OBJECT_FORCE_PATH_STYLE: raw };
      expect(() => loadServerConfig(env)).toThrowError(
        expect.objectContaining({ code: 'E_CONFIG_INVALID_TYPE' }),
      );
    }
  });

  it('honors CMS_OBJECT_FORCE_PATH_STYLE=false when explicitly set', () => {
    const env = { ...baseline(), CMS_OBJECT_FORCE_PATH_STYLE: 'false' };
    const config = loadServerConfig(env);
    expect(config.objectStore.forcePathStyle).toBe(false);
  });

  it('rejects disallowed log levels (loud) but accepts the closed-set', () => {
    const allowedLevels = ['silent', 'error', 'warn', 'info', 'debug'];
    for (const level of allowedLevels) {
      const env = { ...baseline(), CMS_LOG_LEVEL: level };
      expect(() => loadServerConfig(env)).not.toThrow();
      expect(loadServerConfig(env).logLevel).toBe(level);
    }
    expect(() => loadServerConfig({ ...baseline(), CMS_LOG_LEVEL: 'verbose' })).toThrow(ServerConfigError);
  });

  it('accepts en/es locales and refuses anything else', () => {
    expect(loadServerConfig({ ...baseline(), CMS_DEFAULT_LOCALE: 'es' }).defaultLocale).toBe('es');
    expect(() => loadServerConfig({ ...baseline(), CMS_DEFAULT_LOCALE: 'de' })).toThrow(ServerConfigError);
  });

  it('accepts every allowed node environment', () => {
    for (const nodeEnv of ['production', 'staging', 'development', 'test']) {
      const env = { ...baseline(), CMS_NODE_ENV: nodeEnv };
      expect(loadServerConfig(env).nodeEnv).toBe(nodeEnv);
    }
    expect(() => loadServerConfig({ ...baseline(), CMS_NODE_ENV: 'qa' })).toThrow(ServerConfigError);
  });

  it('whitespace-trims string values before validation', () => {
    const env = { ...baseline(), CMS_PUBLIC_URL: '   https://cms.example.test   ' };
    expect(loadServerConfig(env).publicUrl).toBe('https://cms.example.test/');
  });

  it('normalizes CMS_PUBLIC_URL to end with a trailing slash', () => {
    const config = loadServerConfig({ ...baseline(), CMS_PUBLIC_URL: 'https://cms.example.test' });
    expect(config.publicUrl.endsWith('/')).toBe(true);
  });
});

describe('loadServerConfig — quota bounds', () => {
  it('refuses a non-numeric request byte cap', () => {
    expect(() =>
      loadServerConfig({ ...baseline(), CMS_QUOTA_REQUEST_BYTES_CAP: 'large' }),
    ).toThrow(ServerConfigError);
  });

  it('refuses a negative request byte cap', () => {
    expect(() =>
      loadServerConfig({ ...baseline(), CMS_QUOTA_REQUEST_BYTES_CAP: '-1' }),
    ).toThrow(ServerConfigError);
  });

  it('refuses a zero request byte cap (out-of-range, not silent default)', () => {
    try {
      loadServerConfig({ ...baseline(), CMS_QUOTA_REQUEST_BYTES_CAP: '0' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ServerConfigError).code).toBe('E_CONFIG_OUT_OF_RANGE');
      expect((err as ServerConfigError).details['invalid']).toBe('CMS_QUOTA_REQUEST_BYTES_CAP');
    }
  });

  it('refuses a zero tenant requests-per-minute (out-of-range)', () => {
    try {
      loadServerConfig({ ...baseline(), CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE: '0' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ServerConfigError).code).toBe('E_CONFIG_OUT_OF_RANGE');
    }
  });

  it('refuses a fractional or non-integer quota value', () => {
    expect(() =>
      loadServerConfig({ ...baseline(), CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE: '12.5' }),
    ).toThrow(ServerConfigError);
    expect(() =>
      loadServerConfig({ ...baseline(), CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE: '12e1' }),
    ).toThrow(ServerConfigError);
  });

  it('only accepts asymmetric JWS algorithms in CMS_OIDC_ALGORITHMS', () => {
    for (const rejected of ['none', 'HS256', 'HS384', 'HS512']) {
      expect(() =>
        loadServerConfig({ ...baseline(), CMS_OIDC_ALGORITHMS: rejected }),
      ).toThrow(ServerConfigError);
    }
  });

  it('accepts each allowed asymmetric algorithm individually', () => {
    const allowed = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];
    for (const alg of allowed) {
      const config = loadServerConfig({ ...baseline(), CMS_OIDC_ALGORITHMS: alg });
      expect([...config.oidc.algorithms]).toEqual([alg]);
    }
  });

  it('rejects an empty algorithm list', () => {
    expect(() => loadServerConfig({ ...baseline(), CMS_OIDC_ALGORITHMS: ' ' })).toThrow(ServerConfigError);
  });

  it('rejects an algorithm list that mixes a refused and an allowed value', () => {
    try {
      loadServerConfig({ ...baseline(), CMS_OIDC_ALGORITHMS: 'RS256, HS256' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ServerConfigError).code).toBe('E_CONFIG_INVALID_TYPE');
      expect((err as ServerConfigError).details['rejected']).toBe('HS256');
    }
  });
});

describe('describeServerConfig — operator diagnostic stays redacted', () => {
  const SECRET_PASSWORD = 'p@ssw0rd-c0mpl3x-Example123';
  const DB_URL = `postgres://appuser:${SECRET_PASSWORD}@db.example.test:5432/cms?sslmode=require&application_name=cms`;
  const OBJECT_SECRET = 'object-secret-7YqX-EXAMPLE-DONOTLOG';
  const OIDC_AUDIENCE = 'https://cms.example.test';

  function build(): ServerConfig {
    return loadServerConfig(
      baseline({
        CMS_DATABASE_URL: DB_URL,
        CMS_OBJECT_SECRET_ACCESS_KEY: OBJECT_SECRET,
      }),
    );
  }

  it('never includes the database password in describeServerConfig', () => {
    const described = describeServerConfig(build());
    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain(SECRET_PASSWORD);
    expect(serialized).not.toContain('p%40ssw0rd');
    expect((serialized.match(/password/gi) ?? []).length).toBe(0);
  });

  it('redacts the database URL user, password, query, and tail path', () => {
    const described = describeServerConfig(build()) as Record<string, unknown>;
    const dbUrl = described['databaseUrl'] as string;
    expect(dbUrl).not.toContain(SECRET_PASSWORD);
    expect(dbUrl).not.toContain('appuser');
    expect(dbUrl).not.toContain('sslmode');
    expect(dbUrl).not.toContain('cms?');
    // Allowed to retain scheme + host so the operator can confirm the target.
    expect(dbUrl.startsWith('postgres://')).toBe(true);
    expect(dbUrl).toContain('db.example.test');
  });

  it('replaces object-store access keys with the literal *** (never the secret value)', () => {
    const described = describeServerConfig(build()) as Record<string, unknown>;
    const objectStore = described['objectStore'] as Record<string, unknown>;
    expect(objectStore['accessKeyId']).toBe('***');
    expect(objectStore['secretAccessKey']).toBe('***');
    expect(JSON.stringify(described)).not.toContain(OBJECT_SECRET);
    // Object bucket and region are NOT secrets; they must remain visible.
    expect(objectStore['bucket']).toBe('cms-prod');
    expect(objectStore['region']).toBe('us-east-1');
  });

  it('never embeds OIDC token material in the diagnostic', () => {
    const described = describeServerConfig(build()) as Record<string, unknown>;
    const oidcSurface = described['oidc'] as Record<string, unknown>;
    // The OIDC surface never carries a token, but assert it serially so a
    // regression that adds an `idToken`/`accessToken` field trips the test.
    const serialized = JSON.stringify(oidcSurface);
    for (const forbidden of ['id_token', 'accessToken', 'refreshToken', 'authorization']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // Audience stays present and matches the configured audience verbatim
    // (it is not a secret; it identifies the verifier, not the holder).
    expect(oidcSurface['audience']).toBe(OIDC_AUDIENCE);
    expect(oidcSurface['issuer']).toBe('https://issuer.example.test');
  });

  it('still surfaces non-secret operator-relevant fields', () => {
    const described = describeServerConfig(build()) as Record<string, unknown>;
    expect(described['publicUrl']).toBe('https://cms.example.test/');
    expect(described['logLevel']).toBe('info');
    expect(described['defaultLocale']).toBe('en');
    expect(described['quotas']).toBeDefined();
    expect(described['objectStore']).toBeDefined();
  });

  it('returns an immutable, frozen record', () => {
    const described = describeServerConfig(build());
    expect(Object.isFrozen(described)).toBe(true);
  });

  it('round-trips port/host/oidc without leaking the secret values', () => {
    const config = loadServerConfig(
      baseline({
        CMS_DATABASE_URL: DB_URL,
        CMS_OBJECT_SECRET_ACCESS_KEY: OBJECT_SECRET,
      }),
    );
    const described = describeServerConfig(config) as Record<string, unknown>;
    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain(SECRET_PASSWORD);
    expect(serialized).not.toContain(OBJECT_SECRET);
    expect(serialized).not.toContain('?sslmode=require');
    expect(serialized).not.toContain('application_name=cms');
  });

  it('also refuses to leak secrets inside ServerConfigError.details', () => {
    try {
      loadServerConfig(
        baseline({
          CMS_OBJECT_SECRET_ACCESS_KEY: OBJECT_SECRET,
          CMS_PORT: 'not-a-port',
        }),
      );
      throw new Error('expected throw');
    } catch (err) {
      const e = err as ServerConfigError;
      const serialized = JSON.stringify({ message: e.message, details: e.details });
      expect(serialized).not.toContain(OBJECT_SECRET);
    }
  });
});

describe('loadServerConfig — algorithm allow-list is the same one the verifier uses', () => {
  it('parses CMS_OIDC_ALGORITHMS into the ServerOidc.algorithms used downstream', () => {
    const config = loadServerConfig({ ...baseline(), CMS_OIDC_ALGORITHMS: 'RS256,ES256,PS256' });
    const expected: ServerOidc['algorithms'] = ['RS256', 'ES256', 'PS256'];
    expect([...config.oidc.algorithms]).toEqual([...expected]);
    expect(Object.isFrozen(config.oidc.algorithms)).toBe(true);
  });

  it('preserves duplicate-free order (verifier matches by Set, but diagnostics are ordered)', () => {
    const config = loadServerConfig({ ...baseline(), CMS_OIDC_ALGORITHMS: ' RS256 , ES256 , RS256 ' });
    expect([...config.oidc.algorithms]).toEqual(['RS256', 'ES256']);
  });
});
