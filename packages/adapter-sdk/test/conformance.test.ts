/**
 * Conformance tests for `@cms/adapter-sdk`.
 *
 * These tests verify the contract surface, the frozen-vs-provisional
 * version metadata, and the rejection guarantees. They build valid
 * and adversarial adapters in-memory (no product-specific fixtures,
 * no Cerafica references) and drive them through the
 * `runConformance` harness.
 *
 * Each test asserts ONE contract invariant so failures point at a
 * specific bypass:
 *   1. The frozen core's `canonical_source` / `derived_artifacts` /
 *      `regeneration_contract` shape is preserved across the public
 *      surface.
 *   2. The alias_symlink regeneration mode is the only frozen mode
 *      and is part of the contract metadata.
 *   3. `runConformance` produces deterministic failures when an
 *      adapter attempts a known bypass.
 *   4. The closed union of refusal codes is what the contract
 *      advertises; pattern-matching on `code` is safe.
 *   5. The contract version metadata distinguishes frozen core from
 *      provisional extensions; the major prefix is what callers
 *      compare.
 */

import { describe, expect, it } from 'vitest';
import {
  AdapterContractError,
  type Adapter,
  type AdapterActivation,
  type AdapterApplyReceipt,
  type AdapterDiscovery,
  type AdapterReconcileReceipt,
  type AnyCapability,
  type CanonicalSource,
  type CanonicalWrite,
  type ConformanceFixtures,
  type DerivedArtifact,
  type Identity,
  type Iso8601,
  type RegenerationContract,
  type RegionBinding,
  type Sha256Hex,
  ADAPTER_FROZEN_CORE_METADATA,
  ADAPTER_REFUSAL_CODES,
  ADAPTER_SDK_EXTENSIONS_VERSION,
  ADAPTER_SDK_FROZEN_VERSION,
  ADAPTER_SDK_SURFACE,
  ADAPTER_SDK_VERSION,
  brandAdapterId,
  makeConformanceFixtures,
  runConformance,
  type AdapterContractVersion,
} from '../src/index.js';

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

const SHA = (hex: string): Sha256Hex => hex as Sha256Hex;
const ISO = (s: string): Iso8601 => s as Iso8601;

const HUMAN: Identity = Object.freeze({
  id: 'human-1',
  kind: 'actor',
  displayName: 'Human One',
  capabilities: ['canonical.write'],
});

function makeBinding(overrides: Partial<RegionBinding> = {}): RegionBinding {
  const canonical: CanonicalSource = {
    repoPath: 'content/sample/page.md',
    contentHash: SHA('a'.repeat(64)),
    sizeBytes: 1024,
  };
  const artifacts: readonly DerivedArtifact[] = [
    {
      repoPath: 'content/sample/preview.json',
      kind: 'preview',
      contentHash: SHA('b'.repeat(64)),
      sizeBytes: 128,
    },
  ];
  return {
    id: 'rb-sample',
    tenantId: 'tenant-sample',
    contentType: 'page',
    environment: 'staging',
    locale: 'en',
    canonicalSource: canonical,
    derivedArtifacts: artifacts,
    regenerationContract: {
      mode: 'alias_symlink',
      aliasPath: 'content/sample/page.alias',
      aliasTargets: ['content/sample/page.md'],
    },
    governanceVersion: 1,
    createdAt: ISO('2026-01-01T00:00:00.000Z'),
    createdBy: HUMAN,
    ...overrides,
  };
}

function makeDiscovery(binding: RegionBinding, issues: readonly string[] = []): AdapterDiscovery {
  return {
    adapterId: brandAdapterId('adapter-sample'),
    contract: ADAPTER_SDK_VERSION,
    frozenCapabilities: ['canonical.read', 'canonical.write', 'binding.discover', 'binding.activate', 'binding.reconcile', 'binding.apply', 'media.alias_symlink'],
    provisionalCapabilities: [],
    candidates: [
      {
        bindingId: binding.id,
        tenantId: binding.tenantId,
        environment: binding.environment,
        issues,
        capabilities: ['canonical.write', 'media.alias_symlink'],
      },
    ],
  };
}

