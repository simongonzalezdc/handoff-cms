/**
 * `@cms/adapter-sdk` — frozen invariant-bearing public contract for the
 * handoff CMS adapter surface.
 *
 * This package is the contract adapters implement to wire a host
 * repository into the system. It is intentionally I/O-free: it only
 * describes shapes, contracts, and boundaries. Adapters take these
 * shapes, do the host work, and return the system-defined receipts.
 *
 * Frozen core (semver 1.0):
 *
 *   - `CanonicalSource` (canonical_source) is the single host-native
 *     reference to authoritative content. Adapters are responsible for
 *     resolving the backend; the system reads through this pointer.
 *   - `DerivedArtifact` (derived_artifacts[]) is the closed list of
 *     served/derived paths the adapter maintains. The frozen rule is
 *     that adapters MUST NOT be asked to write these directly.
 *   - `RegenerationContract` (regeneration_contract) describes how the
 *     adapter materialises canonical writes. The only currently
 *     recognised mode is `alias_symlink`; new modes are added by
 *     widening the discriminated union, never by free-form strings.
 *
 * Provisional extensions (1.0-beta/RC):
 *
 *   - `FieldCapability` (`field_capabilities`): per-field capability
 *     gating, a host-specific projection. Marked provisional; subject
 *     to breaking change before 1.0 stable.
 *   - `DeployCapability` (`DeployCapability`): a host-specific
 *     deployment integration. Marked provisional; subject to breaking
 *     change before 1.0 stable.
 *
 * Adapter boundaries:
 *
 *   - `discover`: read-only capability advertisement.
 *   - `activate`: turns a discovered binding into a live, unambiguous
 *     adapter instance. Activation is refused when the binding is
 *     ambiguous (more than one canonical pointer, alias path self-
 *     referring or escaping, empty derived artifacts, etc.).
 *   - `reconcile`: idempotent drift check between canonical source and
 *     derived artifacts. Reconcile MUST NOT write.
 *   - `apply`: canonical-only write intent. Apply MUST refuse any
 *     write whose target is a derived artifact path. Reconcile is the
 *     upstream precondition; apply refuses to run before reconcile has
 *     observed the latest canonical state.
 *
 * Authority invariant:
 *
 *   - The adapter surface is a write surface, not an authority surface.
 *     Approve / publish / rollback are system-side and never delegated
 *     to adapter paths. Service and agent paths therefore MUST NOT
 *     represent approval or publication authority in the contract.
 */

import {
  type AliasSymlinkContract,
  type CanonicalSource,
  type DerivedArtifact,
  type Identity,
  type Iso8601,
  type RegenerationContract,
  type RegenerationMode,
  type RegionBinding,
  type Sha256Hex,
} from '@cms/core';

// --------------------------------------------------------------------
// Re-exports: frozen core types from @cms/core
// --------------------------------------------------------------------

export type {
  AliasSymlinkContract,
  CanonicalSource,
  DerivedArtifact,
  Identity,
  Iso8601,
  RegenerationContract,
  RegenerationMode,
  RegionBinding,
  Sha256Hex,
};

// --------------------------------------------------------------------
// Contract version metadata
// --------------------------------------------------------------------

/**
 * Contract version. The frozen core of this SDK is at `1.0.0` and only
 * changes on a major bump. Provisional extensions are at `1.0.0-beta+rc`
 * and may move within the `1.0.0` major line.
 *
 * Adapters MUST declare a contract version and the conformance harness
 * MUST refuse any adapter that claims a frozen major it does not
 * implement. The major is the only field callers should compare on;
 * `provisional` and `extensions` are informational.
 */
export interface AdapterContractVersion {
  /** Frozen-core semver, e.g. "1.0.0". Bumping the major is a breaking change. */
  readonly frozen: string;
  /** Extensions semver, e.g. "1.0.0-beta.1" or "1.0.0-rc.1". */
  readonly extensions: string;
  /** Human-readable label of the SDK surface the adapter targets. */
  readonly surface: string;
}

export const ADAPTER_SDK_FROZEN_VERSION = '1.0.0';
export const ADAPTER_SDK_EXTENSIONS_VERSION = '1.0.0-rc.1';
export const ADAPTER_SDK_SURFACE = '@cms/adapter-sdk';

export const ADAPTER_SDK_VERSION: AdapterContractVersion = Object.freeze({
  frozen: ADAPTER_SDK_FROZEN_VERSION,
  extensions: ADAPTER_SDK_EXTENSIONS_VERSION,
  surface: ADAPTER_SDK_SURFACE,
});

