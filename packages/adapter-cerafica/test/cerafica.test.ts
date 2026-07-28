/**
 * Integration tests for `@cms/adapter-cerafica`.
 *
 * Each test constructs a real on-disk fixture (via `mkdtemp`/`symlinkSync`)
 * or an in-memory stub and drives the adapter through the SDK contract.
 * The tests are organised by contract surface:
 *
 *   - Manifest parsing (strict, locked shape, English/Spanish peer-alt).
 *   - Activation / reconciliation (alias verification, refusal modes).
 *   - Canonical-only apply (alias / derived / service / environment).
 *   - Journal discovery (read-only) and unsupportable journal write.
 *   - Commerce field gating (coordinator-only, no free-edit path).
 *   - GitHub Pages deploy capability (synchronous receipt, async
 *     reconciliation, rollback via injected writer).
 *
 * The adapter's contract is locked to the cerafica host, so the
 * frozen-core conformance harness (which uses a generic binding) is
 * not applicable here; the adapter verifies the same contract
 * invariants inline where they are exercisable against the host.
 */

import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AdapterContractError,
  type CanonicalWrite,
  type Identity,
  type Iso8601,
  type Sha256Hex,
} from '@cms/adapter-sdk';

import {
  CERAFICA_ADAPTER_ID,
  CeraficaAdapter,
  createCeraficaAdapter,
  JournalWriteUnsupportedError,
  ManifestValidationError,
  RollbackApprovalHashMismatchError,
  createGitHubPagesDeployCapability,
  isFieldReadOnly,
  __internal__,
  loadManifest,
  manifestToActivationContract,
  parseManifest,
  type CeraficaAdapterOptions,
  type CeraficaManifest,
  type GitHubPagesDeployClient,
  type GitHubPagesDeployReceipt,
  type RollbackWriter,
} from '../src/index.js';

const SHA = (hex: string): Sha256Hex => hex as Sha256Hex;
const ISO = (s: string): Iso8601 => s as Iso8601;

const HUMAN: Identity = Object.freeze({
  id: 'human-1',
  kind: 'actor',
  displayName: 'Human Author',
  capabilities: Object.freeze(['canonical.write']),
});

const SERVICE: Identity = Object.freeze({
  id: 'service-1',
  kind: 'service',
  displayName: 'Bot Service',
  capabilities: Object.freeze(['canonical.write']),
});

const MCP_AGENT: Identity = Object.freeze({
  id: 'mcp-1',
  kind: 'service',
  displayName: 'MCP Agent',
  capabilities: Object.freeze(['mcp']),
});

const DELEGATED_HUMAN: Identity = Object.freeze({
  id: 'delegated-1',
  kind: 'delegated_human',
  displayName: 'Delegated Human',
  capabilities: Object.freeze(['canonical.write']),
  delegatorId: 'human-1',
  delegatedAt: ISO('2026-07-27T00:00:00.000Z'),
  delegatedUntil: ISO('2026-07-28T00:00:00.000Z'),
});

// --------------------------------------------------------------------
// Manifest fixture (matches the host's `website/cms-regions.json`)
// --------------------------------------------------------------------

const HOST_MANIFEST: CeraficaManifest = Object.freeze({
  version: 1,
  manifestSchema: 'cms-regions/v1',
  host: Object.freeze({
    repo: 'cerafica',
    deployMode: 'github_pages',
    canonicalProductPath: 'inventory/products.json',
    servedProductPath: 'website/data/products.json',
  }),
  regeneration: Object.freeze({
    mode: 'alias_symlink',
    source: 'inventory/products.json',
    target: '../../inventory/products.json',
    readonly: true,
  }),
  capabilities: Object.freeze({
    journal: Object.freeze({
      provider: 'cerafica-blog',
      mode: 'readonly',
      source: 'discovered',
      module: 'website/js/cerafica-blog.js',
    }),
    fields: Object.freeze({
      stripe: Object.freeze({ mode: 'readonly' }),
      payment: Object.freeze({ mode: 'readonly' }),
      price: Object.freeze({ mode: 'readonly' }),
      availability: Object.freeze({ mode: 'readonly' }),
      one_of_one: Object.freeze({ mode: 'readonly' }),
    }),
    coordinator: 'readonly',
    failClosed: true,
  }),
  localization: Object.freeze({
    altPolicy: Object.freeze({
      mode: 'peer-required',
      languages: Object.freeze(['en', 'es'] as const),
      hostCopyLanguage: 'en',
    }),
  }),
  anchors: Object.freeze({
    home: Object.freeze({
      heroText: 'data-cms-home-hero',
      featuredImage: Object.freeze({
        id: 'data-cms-home-featured-image',
        alt: 'data-cms-home-featured-image-alt',
      }),
      sections: Object.freeze({
        container: 'data-cms-home-sections',
        section: 'data-cms-home-section',
      }),
    }),
    shop: Object.freeze({
      productCollection: Object.freeze({
        container: 'data-cms-shop-product-collection',
      }),
    }),
  }),
});

// --------------------------------------------------------------------
// In-memory deploy client + rollback writer
// --------------------------------------------------------------------

interface DeployClientState {
  nextReceiptId: string;
  triggerCalls: GitHubPagesDeployReceipt[];
  statusOverrides: Map<string, GitHubPagesDeployReceipt>;
}

function makeDeployClient(): GitHubPagesDeployClient & { readonly state: DeployClientState } {
  const state: DeployClientState = {
    nextReceiptId: 'rcpt-0',
    triggerCalls: [],
    statusOverrides: new Map(),
  };
  return {
    state,
    async triggerDeploy(input) {
      const receiptId = `rcpt-${state.triggerCalls.length + 1}`;
      const receipt: GitHubPagesDeployReceipt = {
        deployReceiptId: receiptId,
        status: 'queued',
        startedAt: ISO('2026-07-27T12:00:00.000Z'),
        finishedAt: null,
        url: null,
        message: null,
      };
      state.triggerCalls.push(receipt);
      void input;
      return receipt;
    },
    async getDeployStatus(input) {
      const override = state.statusOverrides.get(input.deployReceiptId);
      if (override !== undefined) return override;
      return {
        deployReceiptId: input.deployReceiptId,
        status: 'queued',
        startedAt: ISO('2026-07-27T12:00:00.000Z'),
        finishedAt: null,
        url: null,
        message: null,
      };
    },
  };
}

interface RollbackWriterState {
  files: Map<string, Buffer>;
  hashes: Map<string, Sha256Hex>;
}

function makeRollbackWriter(): RollbackWriter & { readonly state: RollbackWriterState } {
  const state: RollbackWriterState = {
    files: new Map(),
    hashes: new Map(),
  };
  return {
    state,
    async read(path: string) {
      const bytes = state.files.get(path);
      if (bytes === undefined) {
        throw new Error(`no approval bytes at ${path}`);
      }
      return bytes;
    },
    async write(path: string, bytes: Buffer) {
      state.files.set(path, bytes);
      state.hashes.set(path, SHA(bytes.toString('hex').padStart(64, '0').slice(0, 64)));
    },
  };
}

// --------------------------------------------------------------------
// Filesystem helpers
// --------------------------------------------------------------------