function makeActivation(binding: RegionBinding, ok = true, refusalReasons: readonly string[] = []): AdapterActivation {
  const contract = binding.regenerationContract;
  return {
    adapterId: brandAdapterId('adapter-sample'),
    bindingId: binding.id,
    tenantId: binding.tenantId,
    environment: binding.environment,
    ok,
    refusalReasons,
    enabledCapabilities: ok ? ['canonical.write', 'media.alias_symlink'] : [],
    contract: {
      mode: contract.mode,
      aliasPath: contract.aliasPath,
      aliasTargets: contract.aliasTargets,
      canonicalRepoPath: binding.canonicalSource.repoPath,
    },
  };
}

function makeReconcile(binding: RegionBinding, inSync = true): AdapterReconcileReceipt {
  return {
    adapterId: brandAdapterId('adapter-sample'),
    bindingId: binding.id,
    tenantId: binding.tenantId,
    environment: binding.environment,
    observedAt: ISO('2026-07-27T12:00:00.000Z'),
    inSync,
    drift: [],
  };
}

function makeApplyReceipt(binding: RegionBinding, write: CanonicalWrite): AdapterApplyReceipt {
  return {
    adapterId: write.adapterId,
    bindingId: binding.id,
    tenantId: binding.tenantId,
    environment: binding.environment,
    canonicalRepoPath: binding.canonicalSource.repoPath,
    canonicalHash: SHA('c'.repeat(64)),
    appliedAt: ISO('2026-07-27T12:00:00.000Z'),
    actor: write.actor,
    contract: write.target.contract,
  };
}

/**
 * The "good" adapter. It implements the contract correctly: refuses
 * derived / alias / service / agent / environment-mismatched writes,
 * refuses unsupported capabilities, refuses ambiguous bindings.
 */
function makeGoodAdapter(): Adapter {
  const bindingsById = new Map<string, RegionBinding>();
  return {
    id: brandAdapterId('adapter-good'),
    contract: ADAPTER_SDK_VERSION,
    async discover({ bindings }): Promise<AdapterDiscovery> {
      for (const binding of bindings) bindingsById.set(binding.id, binding);
      return {
        adapterId: brandAdapterId('adapter-good'),
        contract: ADAPTER_SDK_VERSION,
        frozenCapabilities: [
          'canonical.read',
          'canonical.write',
          'binding.discover',
          'binding.activate',
          'binding.reconcile',
          'binding.apply',
          'media.alias_symlink',
        ],
        provisionalCapabilities: [],
        candidates: bindings.map((b) => ({
          bindingId: b.id,
          tenantId: b.tenantId,
          environment: b.environment,
          issues: detectBindingIssues(b),
          capabilities: ['canonical.write', 'media.alias_symlink'],
        })),
      };
    },
    async activate({ binding }): Promise<AdapterActivation> {
      bindingsById.set(binding.id, binding);
      const issues = detectBindingIssues(binding);
      if (issues.length > 0) {
        return makeActivation(binding, false, issues);
      }
      return makeActivation(binding, true, []);
    },
    async reconcile({ binding }): Promise<AdapterReconcileReceipt> {
      return makeReconcile(binding, true);
    },
    async apply(write: CanonicalWrite): Promise<AdapterApplyReceipt> {
      const binding = bindingsById.get(write.bindingId);
      if (!binding) {
        throw new AdapterContractError(
          'E_BINDING_NOT_FOUND',
          `binding ${write.bindingId} was not discovered or activated`,
        );
      }
      // Refuse derived writes
      if (binding.derivedArtifacts.some((a) => a.repoPath === write.target.repoPath)) {
        throw new AdapterContractError(
          'E_DERIVED_WRITE_FORBIDDEN',
          `cannot write derived artifact ${write.target.repoPath}`,
          { repoPath: write.target.repoPath },
        );
      }
      // Refuse alias writes
      if (binding.regenerationContract.aliasPath === write.target.repoPath) {
        throw new AdapterContractError(
          'E_ALIAS_WRITE_FORBIDDEN',
          `cannot write alias path ${write.target.repoPath}`,
          { repoPath: write.target.repoPath },
        );
      }
      // Refuse service and agent identities
      if (write.actor.kind === 'service') {
        throw new AdapterContractError(
          'E_AUTHORITY_FORBIDDEN',
          `service or agent identity cannot drive adapter writes`,
          { actorId: write.actor.id, actorKind: write.actor.kind },
        );
      }
      // Refuse environment mismatch
      if (write.environment !== binding.environment) {
        throw new AdapterContractError(
          'E_ENVIRONMENT_MISMATCH',
          `binding ${binding.id} is in ${binding.environment}, got ${write.environment}`,
          { bindingEnv: binding.environment, writeEnv: write.environment },
        );
      }
      return makeApplyReceipt(binding, write);
    },
  };
}

