/**
 * `@cms/adapter-sdk/conformance` — independent, reusable conformance
 * harness for adapters.
 *
 * The harness exists so that adapter authors and system integrators
 * can verify, without any product-specific knowledge, that an adapter:
 *
 *   1. Declares a contract version compatible with this SDK's frozen
 *      major and reports the provisional extension range explicitly.
 *   2. Does not allow alias writes to be requested (alias paths and
 *      alias targets are derived artifacts, not canonical sources).
 *   3. Refuses to activate ambiguous bindings (more than one canonical
 *      pointer to the same path, self-referential alias targets, alias
 *      targets that collide with the canonical source path, empty
 *      derived artifact lists, unsupported regeneration modes, paths
 *      that escape the repository).
 *   4. Fails closed on unsupported capabilities (advertised frozen
 *      capabilities that are not in the closed set, and provisional
 *      capabilities that the adapter has not explicitly enabled).
 *   5. Refuses to represent approval or publication authority through
 *      any service or agent path. Adapters that expose service- or
 *      agent-shaped apply paths to authority decisions are refused.
 *
 * The harness is intentionally product-agnostic. It does not know
 * about any specific host. It works on the shapes declared in
 * `./index.ts` and on `RegionBinding` from `@cms/core`.
 */

import {
  type CanonicalSource,
  type DerivedArtifact,
  type Identity,
  type Iso8601,
  type RegionBinding,
  type Sha256Hex,
} from '@cms/core';
import {
  AdapterContractError,
  type Adapter,
  type AdapterActivation,
  type AdapterApplyReceipt,
  type AdapterCapability,
  type AdapterDiscovery,
  type AdapterDiscoveryCandidate,
  type AdapterReconcileReceipt,
  type AdapterRefusalCode,
  type AdapterWritePayload,
  ADAPTER_SDK_FROZEN_VERSION,
  ADAPTER_SDK_SURFACE,
  type CanonicalWrite,
  type ConformanceFixtures as ConformanceFixturesInput,
} from './index.js';

// --------------------------------------------------------------------
// Closed value sets (frozen)
// --------------------------------------------------------------------

const FROZEN_CAPABILITIES: ReadonlySet<AdapterCapability> = new Set<AdapterCapability>([
  'canonical.read',
  'canonical.write',
  'derived.regenerate',
  'media.alias_symlink',
  'media.transcode',
  'binding.discover',
  'binding.activate',
  'binding.reconcile',
  'binding.apply',
]);

const PROVISIONAL_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  'field.capabilities.read',
  'field.capabilities.write',
  'deploy.receipt',
]);

// --------------------------------------------------------------------
// Result shape
// --------------------------------------------------------------------

export interface ConformanceCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly details: string;
}

export interface ConformanceReport {
  readonly ok: boolean;
  readonly checks: readonly ConformanceCheck[];
}

export interface AdapterRefusal {
  readonly code: AdapterRefusalCode;
  readonly message: string;
}

// --------------------------------------------------------------------
// Harness entry point
// --------------------------------------------------------------------

/**
 * Run the conformance harness against a live adapter. The harness
 * executes a series of read-only probes and an adversarial apply
 * probe. It never requires product-specific fixtures; the bindings,
 * identities, and writes it generates are constructed from
 * `makeConformanceFixtures`.
 */