interface RepoFixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly aliasPath: string;
  readonly canonicalPath: string;
  readonly modulePath: string;
  readonly canonicalBytes: Buffer;
}

function setupRepoFixture(opts: { alias?: 'good' | 'broken' | 'missing' | 'regular' | 'loop' | 'retargeted' | 'escaping' | 'unreadable' } = {}): RepoFixture {
  const root = mkdtempSync(join(tmpdir(), 'cerafica-'));
  const alias = opts.alias ?? 'good';

  mkdirSync(join(root, 'inventory'), { recursive: true });
  mkdirSync(join(root, 'website/data'), { recursive: true });
  mkdirSync(join(root, 'website/js'), { recursive: true });

  const canonicalBytes = Buffer.from('[]\n', 'utf8');
  if (alias !== 'missing') {
    writeFileSync(join(root, 'inventory/products.json'), canonicalBytes);
  }

  writeFileSync(
    join(root, 'website/cms-regions.json'),
    JSON.stringify(HOST_MANIFEST, null, 2),
    'utf8',
  );
  writeFileSync(join(root, 'website/js/cerafica-blog.js'), '// journal module\n', 'utf8');

  const aliasPath = join(root, 'website/data/products.json');
  const canonicalPath = join(root, 'inventory/products.json');

  switch (alias) {
    case 'good':
      symlinkSync(join('../../inventory/products.json'), aliasPath);
      break;
    case 'broken':
      // Symlink to a path that does not exist.
      symlinkSync(join('../does-not-exist.json'), aliasPath);
      break;
    case 'regular':
      // Plain file where the symlink should be.
      writeFileSync(aliasPath, '{"items":[]}\n', 'utf8');
      break;
    case 'loop': {
      // Direct self-loop: the alias points to itself.
      symlinkSync(join('products.json'), aliasPath);
      break;
    }
    case 'retargeted': {
      // Symlink that points to a different file than the declared target.
      writeFileSync(join(root, 'inventory/other.json'), '{"other":true}\n', 'utf8');
      symlinkSync(join('../../inventory/other.json'), aliasPath);
      break;
    }
    case 'escaping': {
      // Symlink that escapes the repository root. The target MUST
      // be an existing file outside the repo so the verifier walks
      // the chain to a real path and detects the escape via
      // realpath, not via a missing-entry miss-path.
      const escapeFile = join(tmpdir(), `cerafica-escape-${process.pid}-${Date.now()}.json`);
      writeFileSync(escapeFile, '{"escaped":true}\n', 'utf8');
      symlinkSync(escapeFile, aliasPath);
      break;
    }
    case 'unreadable':
      // A directory is stat-able and has a real path, but cannot be
      // consumed as canonical product bytes.
      rmSync(join(root, 'inventory/products.json'), { force: true });
      mkdirSync(join(root, 'inventory/products.json'));
      symlinkSync(join('../../inventory/products.json'), aliasPath);
      break;
    case 'missing':
      // No alias entry at all.
      break;
  }

  return {
    root,
    manifestPath: join(root, 'website/cms-regions.json'),
    aliasPath,
    canonicalPath,
    modulePath: join(root, 'website/js/cerafica-blog.js'),
    canonicalBytes,
  };
}

function buildOptions(repo: RepoFixture, overrides: Partial<CeraficaAdapterOptions> = {}): CeraficaAdapterOptions {
  const client = overrides.deployClient ?? makeDeployClient();
  const writer = overrides.rollbackWriter ?? makeRollbackWriter();
  return {
    repoRoot: repo.root,
    manifestPath: repo.manifestPath,
    deployClient: client,
    rollbackWriter: writer,
    ...overrides,
  };
}

// --------------------------------------------------------------------
// Manifest parsing
// --------------------------------------------------------------------

describe('parseManifest', () => {
  it('accepts the locked cms-regions/v1 shape', () => {
    const parsed = parseManifest(HOST_MANIFEST);
    expect(parsed.version).toBe(1);
    expect(parsed.manifestSchema).toBe('cms-regions/v1');
    expect(parsed.host.deployMode).toBe('github_pages');
    expect(parsed.regeneration.mode).toBe('alias_symlink');
    expect(parsed.localization.altPolicy.languages).toEqual(['en', 'es']);
  });

  it('refuses unknown top-level keys', () => {
    const tampered = { ...HOST_MANIFEST, surprise: true } as unknown as CeraficaManifest;
    expect(() => parseManifest(tampered)).toThrow(ManifestValidationError);
  });

  it('refuses unknown capabilities keys', () => {
    const tampered = {
      ...HOST_MANIFEST,
      capabilities: {
        ...HOST_MANIFEST.capabilities,
        fields: {
          ...HOST_MANIFEST.capabilities.fields,
          undeclared: { mode: 'readonly' },
        },
      },
    } as unknown as CeraficaManifest;
    expect(() => parseManifest(tampered)).toThrow(ManifestValidationError);
  });

  it('refuses a non-readonly commerce field mode', () => {
    const tampered = {
      ...HOST_MANIFEST,
      capabilities: {
        ...HOST_MANIFEST.capabilities,
        fields: {
          ...HOST_MANIFEST.capabilities.fields,
          price: { mode: 'free_edit' },
        },
      },
    } as unknown as CeraficaManifest;
    expect(() => parseManifest(tampered)).toThrow(ManifestValidationError);
  });

  it('refuses a non-readonly coordinator', () => {
    const tampered = {
      ...HOST_MANIFEST,
      capabilities: { ...HOST_MANIFEST.capabilities, coordinator: 'editable' },
    } as unknown as CeraficaManifest;
    expect(() => parseManifest(tampered)).toThrow(ManifestValidationError);
  });

  it('refuses anything other than ["en", "es"] languages', () => {
    const tampered = {
      ...HOST_MANIFEST,
      localization: {
        altPolicy: {
          mode: 'peer-required',
          languages: ['en', 'fr'] as unknown as ['en', 'es'],
          hostCopyLanguage: 'en',
        },
      },
    } as unknown as CeraficaManifest;
    expect(() => parseManifest(tampered)).toThrow(ManifestValidationError);
  });

  it('refuses manifestSchema other than cms-regions/v1', () => {
    const tampered = { ...HOST_MANIFEST, manifestSchema: 'cms-regions/v2' } as unknown as CeraficaManifest;
    expect(() => parseManifest(tampered)).toThrow(ManifestValidationError);
  });

  it('refuses deployMode other than github_pages', () => {
    const tampered = { ...HOST_MANIFEST, host: { ...HOST_MANIFEST.host, deployMode: 'netlify' } } as unknown as CeraficaManifest;
    expect(() => parseManifest(tampered)).toThrow(ManifestValidationError);
  });

  it('refuses manifest with a literal false failClosed', () => {
    const tampered = {
      ...HOST_MANIFEST,
      capabilities: { ...HOST_MANIFEST.capabilities, failClosed: false },
    } as unknown as CeraficaManifest;
    expect(() => parseManifest(tampered)).toThrow(ManifestValidationError);
  });

  it('reads the manifest from disk via loadManifest', async () => {
    const repo = setupRepoFixture();
    const manifest = await loadManifest(repo.manifestPath);
    expect(manifest.host.canonicalProductPath).toBe('inventory/products.json');
    expect(manifest.regeneration.target).toBe('../../inventory/products.json');
  });

  it('wraps a missing manifest filesystem error as E_BINDING_NOT_FOUND', async () => {
    await expect(loadManifest('/nonexistent/cms-regions.json')).rejects.toBeInstanceOf(
      AdapterContractError,
    );
  });

  it('manifestToActivationContract is closed and admits the locked shape', () => {
    const contract = manifestToActivationContract(HOST_MANIFEST);
    expect(contract.mode).toBe('alias_symlink');
    expect(contract.aliasPath).toBe('website/data/products.json');
    expect(contract.canonicalRepoPath).toBe('inventory/products.json');
    expect(contract.aliasTargets).toEqual(['../../inventory/products.json']);
  });
});