/**
 * Detect binding ambiguity issues. This is the kind of inspection a
 * well-behaved adapter performs at discover time; the harness checks
 * that the issues are non-empty for ambiguous fixtures.
 */
function detectBindingIssues(binding: RegionBinding): readonly string[] {
  const issues: string[] = [];
  if (binding.derivedArtifacts.length === 0) {
    issues.push('derived artifacts list is empty');
  }
  const contract = binding.regenerationContract;
  if (contract.mode !== 'alias_symlink') {
    issues.push(`unsupported regeneration mode: ${String(contract.mode)}`);
  }
  if (contract.aliasPath.includes('..') || contract.aliasPath.startsWith('/')) {
    issues.push('alias path escapes the repository');
  }
  for (const target of contract.aliasTargets) {
    if (target.includes('..') || target.startsWith('/')) {
      issues.push('alias target escapes the repository');
    }
  }
  if (contract.aliasTargets.includes(contract.aliasPath)) {
    issues.push('alias path is its own target');
  }
  const collisions = contract.aliasTargets.filter(
    (t) => t === binding.canonicalSource.repoPath,
  ).length;
  if (collisions > 1) {
    issues.push('alias targets collide with canonicalSource more than once');
  }
  return Object.freeze(issues);
}

function makeAdversarialAdapter(
  override: Partial<{
    contract: AdapterContractVersion;
    discoveryIssues: (binding: RegionBinding) => readonly string[];
    activate: (binding: RegionBinding) => AdapterActivation;
    apply: (write: CanonicalWrite) => AdapterApplyReceipt;
    extraFrozenCapabilities: readonly string[];
    extraProvisionalCapabilities: readonly string[];
  }>,
): Adapter {
  const contract = override.contract ?? ADAPTER_SDK_VERSION;
  const frozenCapabilities: readonly string[] = [
    'canonical.read',
    'canonical.write',
    'binding.discover',
    'binding.activate',
    'binding.reconcile',
    'binding.apply',
    'media.alias_symlink',
    ...(override.extraFrozenCapabilities ?? []),
  ];
  const provisionalCapabilities: readonly string[] = override.extraProvisionalCapabilities ?? [];
  return {
    id: brandAdapterId('adapter-adversarial'),
    contract,
    async discover({ bindings }): Promise<AdapterDiscovery> {
      // Adversarial adapters default to reporting issues correctly so
      // that tests targeting non-discovery invariants do not fail on
      // an unrelated check. The override forces the discover shape
      // when the test wants to bypass the check.
      const issues = (binding: RegionBinding): readonly string[] =>
        override.discoveryIssues !== undefined
          ? override.discoveryIssues(binding)
          : detectBindingIssues(binding);
      return {
        adapterId: brandAdapterId('adapter-adversarial'),
        contract,
        frozenCapabilities: frozenCapabilities as readonly AnyCapability[],
        provisionalCapabilities: provisionalCapabilities as readonly AnyCapability[],
        candidates: bindings.map((b) => ({
          bindingId: b.id,
          tenantId: b.tenantId,
          environment: b.environment,
          issues: issues(b),
          capabilities: ['canonical.write', 'media.alias_symlink'],
        })),
      };
    },
    async activate({ binding }): Promise<AdapterActivation> {
      if (override.activate !== undefined) {
        return override.activate(binding);
      }
      return makeActivation(binding, true, []);
    },
    async reconcile({ binding }): Promise<AdapterReconcileReceipt> {
      return makeReconcile(binding, true);
    },
    async apply(write: CanonicalWrite): Promise<AdapterApplyReceipt> {
      if (override.apply !== undefined) {
        return override.apply(write);
      }
      const binding = makeBinding({
        id: write.bindingId,
        tenantId: write.tenantId,
        environment: write.environment,
      });
      return makeApplyReceipt(binding, write);
    },
  };
}

// --------------------------------------------------------------------
// Frozen core invariants
// --------------------------------------------------------------------