/** Runtime metadata for the frozen invariant-bearing RegionBinding surface. */
export const ADAPTER_FROZEN_CORE_METADATA = Object.freeze({
  version: ADAPTER_SDK_FROZEN_VERSION,
  regionBindingContractFields: Object.freeze([
    'canonical_source',
    'derived_artifacts',
    'regeneration_contract',
  ] as const),
  typeScriptProperties: Object.freeze([
    'canonicalSource',
    'derivedArtifacts',
    'regenerationContract',
  ] as const),
  regenerationModes: Object.freeze(['alias_symlink'] as const),
});

// --------------------------------------------------------------------
// Adapter identity
// --------------------------------------------------------------------

/**
 * Stable identifier of an adapter implementation. Namespaced by host
 * (e.g. `@cms/adapters/<host>`); the system never pattern-matches on
 * the host segment for security decisions.
 */
export type AdapterId = string & { readonly __brand: 'AdapterId' };

export function brandAdapterId(value: string): AdapterId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('adapterId must be a non-empty string');
  }
  return value as AdapterId;
}

// --------------------------------------------------------------------
// Capability discovery (read-only advertisement)
// --------------------------------------------------------------------

/**
 * A feature flag the adapter advertises. The closed set is the union of
 * frozen capabilities and provisional capabilities; anything outside
 * the closed set fails closed at activation.
 */
export type AdapterCapability =
  | 'canonical.read'
  | 'canonical.write'
  | 'derived.regenerate'
  | 'media.alias_symlink'
  | 'media.transcode'
  | 'binding.discover'
  | 'binding.activate'
  | 'binding.reconcile'
  | 'binding.apply';

/**
 * Provisional capabilities (1.0-beta/RC). They may be advertised by an
 * adapter, but the harness must report them as provisional and the
 * system must treat any side effect they unlock as experimental.
 */
export type ProvisionalCapability =
  | 'field.capabilities.read'
  | 'field.capabilities.write'
  | 'deploy.receipt';

export type AnyCapability = AdapterCapability | ProvisionalCapability;

/**
 * Read-only discovery result. The adapter answers two questions:
 *   1. what capabilities does this host implementation support, and
 *   2. for each binding, can it be activated in this environment.
 *
 * Discovery never mutates host state and never pre-allocates any
 * resource beyond what the host implementation already holds.
 */
export interface AdapterDiscovery {
  readonly adapterId: AdapterId;
  readonly contract: AdapterContractVersion;
  /** Frozen capabilities the host implementation reliably supports. */
  readonly frozenCapabilities: readonly AdapterCapability[];
  /**
   * Provisional capabilities the host implementation supports. The
   * frozen core does not require any of these; their presence enables
   * host-specific extensions, never governance authority.
   */
  readonly provisionalCapabilities: readonly ProvisionalCapability[];
  /**
   * Per-binding activation candidates. An empty `issues` array means
   * the binding is unambiguous and may proceed to activation. A non-
   * empty `issues` array means the harness MUST refuse activation.
   */
  readonly candidates: readonly AdapterDiscoveryCandidate[];
}

export interface AdapterDiscoveryCandidate {
  readonly bindingId: string;
  readonly tenantId: string;
  readonly environment: 'staging' | 'production';
  /** Human-readable issues, e.g. "ambiguous canonicalSource". */
  readonly issues: readonly string[];
  /** Subset of capabilities relevant to this specific binding. */
  readonly capabilities: readonly AnyCapability[];
}

// --------------------------------------------------------------------
// Activation
// --------------------------------------------------------------------

/**
 * Result of activation. The adapter has confirmed it can serve this
 * binding in this environment with no ambiguity. The harness requires
 * `ok === true` to consider the activation complete.
 */
export interface AdapterActivation {
  readonly adapterId: AdapterId;
  readonly bindingId: string;
  readonly tenantId: string;
  readonly environment: 'staging' | 'production';
  readonly ok: boolean;
  /** Human-readable refusal reasons. Empty when `ok === true`. */
  readonly refusalReasons: readonly string[];
  /** Capabilities the activation actually enabled for this binding. */
  readonly enabledCapabilities: readonly AnyCapability[];
  /**
   * The regeneration contract the adapter is bound to. Even when
   * `ok === false`, this reflects the contract the adapter would have
   * used; the harness inspects it for ambiguity checks.
   */
  readonly contract: AdapterActivationContract;
}

export interface AdapterActivationContract {
  readonly aliasPath: string;
  readonly aliasTargets: readonly string[];
  readonly mode: RegenerationMode;
  readonly canonicalRepoPath: string;
}

