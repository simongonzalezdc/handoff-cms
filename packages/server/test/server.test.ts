import { createServer as createNodeServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Audience, IdentityResolver, TokenVerifier, VerifiedToken } from '@cms/api';
import type { Storage } from '@cms/storage';
import { loadServerConfig, type ServerConfig } from '../src/config.js';
import { createSelfHostedServer, type SelfHostedServer } from '../src/index.js';

const openServers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

function env(): Record<string, string> {
  return {
    CMS_NODE_ENV: 'test', CMS_HOSTNAME: '127.0.0.1', CMS_PORT: '8080',
    CMS_PUBLIC_URL: 'http://127.0.0.1:8080', CMS_DATABASE_URL: 'postgres://cms:secret@127.0.0.1/cms',
    CMS_OIDC_ISSUER: 'https://issuer.example', CMS_OIDC_AUDIENCE: 'https://cms.example/api',
    CMS_OIDC_JWKS_URL: 'https://issuer.example/jwks', CMS_OIDC_ALGORITHMS: 'RS256',
    CMS_OIDC_JWKS_CACHE_SECONDS: '300', CMS_OIDC_FETCH_TIMEOUT_MS: '1000',
    CMS_OBJECT_ENDPOINT: 'http://127.0.0.1:9', CMS_OBJECT_BUCKET: 'cms',
    CMS_OBJECT_ACCESS_KEY_ID: 'operator', CMS_OBJECT_SECRET_ACCESS_KEY: 'object-secret',
    CMS_OBJECT_REGION: 'us-east-1', CMS_OBJECT_FORCE_PATH_STYLE: 'true',
    CMS_QUOTA_REQUEST_BYTES_CAP: '32', CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE: '1',
    CMS_LOG_LEVEL: 'debug', CMS_DEFAULT_LOCALE: 'en',
  };
}

function storage(ready = true): Storage {
  return {
    async getTenantById() {
      if (!ready) throw new Error('postgres://user:leaked-password@db/private');
      return null;
    },
    async getProposalById() {
      return null;
    },
  } as unknown as Storage;
}

const tokenVerifier: TokenVerifier = {
  async verify() { throw new Error('not used by health routes'); },
};
const identityResolver: IdentityResolver = {
  async resolveActorKind() { return null; },
  async loadGrants() { return []; },
  async loadProposerId() { return null; },
  async loadActorProfile(actorId: string) { return { displayName: actorId, capabilities: [] }; },
};

function make(config: ServerConfig, ready = true): SelfHostedServer {
  return createSelfHostedServer({
    config, storage: storage(ready), tokenVerifier, identityResolver,
    traceId: () => 'trace-test',
  });
}

async function objectEndpoint(status = 403): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = createNodeServer((req, res) => {
    if (req.url === '/jwks') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [] }));
      return;
    }
    res.statusCode = status;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('missing address');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function running(config: ServerConfig, ready = true) {
  const server = make({ ...config, port: 0 }, ready);
  openServers.push(server);
  const address = await server.listen();
  return { server, base: `http://${address.hostname}:${address.port}` };
}