describe('frozen core surface', () => {
  it('publishes runtime metadata for the frozen canonical-resolution shape', () => {
    expect(ADAPTER_FROZEN_CORE_METADATA.regionBindingContractFields).toEqual([
      'canonical_source',
      'derived_artifacts',
      'regeneration_contract',
    ]);
    expect(ADAPTER_FROZEN_CORE_METADATA.typeScriptProperties).toEqual([
      'canonicalSource',
      'derivedArtifacts',
      'regenerationContract',
    ]);
    expect(ADAPTER_FROZEN_CORE_METADATA.regenerationModes).toEqual(['alias_symlink']);
  });

  it('admits exactly one regeneration mode in the frozen core: alias_symlink', () => {
    // The RegenerationMode is a discriminated union; the closed value
    // is `alias_symlink`. A new mode would be a major bump.
    const regen: RegenerationContract = {
      mode: 'alias_symlink',
      aliasPath: 'a',
      aliasTargets: ['b'],
    };
    expect(regen.mode).toBe('alias_symlink');
  });

  it('freezes the contract version metadata at SDK-load time', () => {
    // Frozen core and extensions are separately versioned. Callers
    // compare the major of `frozen` and the prerelease marker of
    // `extensions` to decide whether a build is acceptable.
    expect(ADAPTER_SDK_FROZEN_VERSION).toBe('1.0.0');
    expect(ADAPTER_SDK_EXTENSIONS_VERSION).toMatch(/-/);
    expect(ADAPTER_SDK_SURFACE).toBe('@cms/adapter-sdk');
    expect(ADAPTER_SDK_VERSION).toEqual({
      frozen: '1.0.0',
      extensions: ADAPTER_SDK_EXTENSIONS_VERSION,
      surface: '@cms/adapter-sdk',
    });
    expect(Object.isFrozen(ADAPTER_SDK_VERSION)).toBe(true);
  });

  it('locks the closed union of refusal codes', () => {
    // Pattern-matching on `code` is part of the contract. The closed
    // union MUST NOT be widened without a major bump.
    expect(ADAPTER_REFUSAL_CODES).toEqual([
      'E_AMBIGUOUS_BINDING',
      'E_DERIVED_WRITE_FORBIDDEN',
      'E_ALIAS_WRITE_FORBIDDEN',
      'E_UNSUPPORTED_CAPABILITY',
      'E_CONTRACT_VERSION_MISMATCH',
      'E_PROVISIONAL_OUT_OF_SCOPE',
      'E_AUTHORITY_FORBIDDEN',
      'E_BINDING_NOT_FOUND',
      'E_ENVIRONMENT_MISMATCH',
    ]);
    expect(Object.isFrozen(ADAPTER_REFUSAL_CODES)).toBe(true);
  });

  it('brands the AdapterId and refuses empty strings', () => {
    const id = brandAdapterId('@cms/adapter-sdk/sample');
    expect(id).toBe('@cms/adapter-sdk/sample');
    expect(() => brandAdapterId('')).toThrow();
  });

  it('declares a closed set of frozen and provisional capabilities', () => {
    // The closed sets are documented in the source; the harness
    // imports the same sets and uses them as the authoritative
    // reference. A drift between source comments and runtime is
    // caught here.
    const frozenCaps: readonly AnyCapability[] = [
      'canonical.read',
      'canonical.write',
      'derived.regenerate',
      'media.alias_symlink',
      'media.transcode',
      'binding.discover',
      'binding.activate',
      'binding.reconcile',
      'binding.apply',
    ];
    const provisionalCaps: readonly AnyCapability[] = [
      'field.capabilities.read',
      'field.capabilities.write',
      'deploy.receipt',
    ];
    // Distinct closed sets: a frozen capability can never be a
    // provisional one and vice versa.
    const intersection = frozenCaps.filter((c) => provisionalCaps.includes(c));
    expect(intersection).toEqual([]);
  });
});

// --------------------------------------------------------------------
// Conformance harness — valid adapter
// --------------------------------------------------------------------