// --------------------------------------------------------------------
// Reconciliation (idempotent drift check, no writes)
// --------------------------------------------------------------------

/**
 * Reconcile compares the canonical source against the served/derived
 * artifacts and reports whether they are in sync. Reconcile MUST NOT
 * mutate host state. The receipt is the only thing it returns.
 */
export interface AdapterReconcileReceipt {
  readonly adapterId: AdapterId;
  readonly bindingId: string;
  readonly tenantId: string;
  readonly environment: 'staging' | 'production';
  readonly observedAt: Iso8601;
  /** True iff every derived artifact matches the canonical state. */
  readonly inSync: boolean;
  /**
   * Per-derived-artifact drift entries. Each entry describes one
   * artifact whose current hash differs from the hash the binding
   * declared. Reconcile is observational; the adapter never attempts
   * to repair drift from this call.
   */
  readonly drift: readonly AdapterDriftEntry[];
}

export interface AdapterDriftEntry {
  readonly repoPath: string;
  readonly declaredHash: Sha256Hex;
  readonly observedHash: Sha256Hex;
}

// --------------------------------------------------------------------
// Apply (canonical-only write intent)
// --------------------------------------------------------------------

/**
 * The intent of a canonical write. Adapters accept a `CanonicalWrite`
 * and either materialise the change or refuse it. The frozen rule is
 * that `target.repoPath` MUST be the canonical source path; any request
 * whose target is a derived artifact path or an alias path is refused
 * before any host work happens.
 */
export interface CanonicalWrite {
  readonly adapterId: AdapterId;
  readonly bindingId: string;
  readonly tenantId: string;
  readonly environment: 'staging' | 'production';
  readonly target: CanonicalWriteTarget;
  /** Bytes the adapter is asked to materialise. Adapters may stream. */
  readonly bytes: AdapterWritePayload;
  /** The actor under whose authority the write happens. */
  readonly actor: Identity;
  /** Optional content hash captured by the host. */
  readonly contentHash?: Sha256Hex;
}

export interface CanonicalWriteTarget {
  /** Repository-relative POSIX path of the canonical source. */
  readonly repoPath: string;
  /**
   * The regeneration contract the adapter must obey. The target path
   * MUST NOT be a derived artifact and MUST NOT be the alias path; the
   * harness rejects either case before reaching the adapter.
   */
  readonly contract: AdapterActivationContract;
}

export type AdapterWritePayload =
  | { readonly kind: 'utf8'; readonly text: string }
  | { readonly kind: 'base64'; readonly data: string };

/**
 * Receipt of a successful canonical write. Adapters return this when
 * the canonical source has been materialised and the regeneration
 * contract has been followed. The receipt is what the system audits;
 * the adapter never returns authority decisions from this call.
 */
export interface AdapterApplyReceipt {
  readonly adapterId: AdapterId;
  readonly bindingId: string;
  readonly tenantId: string;
  readonly environment: 'staging' | 'production';
  readonly canonicalRepoPath: string;
  readonly canonicalHash: Sha256Hex;
  readonly appliedAt: Iso8601;
  readonly actor: Identity;
  /**
   * Snapshot of the regeneration contract that was applied. Adapters
   * MUST echo the contract they were given so the system can audit the
   * mode and target list.
   */
  readonly contract: AdapterActivationContract;
}

// --------------------------------------------------------------------
// Adapter interface
// --------------------------------------------------------------------

/**
 * The single adapter interface. Every host implementation satisfies
 * the same shape; product-specific behaviour lives in the
 * implementation, not in the contract. The harness treats any
 * deviation as a contract failure.
 */
export interface Adapter {
  readonly id: AdapterId;
  readonly contract: AdapterContractVersion;
  /** Read-only capability advertisement. */
  discover(input: DiscoverInput): Promise<AdapterDiscovery>;
  /**
   * Activate a binding. The harness MUST refuse any candidate that
   * `discover` reported as ambiguous.
   */
  activate(input: ActivateInput): Promise<AdapterActivation>;
  /** Idempotent drift check; must not mutate host state. */
  reconcile(input: ReconcileInput): Promise<AdapterReconcileReceipt>;
  /**
   * Canonical-only write. Adapters MUST refuse any write whose
   * target is a derived artifact or the alias path.
   */
  apply(input: CanonicalWrite): Promise<AdapterApplyReceipt>;
}

export interface DiscoverInput {
  readonly tenantId: string;
  readonly environment: 'staging' | 'production';
  readonly bindings: readonly RegionBinding[];
}

export interface ActivateInput {
  readonly binding: RegionBinding;
}

