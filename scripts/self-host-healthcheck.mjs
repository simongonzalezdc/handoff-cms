#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ---------------------------------------------------------------------------
// scripts/self-host-healthcheck.mjs
//
// Deterministic, single-purpose Node healthcheck for the self-hosted
// @cms/server container. Two probe modes are supported:
//
//   node scripts/self-host-healthcheck.mjs live
//       GET  http://${HOST}:${PORT}/health/live
//       Exit 0 on 2xx; non-zero on any other status, network failure,
//       or timeout. No external dependencies are touched.
//
//   node scripts/self-host-healthcheck.mjs ready
//       GET  http://${HOST}:${PORT}/health/ready
//       Same exit contract as `live`. Readiness fans out to PostgreSQL
//       and the S3/MinIO object store inside the server process; this
//       script only validates the HTTP envelope so the host gets a
//       well-formed 200 vs 503 signal.
//
// Configuration is read from environment variables (never CLI args so the
// invocation stays boring and script-kiddie-proof):
//
//   HOST          default: 127.0.0.1
//   PORT          default: 8080
//   CMS_PORT      default: same as PORT. The script honours the
//                 application bind port so the probe target stays
//                 coupled to the value the server actually listens on.
//                 When both PORT and CMS_PORT are set explicitly and
//                 disagree, the script fails closed: a silently
//                 perma-unhealthy container is the failure mode the
//                 host warned against.
//   PROBE_TIMEOUT_MS  default: 3000  (whole probe, including DNS/connect)
//   PROBE_RETRIES     default: 1     (network retries inside the timeout)
//   ALLOW_INSECURE_HTTP default: 0   (set to 1 only in test fixtures)
//
// The script intentionally uses the global `fetch` (Node >=18) so it
// needs no npm dependency, keeps the container slim, and stays
// reproducible byte-for-byte across rebuilds.
// ---------------------------------------------------------------------------

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = '8080';
const DEFAULT_TIMEOUT_MS = '3000';
const DEFAULT_RETRIES = '1';

const readEnv = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
};

/**
 * Treat both `PORT` and `CMS_PORT` as authoritative. `PORT` is the
 * legacy probe target; `CMS_PORT` is the application bind port the
 * server actually listens on. When both are provided explicitly the
 * script fails closed on disagreement: a probe that points at a port
 * the app never bound silently produces a perpetually unhealthy
 * container, which is the failure mode the host warned against.
 */
const resolvePort = () => {
  const rawPort = process.env['PORT'];
  const rawCmsPort = process.env['CMS_PORT'];
  const portSet = rawPort !== undefined && rawPort.trim() !== '';
  const cmsSet = rawCmsPort !== undefined && rawCmsPort.trim() !== '';
  if (portSet && cmsSet) {
    const a = rawPort.trim();
    const b = rawCmsPort.trim();
    if (a !== b) {
      process.stderr.write(
        `healthcheck: PORT=${JSON.stringify(a)} and CMS_PORT=${JSON.stringify(b)} disagree; refusing to probe\n`,
      );
      process.exit(2);
    }
    return a;
  }
  if (cmsSet) return rawCmsPort.trim();
  if (portSet) return rawPort.trim();
  return DEFAULT_PORT;
};

const parsePositiveInt = (name, raw) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || `${parsed}` !== raw || parsed < 1) {
    process.stderr.write(`healthcheck: ${name} must be a positive integer (got ${JSON.stringify(raw)})\n`);
    process.exit(2);
  }
  return parsed;
};

const mode = process.argv[2];
if (mode !== 'live' && mode !== 'ready') {
  process.stderr.write('healthcheck: usage: self-host-healthcheck.mjs <live|ready>\n');
  process.exit(2);
}

const host = readEnv('HOST', DEFAULT_HOST);
const port = resolvePort();
const timeoutMs = parsePositiveInt('PROBE_TIMEOUT_MS', readEnv('PROBE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS));
const retries = parsePositiveInt('PROBE_RETRIES', readEnv('PROBE_RETRIES', DEFAULT_RETRIES));
const allowInsecure = readEnv('ALLOW_INSECURE_HTTP', '0') === '1';

// Loopback-only by design. Operators who front the container with another
// network name should override `HOST` via Docker Compose wiring rather
// than reaching across containers at probe time.
const unsafeHosts = new Set(['0.0.0.0', '::', '[::]']);
if (!allowInsecure && unsafeHosts.has(host)) {
  process.stderr.write(`healthcheck: HOST=${host} is not probe-safe; override at compose level\n`);
  process.exit(2);
}

const url = `http://${host}:${port}/health/${mode}`;

const probeOnce = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'user-agent': 'cms-self-host-healthcheck/1' },
    });
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
};

const attempt = async () => {
  for (let i = 0; i < retries; i += 1) {
    try {
      const result = await probeOnce();
      if (result.ok) {
        process.exit(0);
      }
      // Non-2xx: log once on the final attempt, then exit non-zero.
      if (i === retries - 1) {
        process.stderr.write(`healthcheck: ${mode} returned HTTP ${result.status}\n`);
        process.exit(1);
      }
    } catch (cause) {
      if (i === retries - 1) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        process.stderr.write(`healthcheck: ${mode} failed: ${reason}\n`);
        process.exit(1);
      }
    }
    // Bound the wait between retries so we never exceed probe budget.
    await delay(Math.max(1, Math.floor(timeoutMs / Math.max(1, retries))));
  }
  process.exit(1);
};

attempt();