export async function runConformance(
  adapter: Adapter,
  fixtures: ConformanceFixtures = makeConformanceFixtures(),
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];

  // 1. Contract version metadata
  checks.push(checkContractVersion(adapter));


  // 3. Discover: ambiguous binding is reported as such, not silently fixed
  const discovery = await adapter.discover({
    tenantId: fixtures.tenantId,
    environment: fixtures.environment,
    bindings: fixtures.bindings,
  });
  checks.push(checkDiscovery(discovery, fixtures));

  // 3b. Discover must not advertise capabilities outside the closed set.
  // This is a separate check from the shape check above so adversarial
  // adapters that advertise a fictional capability fail here with a
  // specific name.
  checks.push(await checkUnsupportedCapabilityClosed(adapter, fixtures));

  // 4. Activate: valid binding activates, ambiguous binding refuses
  for (const binding of fixtures.bindings) {
    const activation = await adapter.activate({ binding });
    checks.push(checkActivation(binding, activation, fixtures));
  }

  // 5. Reconcile: valid binding reconciles without error
  const reconcileTarget = fixtures.bindings.find((b) => fixtures.validBindingIds.has(b.id));
  if (reconcileTarget !== undefined) {
    const receipt = await adapter.reconcile({ binding: reconcileTarget });
    checks.push(checkReconcile(reconcileTarget, receipt));
  }

  // 6. Apply: canonical write goes through; derived write refuses;
  // alias write refuses; service identity refuses; agent identity
  // refuses; environment mismatch refuses. (Unsupported capabilities
  // are checked in step 3b.)
  const canonicalTarget = fixtures.bindings[0];
  if (canonicalTarget !== undefined) {
    checks.push(await checkCanonicalApply(adapter, canonicalTarget, fixtures));
    checks.push(await checkDerivedWriteRefused(adapter, canonicalTarget, fixtures));
    checks.push(await checkAliasWriteRefused(adapter, canonicalTarget, fixtures));
    checks.push(await checkServiceIdentityRefused(adapter, canonicalTarget, fixtures));
    checks.push(await checkAgentIdentityRefused(adapter, canonicalTarget, fixtures));
    checks.push(await checkEnvironmentMismatchRefused(adapter, canonicalTarget, fixtures));
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

// --------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------

export interface ConformanceFixtures {
  readonly tenantId: string;
  readonly environment: 'staging' | 'production';
  readonly bindings: readonly RegionBinding[];
  readonly validBindingIds: ReadonlySet<string>;
  readonly humanIdentity: Identity;
  readonly serviceIdentity: Identity;
  readonly agentIdentity: Identity;
  readonly canonicalHash: Sha256Hex;
  readonly derivedHash: Sha256Hex;
  readonly writePayload: AdapterWritePayload;
  /** An adversary capability that is NOT in the closed set. */
  readonly unsupportedCapability: string;
}

/**
 * Default fixtures. The bindings exercise the frozen core: a valid
 * binding with `alias_symlink` regeneration, an ambiguous binding with
 * alias targets colliding with the canonical source path twice, a
 * binding with empty derived artifacts, a binding with a self-alias,
 * and a binding with a relative-escaping alias target.
 */
export function makeConformanceFixtures(): ConformanceFixtures {
  const tenantId = 'tenant-conformance';
  const createdAt = '2026-01-01T00:00:00.000Z' as Iso8601;
  const canonicalHash: Sha256Hex = 'a'.repeat(64) as Sha256Hex;
  const derivedHash: Sha256Hex = 'b'.repeat(64) as Sha256Hex;
  const humanIdentity: Identity = {
    id: 'conformance-human',
    kind: 'actor',
    displayName: 'Conformance Human',
    capabilities: ['canonical.write'],
  };
  const serviceIdentity: Identity = {
    id: 'conformance-service',
    kind: 'service',
    displayName: 'Conformance Service',
    capabilities: ['canonical.write'],
  };
  const agentIdentity: Identity = {
    id: 'conformance-agent',
    kind: 'service',
    displayName: 'Conformance Agent',
    capabilities: ['mcp'],
  };

  const baseArtifacts: readonly DerivedArtifact[] = [
    {
      repoPath: 'content/conformance/preview.json',
      kind: 'preview',
      contentHash: derivedHash,
      sizeBytes: 128,
    },
    {
      repoPath: 'content/conformance/thumb.png',
      kind: 'thumbnail',
      contentHash: derivedHash,
      sizeBytes: 256,
    },
  ];

  const canonical: CanonicalSource = {
    repoPath: 'content/conformance/page.md',
    contentHash: canonicalHash,
    sizeBytes: 1024,
  };

  const valid: RegionBinding = {
    id: 'binding-valid',
    tenantId,
    contentType: 'page',
    environment: 'staging',
    locale: 'en',
    canonicalSource: canonical,
    derivedArtifacts: baseArtifacts,
    regenerationContract: {
      mode: 'alias_symlink',
      aliasPath: 'content/conformance/page.alias',
      aliasTargets: ['content/conformance/page.md'],
    },
    governanceVersion: 1,
    createdAt,
    createdBy: humanIdentity,
  };

  // Ambiguous: alias target collides with the canonical source path
  // more than once. The pure core rejects this on construction; we
  // therefore build the shape directly without invoking the
  // `assertRegionBinding` helper. The harness is the place where the
  // ambiguity is reported and the activation is refused.
  const ambiguous: RegionBinding = {
    ...valid,
    id: 'binding-ambiguous',
    regenerationContract: {
      mode: 'alias_symlink',
      aliasPath: 'content/conformance/page.alias',
      aliasTargets: ['content/conformance/page.md', 'content/conformance/page.md'],
    },
  };

  const selfAlias: RegionBinding = {
    ...valid,
    id: 'binding-self-alias',
    regenerationContract: {
      mode: 'alias_symlink',
      aliasPath: 'content/conformance/page.alias',
      aliasTargets: ['content/conformance/page.alias'],
    },
  };

  const escaping: RegionBinding = {
    ...valid,
    id: 'binding-escaping',
    regenerationContract: {
      mode: 'alias_symlink',
      aliasPath: '../outside/page.alias',
      aliasTargets: ['content/conformance/page.md'],
    },
  };

  const emptyArtifacts: RegionBinding = {
    ...valid,
    id: 'binding-empty',
    derivedArtifacts: [],
  };

  return {
    tenantId,
    environment: 'staging',
    bindings: [valid, ambiguous, selfAlias, escaping, emptyArtifacts],
    validBindingIds: new Set([valid.id]),
    humanIdentity,
    serviceIdentity,
    agentIdentity,
    canonicalHash,
    derivedHash,
    writePayload: { kind: 'utf8', text: 'hello world' },
    unsupportedCapability: 'fictional.capability',
  };
}

// --------------------------------------------------------------------
// Individual checks
// --------------------------------------------------------------------

function checkContractVersion(adapter: Adapter): ConformanceCheck {
  const declared = adapter.contract;
  if (!isObject(declared)) {
    return { name: 'contract.version.shape', ok: false, details: 'adapter.contract is not an object' };
  }
  if (typeof declared.frozen !== 'string' || declared.frozen.length === 0) {
    return { name: 'contract.version.frozen', ok: false, details: 'frozen version is not a non-empty string' };
  }
  if (typeof declared.extensions !== 'string' || declared.extensions.length === 0) {
    return { name: 'contract.version.extensions', ok: false, details: 'extensions version is not a non-empty string' };
  }
  if (declared.surface !== ADAPTER_SDK_SURFACE) {
    return {
      name: 'contract.version.surface',
      ok: false,
      details: `surface must be "${ADAPTER_SDK_SURFACE}", got "${String(declared.surface)}"`,
    };
  }
  // The frozen major must match this SDK's frozen major exactly. The
  // contract is the only field callers should compare on; we compare
  // the leading major prefix of the frozen string.
  const sdkFrozen = ADAPTER_SDK_FROZEN_VERSION;
  const declaredMajor = majorOf(declared.frozen);
  const sdkMajor = majorOf(sdkFrozen);
  if (declaredMajor !== sdkMajor) {
    return {
      name: 'contract.version.major',
      ok: false,
      details: `frozen major mismatch: adapter=${declaredMajor}, sdk=${sdkMajor}`,
    };
  }
  // The extensions version is provisional but must be present and
  // must include a prerelease marker, distinguishing it from a
  // frozen release.
  if (!declared.extensions.includes('-')) {
    return {
      name: 'contract.version.provisional_marker',
      ok: false,
      details: `extensions version "${declared.extensions}" must include a prerelease marker (e.g. "1.0.0-rc.1")`,
    };
  }
  return {
    name: 'contract.version',
    ok: true,
    details: `frozen=${declared.frozen}, extensions=${declared.extensions}`,
  };
}

function checkDiscovery(
  discovery: AdapterDiscovery,
  fixtures: ConformanceFixtures,
): ConformanceCheck {
  if (!isObject(discovery)) {
    return { name: 'discovery.shape', ok: false, details: 'discovery is not an object' };
  }
  if (!Array.isArray(discovery.frozenCapabilities)) {
    return { name: 'discovery.frozen', ok: false, details: 'frozenCapabilities is not an array' };
  }
  if (!Array.isArray(discovery.provisionalCapabilities)) {
    return { name: 'discovery.provisional', ok: false, details: 'provisionalCapabilities is not an array' };
  }
  if (!Array.isArray(discovery.candidates)) {
    return { name: 'discovery.candidates', ok: false, details: 'candidates is not an array' };
  }
  // Closed-set capability advertisement is verified in
  // `checkUnsupportedCapabilityClosed`; this function only verifies
  // shape and per-binding ambiguity reporting.
  // The ambiguous, self-alias, escaping, and empty-artifact bindings
  // MUST be reported with non-empty issues.
  const candidatesById = new Map<string, AdapterDiscoveryCandidate>(
    discovery.candidates.map((c) => [c.bindingId, c]),
  );
  const expectedAmbiguous = ['binding-ambiguous', 'binding-self-alias', 'binding-escaping', 'binding-empty'];
  for (const id of expectedAmbiguous) {
    const candidate = candidatesById.get(id);
    if (candidate === undefined) {
      return {
        name: 'discovery.ambiguity_reported',
        ok: false,
        details: `binding ${id} is missing from discovery candidates`,
      };
    }
    if (candidate.issues.length === 0) {
      return {
        name: 'discovery.ambiguity_reported',
        ok: false,
        details: `binding ${id} is ambiguous but reported as activatable`,
      };
    }
  }
  // The valid binding MUST be reported as activatable.
  const validCandidate = candidatesById.get(fixtures.bindings[0]?.id ?? '');
  if (validCandidate === undefined || validCandidate.issues.length !== 0) {
    return {
      name: 'discovery.valid_reported',
      ok: false,
      details: 'valid binding was not reported as activatable',
    };
  }
  return { name: 'discovery', ok: true, details: `candidates=${discovery.candidates.length}` };
}

function checkActivation(
  binding: RegionBinding,
  activation: AdapterActivation,
  fixtures: ConformanceFixtures,
): ConformanceCheck {
  if (!isObject(activation)) {
    return { name: 'activation.shape', ok: false, details: 'activation is not an object' };
  }
  if (activation.bindingId !== binding.id) {
    return {
      name: 'activation.binding_id',
      ok: false,
      details: `activation.bindingId=${activation.bindingId} but expected ${binding.id}`,
    };
  }
  if (activation.tenantId !== binding.tenantId || activation.environment !== binding.environment) {
    return {
      name: 'activation.scope',
      ok: false,
      details: 'activation tenant/environment does not match binding',
    };
  }
  const unknownCapability = activation.enabledCapabilities.find(
    (capability) =>
      !FROZEN_CAPABILITIES.has(capability as AdapterCapability) &&
      !PROVISIONAL_CAPABILITIES.has(capability),
  );
  if (unknownCapability !== undefined) {
    return {
      name: 'activation.capability_closed_set',
      ok: false,
      details: `activation enabled unsupported capability ${unknownCapability}`,
    };
  }
  const expectedContract = binding.regenerationContract;
  if (
    activation.contract.mode !== expectedContract.mode ||
    activation.contract.aliasPath !== expectedContract.aliasPath ||
    activation.contract.canonicalRepoPath !== binding.canonicalSource.repoPath ||
    activation.contract.aliasTargets.length !== expectedContract.aliasTargets.length ||
    activation.contract.aliasTargets.some(
      (target, index) => target !== expectedContract.aliasTargets[index],
    )
  ) {
    return {
      name: 'activation.contract_echo',
      ok: false,
      details: 'activation contract does not match binding canonical-resolution contract',
    };
  }
  if (fixtures.validBindingIds.has(binding.id)) {
    if (!activation.ok) {
      return {
        name: 'activation.valid',
        ok: false,
        details: `valid binding ${binding.id} was refused: ${activation.refusalReasons.join('; ')}`,
      };
    }
    return { name: 'activation.valid', ok: true, details: `binding=${binding.id}` };
  }
  if (activation.ok) {
    return {
      name: 'activation.ambiguous_refused',
      ok: false,
      details: `ambiguous binding ${binding.id} was activated; harness expected refusal`,
    };
  }
  if (activation.refusalReasons.length === 0) {
    return {
      name: 'activation.refusal_reasons',
      ok: false,
      details: `ambiguous binding ${binding.id} refused without reasons`,
    };
  }
  return {
    name: 'activation.ambiguous_refused',
    ok: true,
    details: `binding=${binding.id} refused (${activation.refusalReasons.length} reasons)`,
  };
}

function checkReconcile(
  binding: RegionBinding,
  receipt: AdapterReconcileReceipt,
): ConformanceCheck {
  if (!isObject(receipt)) {
    return { name: 'reconcile.shape', ok: false, details: 'receipt is not an object' };
  }
  if (receipt.bindingId !== binding.id) {
    return {
      name: 'reconcile.binding_id',
      ok: false,
      details: `receipt.bindingId=${receipt.bindingId} but expected ${binding.id}`,
    };
  }
  if (typeof receipt.observedAt !== 'string') {
    return { name: 'reconcile.observed_at', ok: false, details: 'observedAt is not a string' };
  }
  if (typeof receipt.inSync !== 'boolean') {
    return { name: 'reconcile.in_sync', ok: false, details: 'inSync is not a boolean' };
  }
  if (!Array.isArray(receipt.drift)) {
    return { name: 'reconcile.drift', ok: false, details: 'drift is not an array' };
  }
  return { name: 'reconcile', ok: true, details: `inSync=${receipt.inSync}` };
}

async function checkCanonicalApply(
  adapter: Adapter,
  binding: RegionBinding,
  fixtures: ConformanceFixtures,
): Promise<ConformanceCheck> {
  const contract = binding.regenerationContract;
  if (contract.mode !== 'alias_symlink') {
    return {
      name: 'apply.canonical',
      ok: false,
      details: `unexpected contract mode in fixture: ${String(contract.mode)}`,
    };
  }
  const write: CanonicalWrite = {
    adapterId: adapter.id,
    bindingId: binding.id,
    tenantId: binding.tenantId,
    environment: binding.environment,
    target: {
      repoPath: binding.canonicalSource.repoPath,
      contract: {
        mode: 'alias_symlink',
        aliasPath: contract.aliasPath,
        aliasTargets: contract.aliasTargets,
        canonicalRepoPath: binding.canonicalSource.repoPath,
      },
    },
    bytes: fixtures.writePayload,
    actor: fixtures.humanIdentity,
    contentHash: fixtures.canonicalHash,
  };
  try {
    const receipt = await adapter.apply(write);
    if (!isValidApplyReceipt(receipt, binding, write)) {
      return { name: 'apply.canonical', ok: false, details: 'apply receipt is malformed' };
    }
    return { name: 'apply.canonical', ok: true, details: `repoPath=${receipt.canonicalRepoPath}` };
  } catch (err) {
    return {
      name: 'apply.canonical',
      ok: false,
      details: `canonical apply threw: ${(err as Error).message}`,
    };
  }
}

async function checkDerivedWriteRefused(
  adapter: Adapter,
  binding: RegionBinding,
  fixtures: ConformanceFixtures,
): Promise<ConformanceCheck> {
  const contract = binding.regenerationContract;
  if (contract.mode !== 'alias_symlink') {
    return { name: 'apply.derived_refused', ok: false, details: 'fixture mode is not alias_symlink' };
  }
  const derived = binding.derivedArtifacts[0];
  if (derived === undefined) {
    return { name: 'apply.derived_refused', ok: false, details: 'fixture has no derived artifact to target' };
  }
  const write: CanonicalWrite = {
    adapterId: adapter.id,
    bindingId: binding.id,
    tenantId: binding.tenantId,
    environment: binding.environment,
    target: {
      repoPath: derived.repoPath,
      contract: {
        mode: 'alias_symlink',
        aliasPath: contract.aliasPath,
        aliasTargets: contract.aliasTargets,
        canonicalRepoPath: binding.canonicalSource.repoPath,
      },
    },
    bytes: fixtures.writePayload,
    actor: fixtures.humanIdentity,
  };
  const result = await expectRefusal(adapter, write, 'E_DERIVED_WRITE_FORBIDDEN');
  return { name: 'apply.derived_refused', ok: result.ok, details: result.details };
}

async function checkAliasWriteRefused(
  adapter: Adapter,
  binding: RegionBinding,
  fixtures: ConformanceFixtures,
): Promise<ConformanceCheck> {
  const contract = binding.regenerationContract;
  if (contract.mode !== 'alias_symlink') {
    return { name: 'apply.alias_refused', ok: false, details: 'fixture mode is not alias_symlink' };
  }
  const write: CanonicalWrite = {
    adapterId: adapter.id,
    bindingId: binding.id,
    tenantId: binding.tenantId,
    environment: binding.environment,
    target: {
      repoPath: contract.aliasPath,
      contract: {
        mode: 'alias_symlink',
        aliasPath: contract.aliasPath,
        aliasTargets: contract.aliasTargets,
        canonicalRepoPath: binding.canonicalSource.repoPath,
      },
    },
    bytes: fixtures.writePayload,
    actor: fixtures.humanIdentity,
  };
  const result = await expectRefusal(adapter, write, 'E_ALIAS_WRITE_FORBIDDEN');
  return { name: 'apply.alias_refused', ok: result.ok, details: result.details };
}

async function checkServiceIdentityRefused(
  adapter: Adapter,
  binding: RegionBinding,
  fixtures: ConformanceFixtures,
): Promise<ConformanceCheck> {
  const contract = binding.regenerationContract;
  if (contract.mode !== 'alias_symlink') {
    return { name: 'apply.service_refused', ok: false, details: 'fixture mode is not alias_symlink' };
  }
  const write: CanonicalWrite = {
    adapterId: adapter.id,
    bindingId: binding.id,
    tenantId: binding.tenantId,
    environment: binding.environment,
    target: {
      repoPath: binding.canonicalSource.repoPath,
      contract: {
        mode: 'alias_symlink',
        aliasPath: contract.aliasPath,
        aliasTargets: contract.aliasTargets,
        canonicalRepoPath: binding.canonicalSource.repoPath,
      },
    },
    bytes: fixtures.writePayload,
    actor: fixtures.serviceIdentity,
  };
  const result = await expectRefusal(adapter, write, 'E_AUTHORITY_FORBIDDEN');
  return { name: 'apply.service_refused', ok: result.ok, details: result.details };
}

async function checkAgentIdentityRefused(
  adapter: Adapter,
  binding: RegionBinding,
  fixtures: ConformanceFixtures,
): Promise<ConformanceCheck> {
  // The agent identity is shaped exactly like an MCP service identity:
  // a service-kind identity with the `mcp` capability. The contract
  // invariant is that no service- or agent-shaped path can represent
  // approval or publication authority. Adapters are write surfaces,
  // not authority surfaces; the harness refuses any apply that uses a
  // service identity as the actor.
  const contract = binding.regenerationContract;
  if (contract.mode !== 'alias_symlink') {
    return { name: 'apply.agent_refused', ok: false, details: 'fixture mode is not alias_symlink' };
  }
  const write: CanonicalWrite = {
    adapterId: adapter.id,
    bindingId: binding.id,
    tenantId: binding.tenantId,
    environment: binding.environment,
    target: {
      repoPath: binding.canonicalSource.repoPath,
      contract: {
        mode: 'alias_symlink',
        aliasPath: contract.aliasPath,
        aliasTargets: contract.aliasTargets,
        canonicalRepoPath: binding.canonicalSource.repoPath,
      },
    },
    bytes: fixtures.writePayload,
    actor: fixtures.agentIdentity,
  };
  const result = await expectRefusal(adapter, write, 'E_AUTHORITY_FORBIDDEN');
  return { name: 'apply.agent_refused', ok: result.ok, details: result.details };
}

async function checkUnsupportedCapabilityClosed(
  adapter: Adapter,
  fixtures: ConformanceFixtures,
): Promise<ConformanceCheck> {
  // Probe the adapter's live discovery result. The adapter MUST NOT
  // advertise any frozen or provisional capability outside the closed
  // sets the SDK defines. A failure here is a fail-closed guarantee
  // that the system does not silently widen its own authority.
  const probeBinding = fixtures.bindings[0];
  if (probeBinding === undefined) {
    return {
      name: 'capability.fail_closed',
      ok: false,
      details: 'no probe binding available',
    };
  }
  const probe = await adapter.discover({
    tenantId: fixtures.tenantId,
    environment: fixtures.environment,
    bindings: [probeBinding],
  });
  for (const cap of probe.frozenCapabilities) {
    if (!FROZEN_CAPABILITIES.has(cap)) {
      return {
        name: 'capability.fail_closed',
        ok: false,
        details: `unsupported frozen capability advertised: ${String(cap)}`,
      };
    }
  }
  for (const cap of probe.provisionalCapabilities) {
    if (!PROVISIONAL_CAPABILITIES.has(cap)) {
      return {
        name: 'capability.fail_closed',
        ok: false,
        details: `unsupported provisional capability advertised: ${String(cap)}`,
      };
    }
  }
  return {
    name: 'capability.fail_closed',
    ok: true,
    details: 'all advertised capabilities are inside the closed set',
  };
}

async function checkEnvironmentMismatchRefused(
  adapter: Adapter,
  binding: RegionBinding,
  fixtures: ConformanceFixtures,
): Promise<ConformanceCheck> {
  const contract = binding.regenerationContract;
  if (contract.mode !== 'alias_symlink') {
    return { name: 'apply.environment_refused', ok: false, details: 'fixture mode is not alias_symlink' };
  }
  const wrongEnv = binding.environment === 'staging' ? 'production' : 'staging';
  const write: CanonicalWrite = {
    adapterId: adapter.id,
    bindingId: binding.id,
    tenantId: binding.tenantId,
    environment: wrongEnv,
    target: {
      repoPath: binding.canonicalSource.repoPath,
      contract: {
        mode: 'alias_symlink',
        aliasPath: contract.aliasPath,
        aliasTargets: contract.aliasTargets,
        canonicalRepoPath: binding.canonicalSource.repoPath,
      },
    },
    bytes: fixtures.writePayload,
    actor: fixtures.humanIdentity,
  };
  const result = await expectRefusal(adapter, write, 'E_ENVIRONMENT_MISMATCH');
  return { name: 'apply.environment_refused', ok: result.ok, details: result.details };
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

interface RefusalProbe {
  ok: boolean;
  details: string;
}

async function expectRefusal(
  adapter: Adapter,
  write: CanonicalWrite,
  expected: AdapterRefusalCode,
): Promise<RefusalProbe> {
  try {
    await adapter.apply(write);
    return { ok: false, details: `apply did not refuse; expected ${expected}` };
  } catch (err) {
    if (err instanceof AdapterContractError) {
      if (err.code !== expected) {
        return { ok: false, details: `apply refused with ${err.code}, expected ${expected}` };
      }
      return { ok: true, details: `refused with ${err.code}` };
    }
    return { ok: false, details: `apply threw non-contract error: ${(err as Error).message}` };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function majorOf(version: string): string {
  const dot = version.indexOf('.');
  return dot === -1 ? version : version.slice(0, dot);
}

function isValidApplyReceipt(
  receipt: AdapterApplyReceipt,
  binding: RegionBinding,
  write: CanonicalWrite,
): boolean {
  if (!isObject(receipt)) return false;
  if (receipt.bindingId !== binding.id) return false;
  if (receipt.tenantId !== binding.tenantId) return false;
  if (receipt.environment !== binding.environment) return false;
  if (receipt.adapterId !== write.adapterId) return false;
  if (receipt.canonicalRepoPath !== write.target.repoPath) return false;
  if (!/^[0-9a-f]{64}$/.test(receipt.canonicalHash)) return false;
  if (typeof receipt.appliedAt !== 'string' || receipt.appliedAt.length === 0) return false;
  if (
    receipt.contract.mode !== write.target.contract.mode ||
    receipt.contract.aliasPath !== write.target.contract.aliasPath ||
    receipt.contract.canonicalRepoPath !== write.target.contract.canonicalRepoPath ||
    receipt.contract.aliasTargets.length !== write.target.contract.aliasTargets.length ||
    receipt.contract.aliasTargets.some(
      (target, index) => target !== write.target.contract.aliasTargets[index],
    )
  ) {
    return false;
  }
  if (
    receipt.actor.id !== write.actor.id ||
    receipt.actor.kind !== write.actor.kind ||
    receipt.actor.displayName !== write.actor.displayName ||
    receipt.actor.capabilities.length !== write.actor.capabilities.length ||
    receipt.actor.capabilities.some(
      (capability, index) => capability !== write.actor.capabilities[index],
    )
  ) {
    return false;
  }
  return true;
}

// Re-export the fixtures type for the public surface
export type { ConformanceFixturesInput };