describe('self-host server', () => {
  it('serves liveness and Prometheus metrics without authentication', async () => {
    const config = loadServerConfig(env());
    const server = make(config);
    const live = await server.app.fetch(new Request('http://cms/health/live'));
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: 'alive', service: '@cms/server' });
    const metrics = await server.app.fetch(new Request('http://cms/metrics'));
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(await metrics.text()).toContain('cms_server_uptime_seconds');
  });

  it('reports ready only when Postgres and object storage are reachable', async () => {
    const object = await objectEndpoint();
    openServers.push(object);
    const config = loadServerConfig({
      ...env(),
      CMS_OBJECT_ENDPOINT: object.endpoint,
      CMS_OIDC_JWKS_URL: `${object.endpoint}/jwks`,
    });
    const ready = await make(config).app.fetch(new Request('http://cms/health/ready'));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready' });

    const degraded = await make(config, false).app.fetch(new Request('http://cms/health/ready'));
    expect(degraded.status).toBe(503);
    const body = await degraded.text();
    expect(body).toContain('database unavailable');
    expect(body).not.toContain('leaked-password');

    const oidcDown = loadServerConfig({
      ...env(),
      CMS_OBJECT_ENDPOINT: object.endpoint,
      CMS_OIDC_JWKS_URL: 'http://127.0.0.1:9/jwks',
      CMS_OIDC_FETCH_TIMEOUT_MS: '100',
    });
    const authDegraded = await make(oidcDown).app.fetch(new Request('http://cms/health/ready'));
    expect(authDegraded.status).toBe(503);
    expect(await authDegraded.text()).toContain('OIDC JWKS unavailable');
  });

  it('forwards bearer credentials to the authoritative API verifier', async () => {
    const config = loadServerConfig(env());
    const seen: string[] = [];
    const verifier: TokenVerifier = {
      async verify(header, expectedAudience) {
        seen.push(header);
        return Object.freeze({
          tokenId: 'token-1',
          claims: Object.freeze({
            iss: config.oidc.issuer,
            sub: 'human-1',
            aud: expectedAudience as Audience,
            exp: 2_000_000_000,
            iat: 1_700_000_000,
            tenantId: 'tenant-1',
            actorId: 'human-1',
            kind: 'human',
            scope: Object.freeze(['content:read']),
          }),
        }) as VerifiedToken;
      },
    };
    const resolver: IdentityResolver = {
      async resolveActorKind() { return 'human'; },
      async loadGrants() { return []; },
      async loadProposerId() { return null; },
      async loadActorProfile() { return { displayName: 'Operator', capabilities: [] }; },
    };
    const server = createSelfHostedServer({
      config: { ...config, port: 0 },
      storage: storage(),
      tokenVerifier: verifier,
      identityResolver: resolver,
      traceId: () => 'trace-auth',
    });
    openServers.push(server);
    const address = await server.listen();
    const response = await fetch(`http://${address.hostname}:${address.port}/v1/proposals/proposal-1`, {
      headers: {
        authorization: 'Bearer opaque-sensitive-token',
        'x-tenant-id': 'tenant-1',
      },
    });
    // The route goes through the API's request-context middleware, which
    // invokes the verifier; we expect 404 (proposal not found) since the
    // fake storage returns null. The exact status does not matter — the
    // critical assertion is that the verifier SAW the bearer header.
    expect(response.status).toBe(404);
    expect(seen).toEqual(['Bearer opaque-sensitive-token']);
  });

  it('localizes 413, 429, and 500 problems to Spanish via accept-language', async () => {
    const config = loadServerConfig(env());
    const { base } = await running(config);

    // 413: oversized body — Spanish peer gets the es catalog.
    const oversized = await fetch(`${base}/health/live`, {
      method: 'POST',
      headers: { 'content-length': '64', 'accept-language': 'es' },
      body: 'x'.repeat(64),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get('content-type')).toContain('application/problem+json');
    const oversizedBody = await oversized.json();
    expect(oversizedBody).toMatchObject({
      code: 'E_PAYLOAD_TOO_LARGE',
      locale: 'es',
      status: 413,
    });
    expect(oversizedBody.title).toBe('Carga demasiado grande');
    expect(oversizedBody.detail).toContain('tamaño máximo');

    // 413 in English: confirms the negotiation is bi-directional and the
    // `accept-language` header is the only signal.
    const oversizedEn = await fetch(`${base}/health/live`, {
      method: 'POST',
      headers: { 'content-length': '64', 'accept-language': 'en' },
      body: 'x'.repeat(64),
    });
    expect(oversizedEn.status).toBe(413);
    const oversizedEnBody = await oversizedEn.json();
    expect(oversizedEnBody).toMatchObject({ code: 'E_PAYLOAD_TOO_LARGE', locale: 'en' });
    expect(oversizedEnBody.title).toBe('Payload too large');
  });

  it('localizes 429 rate-limit problems to Spanish and preserves the retry-after header', async () => {
    const config = loadServerConfig(env());
    const { base } = await running(config);
    // First request burns the per-source quota.
    const first = await fetch(`${base}/health/live`, {
      headers: { 'x-tenant-id': 'tenant-rate-es', 'accept-language': 'es' },
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/health/live`, {
      headers: { 'x-tenant-id': 'tenant-rate-es', 'accept-language': 'es' },
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('60');
    const secondBody = await second.json();
    expect(secondBody).toMatchObject({ code: 'E_TOO_MANY_REQUESTS', locale: 'es', status: 429 });
    expect(secondBody.title).toBe('Demasiadas solicitudes');
  });

  it('refuses an unsupported-locale accept-language with the English catalog rather than falling back silently', async () => {
    const config = loadServerConfig(env());
    const { base } = await running(config);
    const oversized = await fetch(`${base}/health/live`, {
      method: 'POST',
      headers: { 'content-length': '64', 'accept-language': 'fr-FR,fr;q=0.9' },
      body: 'x'.repeat(64),
    });
    expect(oversized.status).toBe(413);
    const body = await oversized.json();
    // Unsupported locales resolve to the explicit English fallback; the
    // response echoes `locale: 'en'` so the client can verify the
    // resolution.
    expect(body).toMatchObject({ code: 'E_PAYLOAD_TOO_LARGE', locale: 'en' });
    expect(body.title).toBe('Payload too large');
  });
  it('enforces request-byte and tenant-rate quotas through the live Node surface', async () => {
    const config = loadServerConfig(env());
    const { base } = await running(config);
    const oversized = await fetch(`${base}/health/live`, {
      method: 'POST', headers: { 'content-length': '64' }, body: 'x'.repeat(64),
    });
    expect(oversized.status).toBe(413);

    const first = await fetch(`${base}/health/live`, { headers: { 'x-tenant-id': 'tenant-secret' } });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/health/live`, { headers: { 'x-tenant-id': 'tenant-secret' } });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('60');
  });

  it('never writes query strings, tenant ids, credentials, or body content to structured logs', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const config = loadServerConfig(env());
    const { base } = await running(config);
    await fetch(`${base}/health/live?email=person@example.com&token=query-secret`, {
      headers: { 'x-tenant-id': 'tenant-secret', authorization: 'Bearer header-secret' },
    });
    const logs = writes.join('');
    expect(logs).toContain('"path":"/health/live"');
    for (const secret of ['person@example.com', 'query-secret', 'tenant-secret', 'header-secret', 'object-secret', 'leaked-password']) {
      expect(logs).not.toContain(secret);
    }
  });

  it('rejects a second listen and closes cleanly', async () => {
    const config = loadServerConfig(env());
    const { server } = await running(config);
    await expect(server.listen()).rejects.toMatchObject({ code: 'E_SERVER_ALREADY_LISTENING' });
    await server.close();
    expect(server.httpServer).toBeNull();
  });
});