export interface ReconcileInput {
  readonly binding: RegionBinding;
}

// --------------------------------------------------------------------
// Provisional extensions (1.0-beta/RC)
// --------------------------------------------------------------------

/**
 * Per-field capability gating, a host-specific projection. PROVISIONAL.
 *
 * The closed value set is:
 *   - `read_only`: the field is exposed for display but cannot be
 *     edited through the authoring surface.
 *   - `coordinator_gated`: edits are gated by a host-specific
 *     coordinator; the system only forwards the intent.
 *   - `free_edit`: edits flow through the canonical write path with
 *     no additional host coordination.
 *
 * The frozen core does not interpret these values. The system reads
 * the value to choose the entry point; the adapter enforces the
 * enforcement. Marked provisional; breaking changes before 1.0 stable
 * are allowed inside the `1.0.0` major.
 */
export type FieldCapabilityValue = 'read_only' | 'coordinator_gated' | 'free_edit';

export interface FieldCapability {
  readonly field: string;
  readonly capability: FieldCapabilityValue;
  /**
   * Optional human-readable note the host attaches to the capability
   * (e.g. which coordinator must approve). Treated as opaque by the
   * frozen core.
   */
  readonly note?: string;
}

/**
 * A snapshot of the field capabilities the adapter advertises for a
 * binding. PROVISIONAL. Adapters that do not support this extension
 * MUST omit it; the system treats its absence as "no host-specific
 * gating".
 */
export interface FieldCapabilitiesSnapshot {
  readonly adapterId: AdapterId;
  readonly bindingId: string;
  readonly tenantId: string;
  readonly environment: 'staging' | 'production';
  readonly observedAt: Iso8601;
  readonly fields: readonly FieldCapability[];
}

/**
 * Host-specific deploy capability. PROVISIONAL.
 *
 * Some hosts need to push canonical writes through an extra
 * integration (a build pipeline, a CDN purge, a marketing-system
 * notification). The capability is purely advisory: the system owns
 * approve / publish / rollback, and an adapter that exposes this
 * capability MUST NOT use it to claim authority over those actions.
 */
export type DeployCapabilityKind =
  | 'cdn.purge'
  | 'search.reindex'
  | 'marketing.notify'
  | 'cache.invalidate';

export interface DeployCapability {
  readonly adapterId: AdapterId;
  readonly bindingId: string;
  readonly tenantId: string;
  readonly environment: 'staging' | 'production';
  readonly kind: DeployCapabilityKind;
  /**
   * Whether the capability is enabled in this environment. Disabled
   * capabilities are still advertised so the system can reason about
   * parity, but they are no-ops.
   */
  readonly enabled: boolean;
  /**
   * Optional opaque host-side identifier of the integration
   * (e.g. zone id, queue name). Treated as opaque by the frozen core.
   */
  readonly target?: string;
}

// --------------------------------------------------------------------
// Error surface
// --------------------------------------------------------------------

/**
 * Closed union of refusal codes the contract can produce. Callers
 * pattern-match on `code`; `message` is for humans only. The closed
 * union is the machine-readable contract.
 */
export const ADAPTER_REFUSAL_CODES = [
  'E_AMBIGUOUS_BINDING',
  'E_DERIVED_WRITE_FORBIDDEN',
  'E_ALIAS_WRITE_FORBIDDEN',
  'E_UNSUPPORTED_CAPABILITY',
  'E_CONTRACT_VERSION_MISMATCH',
  'E_PROVISIONAL_OUT_OF_SCOPE',
  'E_AUTHORITY_FORBIDDEN',
  'E_BINDING_NOT_FOUND',
  'E_ENVIRONMENT_MISMATCH',
] as const;
Object.freeze(ADAPTER_REFUSAL_CODES);

export type AdapterRefusalCode = (typeof ADAPTER_REFUSAL_CODES)[number];

export class AdapterContractError extends Error {
  readonly code: AdapterRefusalCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: AdapterRefusalCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'AdapterContractError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// --------------------------------------------------------------------
// Read-only helpers re-exported for adapters
// --------------------------------------------------------------------

export {
  assertRegionBinding,
  type AliasSymlinkContract as FrozenAliasSymlinkContract,
} from '@cms/core';

// --------------------------------------------------------------------
// Re-exports: conformance surface (re-exported for adapter authors)
// --------------------------------------------------------------------

export type {
  ConformanceCheck,
  ConformanceReport,
  ConformanceFixtures,
} from './conformance.js';
export { runConformance, makeConformanceFixtures } from './conformance.js';