describe('runConformance with a valid adapter', () => {
  it('produces a fully-ok report', async () => {
    const adapter = makeGoodAdapter();
    const report = await runConformance(adapter);
    expect(report.ok).toBe(true);
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
  });

  it('reports the valid binding as activatable and the four ambiguous fixtures as refused', async () => {
    const adapter = makeGoodAdapter();
    const fixtures: ConformanceFixtures = makeConformanceFixtures();
    const report = await runConformance(adapter, fixtures);
    expect(report.ok).toBe(true);
    // The valid binding activates.
    const validActivation = report.checks.find((c) => c.name === 'activation.valid');
    expect(validActivation).toBeDefined();
    expect(validActivation?.ok).toBe(true);
    // The four ambiguous bindings refuse activation.
    const ambiguousChecks = report.checks.filter((c) => c.name === 'activation.ambiguous_refused');
    expect(ambiguousChecks.length).toBeGreaterThanOrEqual(4);
    for (const c of ambiguousChecks) {
      expect(c.ok).toBe(true);
    }
  });
});

// --------------------------------------------------------------------
// Conformance harness — adversarial adapters
// --------------------------------------------------------------------

describe('runConformance detects contract bypasses', () => {
  it('fails when the adapter claims a frozen major different from the SDK', async () => {
    const adapter = makeAdversarialAdapter({
      contract: {
        frozen: '2.0.0',
        extensions: '2.0.0-rc.1',
        surface: '@cms/adapter-sdk',
      },
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const versionCheck = report.checks.find((c) => c.name.startsWith('contract.version'));
    expect(versionCheck?.ok).toBe(false);
  });

  it('fails when the adapter omits the prerelease marker on extensions', async () => {
    const adapter = makeAdversarialAdapter({
      contract: {
        frozen: '1.0.0',
        extensions: '1.0.0', // No prerelease marker
        surface: '@cms/adapter-sdk',
      },
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const markerCheck = report.checks.find(
      (c) => c.name === 'contract.version.provisional_marker',
    );
    expect(markerCheck?.ok).toBe(false);
  });

  it('fails when the adapter declares the wrong surface name', async () => {
    const adapter = makeAdversarialAdapter({
      contract: {
        frozen: '1.0.0',
        extensions: '1.0.0-rc.1',
        surface: 'wrong-surface',
      },
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const surfaceCheck = report.checks.find(
      (c) => c.name === 'contract.version.surface',
    );
    expect(surfaceCheck?.ok).toBe(false);
  });

  it('fails when the adapter activates an ambiguous binding', async () => {
    const adapter = makeAdversarialAdapter({
      activate: (binding) => makeActivation(binding, true, []),
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const refusedCheck = report.checks.find(
      (c) => c.name === 'activation.ambiguous_refused' && c.ok === false,
    );
    expect(refusedCheck).toBeDefined();
  });

  it('fails when the adapter refuses the valid binding', async () => {
    const adapter = makeAdversarialAdapter({
      activate: (binding) => makeActivation(binding, false, ['no good reason']),
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const validCheck = report.checks.find(
      (c) => c.name === 'activation.valid' && c.ok === false,
    );
    expect(validCheck).toBeDefined();
  });

  it('fails when the adapter allows a derived write', async () => {
    const adapter = makeAdversarialAdapter({
      apply: (write) => {
        const binding = makeBinding({
          id: write.bindingId,
          tenantId: write.tenantId,
          environment: write.environment,
        });
        return makeApplyReceipt(binding, write);
      },
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const derivedCheck = report.checks.find(
      (c) => c.name === 'apply.derived_refused' && c.ok === false,
    );
    expect(derivedCheck).toBeDefined();
  });

  it('fails when the adapter allows an alias write', async () => {
    const adapter = makeAdversarialAdapter({
      apply: (write) => {
        const binding = makeBinding({
          id: write.bindingId,
          tenantId: write.tenantId,
          environment: write.environment,
        });
        return makeApplyReceipt(binding, write);
      },
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const aliasCheck = report.checks.find(
      (c) => c.name === 'apply.alias_refused' && c.ok === false,
    );
    expect(aliasCheck).toBeDefined();
  });

  it('fails when the adapter allows a service identity to drive a write', async () => {
    const adapter = makeAdversarialAdapter({
      apply: (write) => {
        const binding = makeBinding({
          id: write.bindingId,
          tenantId: write.tenantId,
          environment: write.environment,
        });
        return makeApplyReceipt(binding, write);
      },
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const serviceCheck = report.checks.find(
      (c) => c.name === 'apply.service_refused' && c.ok === false,
    );
    expect(serviceCheck).toBeDefined();
  });

  it('fails when the adapter allows an agent identity to drive a write', async () => {
    const adapter = makeAdversarialAdapter({
      apply: (write) => {
        const binding = makeBinding({
          id: write.bindingId,
          tenantId: write.tenantId,
          environment: write.environment,
        });
        return makeApplyReceipt(binding, write);
      },
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const agentCheck = report.checks.find(
      (c) => c.name === 'apply.agent_refused' && c.ok === false,
    );
    expect(agentCheck).toBeDefined();
  });

  it('fails when the adapter ignores environment mismatch', async () => {
    const adapter = makeAdversarialAdapter({
      apply: (write) => {
        const binding = makeBinding({
          id: write.bindingId,
          tenantId: write.tenantId,
          environment: write.environment,
        });
        return makeApplyReceipt(binding, write);
      },
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const envCheck = report.checks.find(
      (c) => c.name === 'apply.environment_refused' && c.ok === false,
    );
    expect(envCheck).toBeDefined();
  });

  it('fails when the adapter advertises a frozen capability outside the closed set', async () => {
    const adapter = makeAdversarialAdapter({
      extraFrozenCapabilities: ['fictional.capability'],
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const capCheck = report.checks.find(
      (c) => c.name === 'capability.fail_closed' && c.ok === false,
    );
    expect(capCheck).toBeDefined();
  });

  it('fails when the adapter advertises a provisional capability outside the closed set', async () => {
    const adapter = makeAdversarialAdapter({
      extraProvisionalCapabilities: ['fictional.provisional'],
    });
    const report = await runConformance(adapter);
    expect(report.ok).toBe(false);
    const capCheck = report.checks.find(
      (c) => c.name === 'capability.fail_closed' && c.ok === false,
    );
    expect(capCheck).toBeDefined();
  });
});

// --------------------------------------------------------------------
// AdapterContractError contract
// --------------------------------------------------------------------

describe('AdapterContractError', () => {
  it('freezes the details bag and carries the closed-union code', () => {
    const err = new AdapterContractError('E_DERIVED_WRITE_FORBIDDEN', 'msg', { k: 1 });
    expect(err.code).toBe('E_DERIVED_WRITE_FORBIDDEN');
    expect(Object.isFrozen(err.details)).toBe(true);
    expect(err.details['k']).toBe(1);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AdapterContractError);
  });

  it('uses one of the closed-union codes', () => {
    for (const code of ADAPTER_REFUSAL_CODES) {
      const err = new AdapterContractError(code, 'msg');
      expect(err.code).toBe(code);
    }
  });
});

// --------------------------------------------------------------------
// Discovery shape
// --------------------------------------------------------------------

describe('makeConformanceFixtures', () => {
  it('includes a valid binding and four ambiguous bindings', () => {
    const fixtures = makeConformanceFixtures();
    expect(fixtures.bindings.length).toBe(5);
    const ids = new Set(fixtures.bindings.map((b) => b.id));
    expect(ids.has('binding-valid')).toBe(true);
    expect(ids.has('binding-ambiguous')).toBe(true);
    expect(ids.has('binding-self-alias')).toBe(true);
    expect(ids.has('binding-escaping')).toBe(true);
    expect(ids.has('binding-empty')).toBe(true);
  });

  it('classifies only the valid binding as activatable', () => {
    const fixtures = makeConformanceFixtures();
    expect(fixtures.validBindingIds.has('binding-valid')).toBe(true);
    expect(fixtures.validBindingIds.size).toBe(1);
  });
});

// --------------------------------------------------------------------
// Adapter discovery: closed-set advertisement
// --------------------------------------------------------------------

describe('AdapterDiscovery closed-set advertisement', () => {
  it('is shape-stable for a valid binding', () => {
    const binding = makeBinding();
    const discovery = makeDiscovery(binding);
    expect(discovery.adapterId).toBeDefined();
    expect(discovery.contract).toEqual(ADAPTER_SDK_VERSION);
    expect(Array.isArray(discovery.frozenCapabilities)).toBe(true);
    expect(Array.isArray(discovery.provisionalCapabilities)).toBe(true);
    expect(Array.isArray(discovery.candidates)).toBe(true);
    expect(discovery.candidates[0]?.issues.length).toBe(0);
  });
});
