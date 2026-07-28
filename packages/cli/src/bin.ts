#!/usr/bin/env node
/**
 * @cms/cli/bin — `cms` entrypoint.
 *
 * The bin is a thin adapter that:
 *   1. wires process stdio + globals into `runCli`;
 *   2. uses a deny-by-default browser seam; production hosts must inject a
 *      real interactive delegated-human authorization implementation;
 *   3. sets `process.exitCode` from the `runCli` result.
 *
 * No policy or state logic lives here; the runner is the CLI.
 */

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  defaultAuthSeam,
  runCli,
  type BrowserAuthorizationSeam,
  type CliDeps,
} from './index.js';

export interface BrowserAuthorizationRuntime {
  readonly fetchFn?: CliDeps['fetchFn'];
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly writeStderr?: (chunk: string) => void;
}

interface LoadedSeam {
  readonly name: string;
  readonly seam: BrowserAuthorizationSeam;
}

export async function loadBrowserSeam(
  env: Readonly<Record<string, string | undefined>>,
  runtime: BrowserAuthorizationRuntime = {},
): Promise<LoadedSeam> {
  const fetchFn = runtime.fetchFn ?? (globalThis.fetch.bind(globalThis) as CliDeps['fetchFn']);
  const now = runtime.now ?? (() => Date.now());
  const sleep = runtime.sleep ?? delay;
  const writeStderr = runtime.writeStderr ?? ((chunk: string) => process.stderr.write(chunk));
  const name = env['CMS_BROWSER_SEAM'] ?? 'deny';
  if (name === 'deny') {
    return {
      name,
      seam: {
        async requestInteractiveDelegatedSession() {
          throw new Error('CMS_BROWSER_SEAM is unset; refuse every privileged command');
        },
      },
    };
  }
  if (name === 'device') {
    const authorizationEndpoint = env['CMS_DEVICE_AUTHORIZATION_ENDPOINT'];
    const tokenEndpoint = env['CMS_DEVICE_TOKEN_ENDPOINT'];
    if (!authorizationEndpoint || !tokenEndpoint) {
      return {
        name,
        seam: {
          async requestInteractiveDelegatedSession() {
            throw new Error(
              'CMS_BROWSER_SEAM=device requires CMS_DEVICE_AUTHORIZATION_ENDPOINT and CMS_DEVICE_TOKEN_ENDPOINT',
            );
          },
        },
      };
    }
    return {
      name,
      seam: {
        async requestInteractiveDelegatedSession({ tenantId, audience, verificationUri }) {
          const authorization = await postJson(fetchFn, authorizationEndpoint, {
            tenant_id: tenantId,
            audience,
          });
          const deviceCode = requiredString(authorization, 'device_code');
          const userCode = requiredString(authorization, 'user_code');
          const resolvedVerificationUri =
            optionalString(authorization, 'verification_uri') ?? verificationUri;
          const expiresIn = positiveNumber(authorization, 'expires_in', 600);
          let intervalSeconds = positiveNumber(authorization, 'interval', 5);
          const deadline = now() + expiresIn * 1000;
          writeStderr(`Open ${resolvedVerificationUri} and enter code ${userCode}\n`);

          while (now() < deadline) {
            await sleep(intervalSeconds * 1000);
            if (now() >= deadline) break;
            const token = await postJson(fetchFn, tokenEndpoint, {
              device_code: deviceCode,
              tenant_id: tenantId,
              audience,
            }, true);
            const error = optionalString(token, 'error');
            if (error === 'authorization_pending') continue;
            if (error === 'slow_down') {
              intervalSeconds += 5;
              continue;
            }
            if (error) throw new Error(`device authorization failed: ${error}`);
            return {
              token: requiredString(token, 'access_token'),
              subject: requiredString(token, 'subject'),
              displayName: optionalString(token, 'display_name') ?? 'Authenticated operator',
              issuedAt: new Date(now()).toISOString(),
              expiresAt:
                optionalString(token, 'expires_at') ??
                new Date(
                  now() + positiveNumber(token, 'expires_in', 300) * 1000,
                ).toISOString(),
              deviceCode,
              userCode,
              verificationUri: resolvedVerificationUri,
              tenantId,
            };
          }
          throw new Error('device authorization expired before human approval');
        },
      },
    };
  }
  return {
    name: 'unknown',
    seam: {
      async requestInteractiveDelegatedSession() {
        throw new Error(
          `unknown CMS_BROWSER_SEAM=${name}; only 'deny' and 'device' are built in`,
        );
      },
    },
  };
}

async function postJson(
  fetchFn: CliDeps['fetchFn'],
  url: string,
  body: Readonly<Record<string, unknown>>,
  allowOAuthErrors = false,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`device authorization endpoint returned malformed JSON (status ${response.status})`);
  }
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isOAuthError =
    isObject && typeof (value as Record<string, unknown>)['error'] === 'string';
  if (!isObject || (!response.ok && !(allowOAuthErrors && isOAuthError))) {
    throw new Error(`device authorization endpoint failed with status ${response.status}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`device authorization response missing ${key}`);
  }
  return field;
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function positiveNumber(
  value: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) && field > 0
    ? field
    : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) env[k] = v;
  const seam = await loadBrowserSeam(env);
  const deps: CliDeps = {
    fetchFn: globalThis.fetch.bind(globalThis) as CliDeps['fetchFn'],
    stdout: process.stdout,
    stderr: process.stderr,
    browser: seam.seam,
    auth: defaultAuthSeam,
    now: { now: () => new Date() },
    uuid: { uuid: () => randomUUID() },
    audience: 'cms-api-aud',
    defaultDeviceVerificationUri: 'https://device.example/activate',
  };
  const result = await runCli({ argv, env, deps });
  process.exitCode = result.exitCode;
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`fatal: ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  });
}

export { main };