// --------------------------------------------------------------------
// Field capabilities (commerce gating)
// --------------------------------------------------------------------

describe('commerce field gating', () => {
  it('every commerce field is coordinator-gated and read-only', () => {
    for (const field of ['stripe', 'payment', 'price', 'availability', 'one_of_one'] as const) {
      expect(isFieldReadOnly(HOST_MANIFEST, field)).toBe(true);
    }
  });

  it('fieldCapabilities returns coordinator_gated for every commerce field', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const snapshot = await adapter.fieldCapabilities();
    expect(snapshot.fields.length).toBe(5);
    for (const entry of snapshot.fields) {
      expect(entry.capability).toBe('coordinator_gated');
    }
    expect(snapshot.fields.map((f) => f.field).sort()).toEqual(
      ['availability', 'one_of_one', 'payment', 'price', 'stripe'],
    );
  });

  it('parametric invariant: every advertised label maps to enforced real-host key(s), every mapped key mutation is rejected, and no enforcement key exists outside the mapping', async () => {
    // The mapping and enforced-keys list are exposed via __internal__
    // for this single test; production code MUST import via the SDK
    // only. The test treats these values as the authoritative slice
    // of the host contract and refuses to enumerate the labels or
    // host keys anywhere else.
    const mapping = __internal__.commerceFieldHostKeys;
    const enforced = __internal__.enforcedHostKeys;

    // 1. The advertised label set (manifest `capabilities.fields`)
    // MUST equal the keys of the mapping exactly, with no extras
    // and no missing entries.
    const advertisedLabels = Object.keys(mapping).sort();
    const manifestLabels = Object.keys(HOST_MANIFEST.capabilities.fields).sort();
    expect(advertisedLabels).toEqual(manifestLabels);
    expect(new Set(advertisedLabels).size).toBe(advertisedLabels.length);

    // 2. No enforcement key exists outside the mapping. The
    // enforced host-key set MUST be exactly the deduplicated union
    // of every mapped tuple's keys; the mapping is the sole
    // source of those keys.
    const expectedEnforced: string[] = [];
    const seen = new Set<string>();
    for (const label of advertisedLabels) {
      for (const key of mapping[label as keyof typeof mapping]) {
        if (seen.has(key)) continue;
        seen.add(key);
        expectedEnforced.push(key);
      }
    }
    expect([...enforced].sort()).toEqual(expectedEnforced.sort());
    expect(new Set(enforced).size).toBe(enforced.length);

    // 3. Every advertised label resolves to at least one host key.
    for (const label of advertisedLabels) {
      const mapped = mapping[label as keyof typeof mapping];
      expect(mapped.length).toBeGreaterThan(0);
    }

    // 4. Drive every (label, hostKey) pair through the adapter and
    // confirm the gating refuses the mutation with the exact
    // host key in `changedFields`. Each iteration builds its own
    // fixture so the only delta is the single host key under test.
    for (const label of advertisedLabels) {
      const hostKeys = mapping[label as keyof typeof mapping];
      for (const hostKey of hostKeys) {
        const repo = setupRepoFixture();
        try {
          const seed = {
            id: `seed-${label}-${hostKey}`,
            price: 100,
            available: true,
            coming_soon: false,
            one_of_one: true,
            stripe_payment_link: 'https://stripe.example.com/seed',
            description: 'seed',
            image: 'seed.png',
          };
          writeFileSync(repo.canonicalPath, JSON.stringify([seed]));

          const adapter = await createCeraficaAdapter(buildOptions(repo));
          const binding = buildBindingFromAdapter(adapter);
          await adapter.activate({ binding });

          const mutated: Record<string, unknown> = { ...seed };
          const current = seed[hostKey as keyof typeof seed];
          if (typeof current === 'boolean') {
            mutated[hostKey] = !current;
          } else if (typeof current === 'number') {
            mutated[hostKey] = current + 1;
          } else {
            mutated[hostKey] = `${String(current)}-mut`;
          }

          await expect(
            adapter.apply(
              buildCanonicalWrite('inventory/products.json', [mutated]),
            ),
          ).rejects.toMatchObject({
            code: 'E_DERIVED_WRITE_FORBIDDEN',
            details: {
              commerceGating: 'field',
              changedFields: [{ id: seed.id, field: hostKey }],
            },
          });
        } finally {
          rmSync(repo.root, { recursive: true, force: true });
        }
      }
    }

    // 5. Safe descriptive/image fields remain writable: a write
    // that leaves every enforced host key untouched MUST succeed
    // even though the product shape is otherwise identical.
    const repo = setupRepoFixture();
    try {
      const seed = {
        id: 'safe-update',
        price: 100,
        available: true,
        coming_soon: false,
        one_of_one: true,
        stripe_payment_link: 'https://stripe.example.com/safe',
        description: 'old',
        image: 'old.png',
      };
      writeFileSync(repo.canonicalPath, JSON.stringify([seed]));
      const adapter = await createCeraficaAdapter(buildOptions(repo));
      const binding = buildBindingFromAdapter(adapter);
      await adapter.activate({ binding });
      const receipt = await adapter.apply(
        buildCanonicalWrite('inventory/products.json', [
          { ...seed, description: 'new', image: 'new.png' },
        ]),
      );
      expect(receipt.canonicalRepoPath).toBe('inventory/products.json');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------
// Activation / reconciliation
// --------------------------------------------------------------------

describe('activate', () => {
  it('reports issues for a binding whose regeneration mode is not alias_symlink', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const invalidBinding = {
      ...buildBindingFromAdapter(adapter),
      regenerationContract: {
        mode: 'DERIVED_FROM_CANONICAL' as unknown as 'alias_symlink',
        aliasPath: 'website/data/products.json',
        aliasTargets: ['../../inventory/products.json'] as const,
      },
    };
    const result = await adapter.activate({ binding: invalidBinding });
    expect(result.ok).toBe(false);
    expect(result.refusalReasons.join(' ')).toMatch(/alias_symlink|regeneration mode/);
  });

  it('activates when the alias resolves correctly', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const result = await adapter.activate({ binding });
    expect(result.ok).toBe(true);
    expect(result.refusalReasons).toEqual([]);
    expect(result.enabledCapabilities).toContain('canonical.write');
    expect(result.contract.canonicalRepoPath).toBe('inventory/products.json');
    expect(result.contract.aliasPath).toBe('website/data/products.json');
  });

  it('refuses when the alias is missing (E_ALIAS_MISSING via mapSymlinkRefusalToAdapterCode)', async () => {
    const repo = setupRepoFixture({ alias: 'missing' });
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const result = await adapter.activate({ binding });
    expect(result.ok).toBe(false);
    expect(result.refusalReasons.length).toBe(1);
    expect(result.refusalReasons[0]).toMatch(/^E_ALIAS_MISSING:/);
  });

  it('refuses when the alias is a regular file (E_ALIAS_NOT_SYMLINK)', async () => {
    const repo = setupRepoFixture({ alias: 'regular' });
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const result = await adapter.activate({ binding });
    expect(result.ok).toBe(false);
    expect(result.refusalReasons.length).toBe(1);
    expect(result.refusalReasons[0]).toMatch(/^E_ALIAS_NOT_SYMLINK:/);
    expect(result.refusalReasons[0]).toMatch(/regular file|not a symlink/);
  });

  it('refuses a broken alias (E_ALIAS_BROKEN)', async () => {
    const repo = setupRepoFixture({ alias: 'broken' });
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const result = await adapter.activate({ binding });
    expect(result.ok).toBe(false);
    expect(result.refusalReasons.length).toBe(1);
    expect(result.refusalReasons[0]).toMatch(/^E_ALIAS_BROKEN:/);
  });

  it('refuses a retargeted alias (E_ALIAS_RETARGETED)', async () => {
    const repo = setupRepoFixture({ alias: 'retargeted' });
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const result = await adapter.activate({ binding });
    expect(result.ok).toBe(false);
    expect(result.refusalReasons.length).toBe(1);
    expect(result.refusalReasons[0]).toMatch(/^E_ALIAS_RETARGETED:/);
    expect(result.refusalReasons[0]).toMatch(/retarget|expected|resolves/);
  });

  it('refuses a self-referential alias (E_ALIAS_LOOPED)', async () => {
    const repo = setupRepoFixture({ alias: 'loop' });
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const result = await adapter.activate({ binding });
    expect(result.ok).toBe(false);
    expect(result.refusalReasons.length).toBe(1);
    expect(result.refusalReasons[0]).toMatch(/^E_ALIAS_LOOPED:/);
    expect(result.refusalReasons[0]).toMatch(/loop|hops/);
  });

  it('refuses an alias that escapes the repository (E_ALIAS_ESCAPING)', async () => {
    const repo = setupRepoFixture({ alias: 'escaping' });
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const result = await adapter.activate({ binding });
    expect(result.ok).toBe(false);
    expect(result.refusalReasons.length).toBe(1);
    expect(result.refusalReasons[0]).toMatch(/^E_ALIAS_ESCAPING:/);
    expect(result.refusalReasons[0]).toMatch(/escape|not inside/);
  });

  it('refuses when the canonical cannot be read (E_CANONICAL_MISSING)', async () => {
    const repo = setupRepoFixture({ alias: 'unreadable' });
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const result = await adapter.activate({ binding });
    expect(result.ok).toBe(false);
    expect(result.refusalReasons.length).toBe(1);
    expect(result.refusalReasons[0]).toMatch(/^E_CANONICAL_MISSING:/);
    expect(result.refusalReasons[0]).toMatch(/unreadable|missing/i);
  });

  it('reconcile returns in_sync=true after the canonical hash is loaded', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const activation = await adapter.activate({ binding });
    expect(activation.ok).toBe(true);
    // After activation the canonical hash is known; the binding
    // declared a zero hash, so an in-sync observation requires the
    // adapter to align the declared hash. Instead, verify reconcile
    // runs without error and reports drift (or in_sync) but never
    // writes.
    const candidate = adapter as unknown as { state: { binding: { canonicalSource: { contentHash: Sha256Hex } } } };
    const crypto = await import('node:crypto');
    candidate.state.binding.canonicalSource.contentHash = SHA(
      crypto.createHash('sha256').update(repo.canonicalBytes).digest('hex'),
    );
    const receipt = await adapter.reconcile({ binding });
    expect(receipt.inSync).toBe(true);
    expect(receipt.drift).toHaveLength(0);
  });

  it('reconcile reports drift when the canonical hash differs from declared', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const receipt = await adapter.reconcile({ binding });
    expect(receipt.inSync).toBe(false);
    expect(receipt.drift.length).toBe(1);
    expect(receipt.drift[0]?.repoPath).toBe('inventory/products.json');
  });
});

// --------------------------------------------------------------------
// Apply (canonical-only)
// --------------------------------------------------------------------

describe('apply', () => {
  it('writes the canonical source and returns a receipt', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', []);
    const receipt = await adapter.apply(write);
    expect(receipt.canonicalRepoPath).toBe('inventory/products.json');
    expect(receipt.actor.id).toBe(HUMAN.id);
    expect(receipt.contract.aliasPath).toBe('website/data/products.json');
  });

  it('updates the Cerafica product through the canonical source while preserving the served alias', async () => {
    const repo = setupRepoFixture();
    try {
      const original = [{
        id: 'moon-vessel',
        price: 24000,
        available: true,
        coming_soon: false,
        one_of_one: true,
        stripe_payment_link: 'https://stripe.example.com/moon-vessel',
        description: 'Moon vessel',
        image: 'moon-vessel.jpg',
      }];
      writeFileSync(repo.canonicalPath, JSON.stringify(original));

      const adapter = await createCeraficaAdapter(buildOptions(repo));
      const binding = buildBindingFromAdapter(adapter);
      await expect(adapter.activate({ binding })).resolves.toMatchObject({ ok: true });

      const updated = [{
        ...original[0],
        description: 'Moon vessel — Summer 2026',
        image: 'moon-vessel-summer.jpg',
      }];
      const receipt = await adapter.apply(buildCanonicalWrite('inventory/products.json', updated));

      expect(receipt.canonicalRepoPath).toBe('inventory/products.json');
      expect(readlinkSync(repo.aliasPath)).toBe('../../inventory/products.json');
      expect(JSON.parse(readFileSync(repo.canonicalPath, 'utf8'))).toEqual(updated);
      expect(readFileSync(repo.aliasPath, 'utf8')).toBe(readFileSync(repo.canonicalPath, 'utf8'));
      await expect(adapter.journalWrite()).rejects.toBeInstanceOf(JournalWriteUnsupportedError);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('refuses legacy object-wrapped products instead of rewriting the host shape', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', {
      items: [],
      version: 1,
    });
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_BINDING_NOT_FOUND',
    });
  });

  it('refuses alias writes with E_ALIAS_WRITE_FORBIDDEN', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('website/data/products.json', { leaked: true });
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_ALIAS_WRITE_FORBIDDEN',
    });
  });

  it('refuses any derived artifact path with E_DERIVED_WRITE_FORBIDDEN', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/preview.json', { leaked: true });
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_DERIVED_WRITE_FORBIDDEN',
    });
  });

  it('refuses service identities with E_AUTHORITY_FORBIDDEN', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', { x: 1 }, SERVICE);
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_AUTHORITY_FORBIDDEN',
    });
  });

  it('refuses MCP-capable agent identities with E_AUTHORITY_FORBIDDEN', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', { x: 1 }, MCP_AGENT);
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_AUTHORITY_FORBIDDEN',
    });
  });

  it('accepts delegated-human identities (they are not services)', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite(
      'inventory/products.json',
      [],
      DELEGATED_HUMAN,
    );
    const receipt = await adapter.apply(write);
    expect(receipt.actor.kind).toBe('delegated_human');
  });

  it('refuses environment mismatch with E_ENVIRONMENT_MISMATCH', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', { x: 1 });
    write.environment = 'production';
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_ENVIRONMENT_MISMATCH',
    });
  });

  it('refuses a write whose bindingId does not match', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', { x: 1 });
    write.bindingId = 'rb-other-binding';
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_BINDING_NOT_FOUND',
    });
  });

  it('refuses absolute-path writes', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('/etc/passwd', { x: 1 });
    await expect(adapter.apply(write)).rejects.toBeInstanceOf(AdapterContractError);
  });

  it('refuses paths that escape the repository via ..', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('../escape.json', { x: 1 });
    await expect(adapter.apply(write)).rejects.toBeInstanceOf(AdapterContractError);
  });

  it('accepts a content-only product update (safe descriptive/image fields)', async () => {
    const repo = setupRepoFixture();
    writeFileSync(
    repo.canonicalPath,
    JSON.stringify([
      {
        id: 'p-1',
        price: 100,
        available: true,
        coming_soon: false,
        one_of_one: true,
        stripe_payment_link: 'https://stripe.example.com/p-1',
        description: 'old',
        image: 'old.png',
      },
    ]),
  );
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', [
      {
        id: 'p-1',
        price: 100,
        available: true,
        coming_soon: false,
        one_of_one: true,
        stripe_payment_link: 'https://stripe.example.com/p-1',
        description: 'new',
        image: 'new.png',
      },
    ]);
    const receipt = await adapter.apply(write);
    expect(receipt.canonicalRepoPath).toBe('inventory/products.json');
  });

  it('refuses a price change with E_DERIVED_WRITE_FORBIDDEN (commerce-gated field)', async () => {
    const repo = setupRepoFixture();
    writeFileSync(
    repo.canonicalPath,
    JSON.stringify([{ id: 'p-1', price: 100, available: true, description: 'd' }]),
  );
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', [
      { id: 'p-1', price: 200, available: true, description: 'd' },
    ]);
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_DERIVED_WRITE_FORBIDDEN',
      details: { commerceGating: 'field', changedFields: [{ id: 'p-1', field: 'price' }] },
    });
  });

  it('refuses an availability change', async () => {
    const repo = setupRepoFixture();
    writeFileSync(
    repo.canonicalPath,
    JSON.stringify([{ id: 'p-1', price: 100, available: true, description: 'd' }]),
  );
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', [{ id: 'p-1', price: 100, available: false, description: 'd' }]);
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_DERIVED_WRITE_FORBIDDEN',
      details: { commerceGating: 'field', changedFields: [{ id: 'p-1', field: 'available' }] },
    });
  });

  it('refuses a coming_soon change', async () => {
    const repo = setupRepoFixture();
    writeFileSync(
    repo.canonicalPath,
    JSON.stringify([{ id: 'p-1', price: 100, coming_soon: false, description: 'd' }]),
  );
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', [{ id: 'p-1', price: 100, coming_soon: true, description: 'd' }]);
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_DERIVED_WRITE_FORBIDDEN',
      details: { commerceGating: 'field', changedFields: [{ id: 'p-1', field: 'coming_soon' }] },
    });
  });

  it('refuses a one_of_one change', async () => {
    const repo = setupRepoFixture();
    writeFileSync(
    repo.canonicalPath,
    JSON.stringify([{ id: 'p-1', price: 100, one_of_one: true, description: 'd' }]),
  );
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', [{ id: 'p-1', price: 100, one_of_one: false, description: 'd' }]);
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_DERIVED_WRITE_FORBIDDEN',
      details: { commerceGating: 'field', changedFields: [{ id: 'p-1', field: 'one_of_one' }] },
    });
  });

  it('refuses a stripe_payment_link change', async () => {
    const repo = setupRepoFixture();
    writeFileSync(
    repo.canonicalPath,
    JSON.stringify([{ id: 'p-1', price: 100, stripe_payment_link: 'https://stripe.example.com/a', description: 'd' }]),
  );
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', [{ id: 'p-1', price: 100, stripe_payment_link: 'https://stripe.example.com/b', description: 'd' }]);
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_DERIVED_WRITE_FORBIDDEN',
      details: {
        commerceGating: 'field',
        changedFields: [{ id: 'p-1', field: 'stripe_payment_link' }],
      },
    });
  });

  it('refuses a product add (new id)', async () => {
    const repo = setupRepoFixture();
    writeFileSync(
    repo.canonicalPath,
    JSON.stringify([{ id: 'p-1', price: 100, description: 'd' }]),
  );
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', [
        { id: 'p-1', price: 100, description: 'd' },
        { id: 'p-2', price: 50, description: 'd2' },
      ]);
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_DERIVED_WRITE_FORBIDDEN',
      details: { commerceGating: 'add_remove', added: ['p-2'], removed: [] },
    });
  });

  it('refuses a product remove (missing id)', async () => {
    const repo = setupRepoFixture();
    writeFileSync(
    repo.canonicalPath,
    JSON.stringify([
        { id: 'p-1', price: 100, description: 'd' },
        { id: 'p-2', price: 50, description: 'd2' },
      ]),
  );
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    await adapter.activate({ binding });
    const write = buildCanonicalWrite('inventory/products.json', [{ id: 'p-1', price: 100, description: 'd' }]);
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_DERIVED_WRITE_FORBIDDEN',
      details: { commerceGating: 'add_remove', added: [], removed: ['p-2'] },
    });
  });
});

// --------------------------------------------------------------------
// Journal (read-only discovery, journal writes unsupported)
// --------------------------------------------------------------------

describe('journal', () => {
  it('discoverJournal returns the discovered module path with readonly: true', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const journal = await adapter.discoverJournal();
    expect(journal.provider).toBe('cerafica-blog');
    expect(journal.readonly).toBe(true);
    expect(journal.moduleRelPath).toBe('website/js/cerafica-blog.js');
    expect(journal.moduleAbsPath).toBe(repo.modulePath);
  });

  it('journalWrite rejects with JournalWriteUnsupportedError', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const promise = adapter.journalWrite();
    await expect(promise).rejects.toBeInstanceOf(JournalWriteUnsupportedError);
  });
});

// --------------------------------------------------------------------
// GitHub Pages deploy capability
// --------------------------------------------------------------------

describe('GitHub Pages deploy capability', () => {
  let repo: RepoFixture;
  beforeEach(() => {
    repo = setupRepoFixture();
  });
  afterEach(() => {
    rmSync(repo.root, { recursive: true, force: true });
  });

  it('trigger returns canonical_written and stashes the receipt', async () => {
    const client = makeDeployClient();
    const writer = makeRollbackWriter();
    const capability = createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
    const state = await capability.trigger({
      repo: 'cerafica',
      environment: 'staging',
      commitSha: 'abc123',
      actor: HUMAN,
    });
    expect(state.kind).toBe('canonical_written');
    expect(client.state.triggerCalls.length).toBe(1);
  });

  it('reconcile returns awaiting_receipt before the client marks the deploy terminal', async () => {
    const client = makeDeployClient();
    const writer = makeRollbackWriter();
    const capability = createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
    await capability.trigger({
      repo: 'cerafica',
      environment: 'staging',
      commitSha: 'abc123',
      actor: HUMAN,
    });
    const state = await capability.reconcile();
    // The default `getDeployStatus` returns queued (a non-terminal
     // status). The reconciliation MUST therefore surface
     // `awaiting_receipt` deterministically. The trigger is
     // synchronous, so by the time reconcile runs the pending
     // receipt is already known.
    expect(state.kind).toBe('awaiting_receipt');
  });

  it('reconcile returns succeeded once the client reports a terminal receipt', async () => {
    const client = makeDeployClient();
    const writer = makeRollbackWriter();
    const capability = createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
    await capability.trigger({
      repo: 'cerafica',
      environment: 'staging',
      commitSha: 'abc123',
      actor: HUMAN,
    });
    const receiptId = client.state.triggerCalls[0]?.deployReceiptId ?? 'rcpt-1';
    client.state.statusOverrides.set(receiptId, {
      deployReceiptId: receiptId,
      status: 'succeeded',
      startedAt: ISO('2026-07-27T12:00:00.000Z'),
      finishedAt: ISO('2026-07-27T12:01:00.000Z'),
      url: 'https://cerafica.example.com/',
      message: null,
    });
    const state = await capability.reconcile();
    expect(state.kind).toBe('succeeded');
    if (state.kind === 'succeeded') {
      expect(state.url).toBe('https://cerafica.example.com/');
    }
  });

  it('reconcile returns failed when the client reports a failed receipt', async () => {
    const client = makeDeployClient();
    const writer = makeRollbackWriter();
    const capability = createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
    await capability.trigger({
      repo: 'cerafica',
      environment: 'staging',
      commitSha: 'abc123',
      actor: HUMAN,
    });
    const receiptId = client.state.triggerCalls[0]?.deployReceiptId ?? 'rcpt-1';
    client.state.statusOverrides.set(receiptId, {
      deployReceiptId: receiptId,
      status: 'failed',
      startedAt: ISO('2026-07-27T12:00:00.000Z'),
      finishedAt: ISO('2026-07-27T12:01:00.000Z'),
      url: null,
      message: 'boom',
    });
    const state = await capability.reconcile();
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') {
      expect(state.message).toBe('boom');
    }
  });

  it('fails closed when a successful receipt lacks terminal metadata', async () => {
    const client = makeDeployClient();
    const capability = createGitHubPagesDeployCapability({
      client,
      rollbackWriter: makeRollbackWriter(),
    });
    await capability.trigger({
      repo: 'cerafica',
      environment: 'staging',
      commitSha: 'abc123',
      actor: HUMAN,
    });
    const receiptId = client.state.triggerCalls[0]?.deployReceiptId ?? 'rcpt-1';
    client.state.statusOverrides.set(receiptId, {
      deployReceiptId: receiptId,
      status: 'succeeded',
      startedAt: ISO('2026-07-27T12:00:00.000Z'),
      finishedAt: null,
      url: null,
      message: null,
    });
    await expect(capability.reconcile()).rejects.toMatchObject({
      code: 'E_AMBIGUOUS_BINDING',
    });
  });

  it('fails closed when a failed receipt lacks terminal metadata', async () => {
    const client = makeDeployClient();
    const capability = createGitHubPagesDeployCapability({
      client,
      rollbackWriter: makeRollbackWriter(),
    });
    await capability.trigger({
      repo: 'cerafica',
      environment: 'staging',
      commitSha: 'abc123',
      actor: HUMAN,
    });
    const receiptId = client.state.triggerCalls[0]?.deployReceiptId ?? 'rcpt-1';
    client.state.statusOverrides.set(receiptId, {
      deployReceiptId: receiptId,
      status: 'failed',
      startedAt: ISO('2026-07-27T12:00:00.000Z'),
      finishedAt: null,
      url: null,
      message: null,
    });
    await expect(capability.reconcile()).rejects.toMatchObject({
      code: 'E_AMBIGUOUS_BINDING',
    });
  });

  it('rollback writes the approval bytes and returns canonical_written', async () => {
    const client = makeDeployClient();
    const writer = makeRollbackWriter();
    const capability = createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
    const approvalBytes = Buffer.from('{"version":1,"items":[]}\n', 'utf8');
    const crypto = await import('node:crypto');
    const approvalHash = SHA(crypto.createHash('sha256').update(approvalBytes).digest('hex'));
    const targetPath = join(repo.root, 'inventory/products.json');
    writer.state.files.set(join(repo.root, 'approval.bin'), approvalBytes);
    const state = await capability.rollback({
      approvalBytesPath: join(repo.root, 'approval.bin'),
      canonicalPath: targetPath,
      approvalHash,
    });
    expect(state.kind).toBe('canonical_written');
    const written = writer.state.files.get(targetPath);
    expect(written?.toString('utf8')).toBe('{"version":1,"items":[]}\n');
  });

  it('rollback refuses when the approval hash does not match', async () => {
    const client = makeDeployClient();
    const writer = makeRollbackWriter();
    const capability = createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
    const approvalBytes = Buffer.from('{"version":1,"items":[]}\n', 'utf8');
    writer.state.files.set(join(repo.root, 'approval.bin'), approvalBytes);
    await expect(
      capability.rollback({
        approvalBytesPath: join(repo.root, 'approval.bin'),
        canonicalPath: join(repo.root, 'inventory/products.json'),
        approvalHash: SHA('0'.repeat(64)),
      }),
    ).rejects.toBeInstanceOf(RollbackApprovalHashMismatchError);
  });

  it('trigger fails closed when the deploy client rejects', async () => {
    const client: GitHubPagesDeployClient = {
      async triggerDeploy() {
        throw new Error('upstream unavailable');
      },
      async getDeployStatus() {
        throw new Error('not used');
      },
    };
    const writer = makeRollbackWriter();
    const capability = createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
    await expect(
      capability.trigger({
        repo: 'cerafica',
        environment: 'staging',
        commitSha: 'abc123',
        actor: HUMAN,
      }),
    ).rejects.toBeInstanceOf(AdapterContractError);

    const state = await capability.reconcile();
    expect(state.kind).toBe('canonical_written');
  });

  it('deployCapabilitySnapshot advertises cache.invalidate enabled', async () => {
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const snapshot = adapter.deployCapabilitySnapshot();
    expect(snapshot.kind).toBe('cache.invalidate');
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.adapterId).toBe(CERAFICA_ADAPTER_ID);
  });

  // The four tests below cover the G002 deployment-coverage fixes:
  //   - trigger must surface an immediately terminal receipt directly
  //     (no `canonical_written` hiding a `failed`/`cancelled`/malformed
  //     outcome);
  //   - rollback must be repository-confined when a repoRoot is wired;
  //   - rollback must preserve commerce gating (a rollback cannot be a
  //     bypass hatch);
  //   - reconcile MUST NOT report stale pre-rollback terminal state
  //     after a successful rollback.

  it('trigger returns the terminal state directly when the client reports an immediately-failed receipt', async () => {
    const client: GitHubPagesDeployClient & {
      readonly state: DeployClientState;
    } = {
      state: {
        nextReceiptId: 'rcpt-immediate-fail',
        triggerCalls: [],
        statusOverrides: new Map(),
      },
      async triggerDeploy() {
        return {
          deployReceiptId: 'rcpt-immediate-fail',
          status: 'failed',
          startedAt: ISO('2026-07-27T12:00:00.000Z'),
          finishedAt: ISO('2026-07-27T12:00:00.500Z'),
          url: null,
          message: 'client-side fail-fast',
        };
      },
      async getDeployStatus(input) {
        const override = client.state.statusOverrides.get(input.deployReceiptId);
        if (override !== undefined) return override;
        return {
          deployReceiptId: input.deployReceiptId,
          status: 'queued',
          startedAt: ISO('2026-07-27T12:00:00.000Z'),
          finishedAt: null,
          url: null,
          message: null,
        };
      },
    };
    const writer = makeRollbackWriter();
    const capability = createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
    const state = await capability.trigger({
      repo: 'cerafica',
      environment: 'staging',
      commitSha: 'abc123',
      actor: HUMAN,
    });
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') {
      expect(state.message).toBe('client-side fail-fast');
      expect(state.deployReceiptId).toBe('rcpt-immediate-fail');
    }
  });

  it('trigger throws (and leaves no stale state) when the trigger receipt is malformed', async () => {
    const client: GitHubPagesDeployClient & {
      readonly state: DeployClientState;
    } = {
      state: {
        nextReceiptId: 'rcpt-malformed',
        triggerCalls: [],
        statusOverrides: new Map(),
      },
      async triggerDeploy() {
        return {
          deployReceiptId: 'rcpt-malformed',
          status: 'succeeded',
          // Missing finishedAt and url: malformed terminal receipt.
          startedAt: ISO('2026-07-27T12:00:00.000Z'),
          finishedAt: null,
          url: null,
          message: null,
        };
      },
      async getDeployStatus(input) {
        return {
          deployReceiptId: input.deployReceiptId,
          status: 'queued',
          startedAt: ISO('2026-07-27T12:00:00.000Z'),
          finishedAt: null,
          url: null,
          message: null,
        };
      },
    };
    const writer = makeRollbackWriter();
    const capability = createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
    await expect(
      capability.trigger({
        repo: 'cerafica',
        environment: 'staging',
        commitSha: 'abc123',
        actor: HUMAN,
      }),
    ).rejects.toMatchObject({ code: 'E_AMBIGUOUS_BINDING' });
    // The trigger threw; reconcile MUST NOT resurrect a malformed
    // receipt — the absence of `pending` means reconcile reports
    // canonical_written, not stale terminal state.
    const state = await capability.reconcile();
    expect(state.kind).toBe('canonical_written');
  });

  it('rollback refuses a canonicalPath that escapes the configured repoRoot', async () => {
    const repo = setupRepoFixture();
    try {
      const approvalBytes = Buffer.from(
        JSON.stringify([
          {
            id: 'p-1',
            price: 100,
            available: true,
            coming_soon: false,
            one_of_one: true,
            stripe_payment_link: 'https://stripe.example.com/p-1',
            description: 'safe',
            image: 'safe.png',
          },
        ]),
        'utf8',
      );
      const crypto = await import('node:crypto');
      const approvalHash = SHA(crypto.createHash('sha256').update(approvalBytes).digest('hex'));
      const writer = makeRollbackWriter();
      writer.state.files.set(join(repo.root, 'approval.bin'), approvalBytes);
      const client = makeDeployClient();
      const capability = createGitHubPagesDeployCapability({
        client,
        rollbackWriter: writer,
        rollbackSafety: { repoRoot: repo.root },
      });
      const escapeTarget = join(repo.root, '..', 'outside-target.json');
      await expect(
        capability.rollback({
          approvalBytesPath: join(repo.root, 'approval.bin'),
          canonicalPath: escapeTarget,
          approvalHash,
        }),
      ).rejects.toMatchObject({ code: 'E_DERIVED_WRITE_FORBIDDEN' });
      // The writer MUST NOT have been touched: the confinement gate
      // runs before commit.
      expect(writer.state.files.get(escapeTarget)).toBeUndefined();
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('rollback refuses non-commerce-safe approval bytes (preserves coordinator-gated authority)', async () => {
    const repo = setupRepoFixture();
    try {
      // Existing products carry a known price; the rollback payload
      // changes a coordinator-gated field, which the safety hook
      // must refuse.
      writeFileSync(
        repo.canonicalPath,
        JSON.stringify([
          {
            id: 'p-1',
            price: 100,
            available: true,
            coming_soon: false,
            one_of_one: true,
            stripe_payment_link: 'https://stripe.example.com/p-1',
            description: 'old',
            image: 'old.png',
          },
        ]),
      );
      // Rollback payload tries to change `price` from 100 -> 200.
      const approvalBytes = Buffer.from(
        JSON.stringify([
          {
            id: 'p-1',
            price: 200,
            available: true,
            coming_soon: false,
            one_of_one: true,
            stripe_payment_link: 'https://stripe.example.com/p-1',
            description: 'rollback',
            image: 'rollback.png',
          },
        ]),
        'utf8',
      );
      const crypto = await import('node:crypto');
      const approvalHash = SHA(crypto.createHash('sha256').update(approvalBytes).digest('hex'));
      const writer = makeRollbackWriter();
      writer.state.files.set(join(repo.root, 'approval.bin'), approvalBytes);
      const client = makeDeployClient();
      const safetyCalls: Array<{ bytes: Buffer; canonicalAbs: string }> = [];
      const capability = createGitHubPagesDeployCapability({
        client,
        rollbackWriter: writer,
        rollbackSafety: {
          repoRoot: repo.root,
          safetyCheck: async (bytes, canonicalAbs) => {
            safetyCalls.push({ bytes, canonicalAbs });
            await __internal__.enforceCommerceFieldGating({
              repoRoot: repo.root,
              canonicalRelPath: 'inventory/products.json',
              proposedBytes: bytes,
            });
          },
        },
      });
      await expect(
        capability.rollback({
          approvalBytesPath: join(repo.root, 'approval.bin'),
          canonicalPath: repo.canonicalPath,
          approvalHash,
        }),
      ).rejects.toMatchObject({ code: 'E_DERIVED_WRITE_FORBIDDEN' });
      expect(safetyCalls.length).toBe(1);
      // The writer MUST NOT have been touched: the safety hook is
      // the gate that runs before commit.
      expect(writer.state.files.get(repo.canonicalPath)).toBeUndefined();
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('post-rollback reconcile reports canonical_written, not stale pre-rollback terminal state', async () => {
    const client = makeDeployClient();
    const writer = makeRollbackWriter();
    const capability = createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
    // First, drive a terminal receipt into state so reconcile would
    // otherwise return stale `succeeded` state.
    await capability.trigger({
      repo: 'cerafica',
      environment: 'staging',
      commitSha: 'abc123',
      actor: HUMAN,
    });
    const receiptId = client.state.triggerCalls[0]?.deployReceiptId ?? 'rcpt-1';
    client.state.statusOverrides.set(receiptId, {
      deployReceiptId: receiptId,
      status: 'succeeded',
      startedAt: ISO('2026-07-27T12:00:00.000Z'),
      finishedAt: ISO('2026-07-27T12:01:00.000Z'),
      url: 'https://cerafica.example.com/',
      message: null,
    });
    const before = await capability.reconcile();
    expect(before.kind).toBe('succeeded');
    // Now roll back to a known approved snapshot. No rollbackSafety
    // is wired: the canonical path is supplied as the absolute
    // inventory/products.json inside the test repo, which the
    // rollback writer accepts unconditionally under the legacy
    // (non-confined) contract. The post-rollback invariant is the
    // focus: the success state from the prior deploy MUST NOT
    // survive.
    const approvalBytes = Buffer.from('[]\n', 'utf8');
    const crypto = await import('node:crypto');
    const approvalHash = SHA(crypto.createHash('sha256').update(approvalBytes).digest('hex'));
    writer.state.files.set(join(repo.root, 'approval.bin'), approvalBytes);
    await capability.rollback({
      approvalBytesPath: join(repo.root, 'approval.bin'),
      canonicalPath: repo.canonicalPath,
      approvalHash,
    });
    const after = await capability.reconcile();
    expect(after.kind).toBe('canonical_written');
  });
});

// --------------------------------------------------------------------
// Discovery / frozen-core contract
// --------------------------------------------------------------------

describe('SDK frozen-core contract', () => {
  it('refuses canonical writes whose repoPath does not match the locked regeneration source', async () => {
    // The conformance harness's generic binding has
    // canonicalSource.repoPath === 'content/conformance/page.md'. The
    // cerafica adapter is locked to 'inventory/products.json'; the
    // contract answer is "no, you cannot write that here". The
    // expected failure mode is E_DERIVED_WRITE_FORBIDDEN.
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const write = {
      adapterId: adapter.id,
      bindingId: 'rb-cerafica-products',
      tenantId: 'tenant-cerafica',
      environment: 'staging' as const,
      target: {
        repoPath: 'content/conformance/page.md',
        contract: {
          mode: 'alias_symlink' as const,
          aliasPath: 'website/data/products.json',
          aliasTargets: ['../../inventory/products.json'] as const,
          canonicalRepoPath: 'inventory/products.json',
        },
      },
      bytes: { kind: 'utf8' as const, text: 'hello' },
      actor: HUMAN,
    };
    await expect(adapter.apply(write)).rejects.toMatchObject({
      code: 'E_DERIVED_WRITE_FORBIDDEN',
    });
  });

  it('discover advertises the closed frozen + provisional capability set', async () => {
    const repo = setupRepoFixture();
    const adapter = await createCeraficaAdapter(buildOptions(repo));
    const binding = buildBindingFromAdapter(adapter);
    const discovery = await adapter.discover({
      tenantId: binding.tenantId,
      environment: binding.environment,
      bindings: [binding],
    });
    expect(discovery.adapterId).toBe(CERAFICA_ADAPTER_ID);
    expect(discovery.frozenCapabilities).toContain('canonical.write');
    expect(discovery.frozenCapabilities).toContain('media.alias_symlink');
    expect(discovery.provisionalCapabilities).toContain('field.capabilities.read');
    expect(discovery.provisionalCapabilities).toContain('deploy.receipt');
  });

  it('contract version reports the frozen 1.0.0 major and rc extension', () => {
    const adapter = new CeraficaAdapter(
      {
        repoRoot: '/tmp',
        manifestPath: '/tmp/website/cms-regions.json',
        deployClient: makeDeployClient(),
        rollbackWriter: makeRollbackWriter(),
      },
      {
        manifest: HOST_MANIFEST,
        binding: stubBinding(),
        activation: null,
        deployCapability: stubDeployCapability(),
      },
    );
    expect(adapter.contract.frozen).toBe('1.0.0');
    expect(adapter.contract.extensions).toMatch(/-rc\./);
  });
});

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function stubBinding() {
  return {
    id: 'rb-cerafica-products',
    tenantId: 'tenant-cerafica',
    contentType: 'inventory/products',
    environment: 'staging' as const,
    locale: 'en' as const,
    canonicalSource: {
      repoPath: 'inventory/products.json',
      contentHash: SHA('0'.repeat(64)),
      sizeBytes: 0,
    },
    derivedArtifacts: [
      {
        repoPath: 'website/data/products.json',
        kind: 'manifest' as const,
        contentHash: SHA('0'.repeat(64)),
        sizeBytes: 0,
      },
    ],
    regenerationContract: {
      mode: 'alias_symlink' as const,
      aliasPath: 'website/data/products.json',
      aliasTargets: ['../../inventory/products.json'] as const,
    },
    governanceVersion: 1,
    createdAt: ISO('2026-07-27T00:00:00.000Z'),
    createdBy: HUMAN,
  };
}

function stubDeployCapability() {
  const client = makeDeployClient();
  const writer = makeRollbackWriter();
  return createGitHubPagesDeployCapability({ client, rollbackWriter: writer });
}

function buildBindingFromAdapter(adapter: CeraficaAdapter) {
  const state = adapter as unknown as {
    state: {
      binding: {
        id: string;
        tenantId: string;
        contentType: string;
        environment: 'staging' | 'production';
        locale: 'en' | 'es';
        canonicalSource: { repoPath: string; contentHash: Sha256Hex; sizeBytes: number };
        derivedArtifacts: readonly { repoPath: string; kind: 'manifest' | 'preview' | 'thumbnail' | 'transcode' | 'other'; contentHash: Sha256Hex; sizeBytes: number }[];
        regenerationContract: {
          mode: 'alias_symlink';
          aliasPath: string;
          aliasTargets: readonly string[];
        };
        governanceVersion: number;
        createdAt: Iso8601;
        createdBy: Identity;
      };
    };
  };
  return state.state.binding;
}

function buildCanonicalWrite(
  repoPath: string,
  payload: unknown,
  actor: Identity = HUMAN,
  environment: 'staging' | 'production' = 'staging',
): CanonicalWrite {
  return {
    adapterId: CERAFICA_ADAPTER_ID,
    bindingId: 'rb-cerafica-products',
    tenantId: 'tenant-cerafica',
    environment,
    target: {
      repoPath,
      contract: {
        mode: 'alias_symlink',
        aliasPath: 'website/data/products.json',
        aliasTargets: ['../../inventory/products.json'],
        canonicalRepoPath: 'inventory/products.json',
      },
    },
    bytes: { kind: 'utf8', text: JSON.stringify(payload) },
    actor,
  };
}
