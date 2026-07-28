/**
 * `@cms/adapter-cerafica` — the adapter implementation for the
 * cerafica host repository.
 *
 * The adapter implements the frozen `@cms/adapter-sdk` contract:
 *   - `discover` reads the manifest at `website/cms-regions.json` and
 *     advertises the closed capability set.
 *   - `activate` resolves the products symlink (`website/data/products.json`)
 *     via the real filesystem (`lstat`, `readlink`, `realpath`) and
 *     refuses activation when the alias is missing, broken, retargeted,
 *     escaping, looped, or replaced by a regular file.
 *   - `reconcile` re-runs the alias verification and the canonical
 *     hash check; it never writes.
 *   - `apply` writes the canonical `inventory/products.json` and
 *     refuses any write whose target is the alias path or a derived
 *     artifact.
 *
 * In addition, the adapter exposes the provisional extensions
 * (1.0.0-rc.1):
 *   - `fieldCapabilities` snapshots the closed mapping from product
 *     fields to `coordinator_gated` (per the manifest, every commerce
 *     field is `readonly`; the adapter does not expose a free-edit
 *     path).
 *   - `deployCapabilitySnapshot` returns the SDK-shaped
 *     `DeployCapability`.
 *
 * Commerce gating is enforced in `apply`: the adapter refuses any
 * canonical write that touches a stripe/payment/price/availability/
 * one_of_one field unless the system has marked the binding as the
 * coordinator. The default coordinator is `readonly`; any deviation
 * is a programmer error.
 *
 * Journal writes are never exposed. The adapter answers
 * `journalWrite()` with a refusal.
 *
 * Approve/publish/rollback authority is system-side; the adapter
 * never approves, never publishes, and never decides to roll back.
 * The deploy capability is advisory and operates against an injected
 * `GitHubPagesDeployClient`. There is no network fallback.
 *
 * This module consolidates the adapter's manifest loader, deploy
 * capability, and internal error types. The previously-separate
 * `deploy.ts`, `errors.ts`, and `manifest.ts` modules are removed
 * once this module is in place.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  AdapterContractError,
  ADAPTER_SDK_VERSION,
  brandAdapterId,
  type Adapter,
  type AdapterActivation,
  type AdapterActivationContract,
  type AdapterApplyReceipt,
  type AdapterCapability,
  type AdapterDiscovery,
  type AdapterDiscoveryCandidate,
  type AdapterDriftEntry,
  type AdapterId,
  type AdapterReconcileReceipt,
  type AdapterWritePayload,
  type AnyCapability,
  type CanonicalWrite,
  type DeployCapability,
  type DiscoverInput,
  type FieldCapabilitiesSnapshot,
  type FieldCapability,
  type ProvisionalCapability,
} from '@cms/adapter-sdk';
import {
  brandIso8601,
  brandSha256Hex,
  isServiceIdentity,
  type Identity,
  type Iso8601,
  type RegionBinding,
  type Sha256Hex,
} from '@cms/core';

import {
  verifyAlias,
  type AliasVerification,
} from './symlink.js';

// --------------------------------------------------------------------
// Internal error types
// --------------------------------------------------------------------

export class ManifestValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`manifest validation failed at ${field}: ${message}`);
    this.name = 'ManifestValidationError';
    this.field = field;
  }
}

export class AdapterActivationContractMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterActivationContractMismatchError';
  }
}

export class JournalWriteUnsupportedError extends Error {
  constructor() {
    super('journal writes are unsupported by this adapter');
    this.name = 'JournalWriteUnsupportedError';
  }
}

export class RollbackApprovalHashMismatchError extends Error {
    constructor(path: string, expectedHash: Sha256Hex, observedHash: Sha256Hex) {
        super(
      `rollback cannot proceed: approval bytes at ${path} hash to ${observedHash}, expected ${expectedHash}`,
    );
        this.name = 'RollbackApprovalHashMismatchError';
    }
}

// --------------------------------------------------------------------
// Manifest contract (locked shape: cms-regions/v1, version 1)
// --------------------------------------------------------------------

export interface CeraficaManifest {
  readonly version: 1;
  readonly manifestSchema: 'cms-regions/v1';
  readonly host: {
    readonly repo: 'cerafica';
    readonly deployMode: 'github_pages';
    readonly canonicalProductPath: string;
    readonly servedProductPath: string;
  };
  readonly regeneration: {
    readonly mode: 'alias_symlink';
    readonly source: string;
    readonly target: string;
    readonly readonly: true;
  };
  readonly capabilities: {
    readonly journal: {
      readonly provider: string;
      readonly mode: 'readonly';
      readonly source: 'discovered';
      readonly module: string;
    };
    readonly fields: {
      readonly stripe: { readonly mode: 'readonly' };
      readonly payment: { readonly mode: 'readonly' };
      readonly price: { readonly mode: 'readonly' };
      readonly availability: { readonly mode: 'readonly' };
      readonly one_of_one: { readonly mode: 'readonly' };
    };
    readonly coordinator: 'readonly';
    readonly failClosed: true;
  };
  readonly localization: {
    readonly altPolicy: {
      readonly mode: 'peer-required';
      readonly languages: readonly ['en', 'es'];
      readonly hostCopyLanguage: 'en';
    };
  };
  readonly anchors: {
    readonly home: {
      readonly heroText: string;
      readonly featuredImage: {
        readonly id: string;
        readonly alt: string;
      };
      readonly sections: {
        readonly container: string;
        readonly section: string;
      };
    };
    readonly shop: {
      readonly productCollection: {
        readonly container: string;
      };
    };
  };
}

/**
 * The single immutable source of truth for the host's commerce
 * contract. Every advertised `CommerceField` label resolves to the
 * concrete Cerafica product JSON key(s) that the host actually
 * carries. The advertised field set (manifest `capabilities.fields`,
 * `fieldCapabilities()` snapshot) and the enforcement iteration in
 * `enforceCommerceFieldGating` are both derived from this mapping;
 * there is no divergent schema-key list anywhere else in the
 * adapter. The host schema is authoritative; this mapping only
 * names the slice of the host schema the adapter gates.
 */
type CommerceFieldHostKey = 'stripe_payment_link' | 'price' | 'available' | 'coming_soon' | 'one_of_one';

const COMMERCE_FIELD_HOST_KEYS: {
  readonly stripe: readonly ['stripe_payment_link'];
  readonly payment: readonly ['stripe_payment_link'];
  readonly price: readonly ['price'];
  readonly availability: readonly ['available', 'coming_soon'];
  readonly one_of_one: readonly ['one_of_one'];
} = Object.freeze({
  stripe: Object.freeze(['stripe_payment_link']) as readonly ['stripe_payment_link'],
  payment: Object.freeze(['stripe_payment_link']) as readonly ['stripe_payment_link'],
  price: Object.freeze(['price']) as readonly ['price'],
  availability: Object.freeze(['available', 'coming_soon']) as readonly ['available', 'coming_soon'],
  one_of_one: Object.freeze(['one_of_one']) as readonly ['one_of_one'],
});

type CommerceField = keyof typeof COMMERCE_FIELD_HOST_KEYS;

/**
 * Advertised commerce field labels in stable order. Derived from the
 * mapping so the manifest validator, `fieldCapabilities()`, and
 * external callers all see the same closed set without a second
 * hardcoded list.
 */
const COMMERCE_FIELDS: readonly CommerceField[] = Object.freeze([
  'stripe',
  'payment',
  'price',
  'availability',
  'one_of_one',
] as const satisfies readonly CommerceField[]);

/**
 * Host product JSON keys that the adapter enforces as
 * coordinator-gated. Derived from `COMMERCE_FIELD_HOST_KEYS`: each
 * mapped tuple contributes its keys, and the result is
 * deduplicated (e.g. `stripe` and `payment` both resolve to
 * `stripe_payment_link`) while preserving first-seen order so
 * refusal messages stay stable across runs.
 */
const ENFORCED_HOST_KEYS: readonly CommerceFieldHostKey[] = (() => {
  const seen = new Set<CommerceFieldHostKey>();
  const ordered: CommerceFieldHostKey[] = [];
  for (const label of COMMERCE_FIELDS) {
    for (const key of COMMERCE_FIELD_HOST_KEYS[label]) {
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(key);
    }
  }
  return Object.freeze(ordered);
})();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: object, keys: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) return false;
  }
  return true;
}

function assertReadonlyLiteral(value: unknown, field: string): void {
  if (value !== 'readonly') {
    throw new ManifestValidationError(field, `expected "readonly", got ${JSON.stringify(value)}`);
  }
}

function assertFieldCapabilityEntry(value: unknown, field: string): void {
  if (!isObject(value)) {
    throw new ManifestValidationError(field, 'field capability entry must be an object');
  }
  const keys = new Set(['mode']);
  if (!hasOnlyKeys(value, keys)) {
    throw new ManifestValidationError(field, 'field capability entry has unknown keys');
  }
  assertReadonlyLiteral(value['mode'], `${field}.mode`);
}

function assertCapabilities(value: unknown): void {
  if (!isObject(value)) {
    throw new ManifestValidationError('capabilities', 'must be an object');
  }
  const top = new Set(['journal', 'fields', 'coordinator', 'failClosed']);
  if (!hasOnlyKeys(value, top)) {
    throw new ManifestValidationError('capabilities', 'has unknown keys');
  }
  const journal = value['journal'];
  if (!isObject(journal)) {
    throw new ManifestValidationError('capabilities.journal', 'must be an object');
  }
  const journalKeys = new Set(['provider', 'mode', 'source', 'module']);
  if (!hasOnlyKeys(journal, journalKeys)) {
    throw new ManifestValidationError('capabilities.journal', 'has unknown keys');
  }
  for (const k of ['provider', 'mode', 'source', 'module']) {
    if (typeof journal[k] !== 'string' || (journal[k] as string).length === 0) {
      throw new ManifestValidationError(
        `capabilities.journal.${k}`,
        'must be a non-empty string',
      );
    }
  }
  assertReadonlyLiteral(journal['mode'], 'capabilities.journal.mode');
  if (journal['source'] !== 'discovered') {
    throw new ManifestValidationError(
      'capabilities.journal.source',
      `expected "discovered", got ${JSON.stringify(journal['source'])}`,
    );
  }

  const fields = value['fields'];
  if (!isObject(fields)) {
    throw new ManifestValidationError('capabilities.fields', 'must be an object');
  }
  const fieldsKeys = new Set<CommerceField>(COMMERCE_FIELDS);
  if (!hasOnlyKeys(fields, fieldsKeys)) {
    throw new ManifestValidationError('capabilities.fields', 'has unknown keys');
  }
  for (const f of COMMERCE_FIELDS) {
    assertFieldCapabilityEntry(fields[f], `capabilities.fields.${f}`);
  }

  assertReadonlyLiteral(value['coordinator'], 'capabilities.coordinator');
  if (value['failClosed'] !== true) {
    throw new ManifestValidationError(
      'capabilities.failClosed',
      `expected boolean true, got ${JSON.stringify(value['failClosed'])}`,
    );
  }
}

function assertLocalization(value: unknown): void {
  if (!isObject(value)) {
    throw new ManifestValidationError('localization', 'must be an object');
  }
  const top = new Set(['altPolicy']);
  if (!hasOnlyKeys(value, top)) {
    throw new ManifestValidationError('localization', 'has unknown keys');
  }
  const alt = value['altPolicy'];
  if (!isObject(alt)) {
    throw new ManifestValidationError('localization.altPolicy', 'must be an object');
  }
  const altKeys = new Set(['mode', 'languages', 'hostCopyLanguage']);
  if (!hasOnlyKeys(alt, altKeys)) {
    throw new ManifestValidationError('localization.altPolicy', 'has unknown keys');
  }
  if (alt['mode'] !== 'peer-required') {
    throw new ManifestValidationError(
      'localization.altPolicy.mode',
      `expected "peer-required", got ${JSON.stringify(alt['mode'])}`,
    );
  }
  const languages = alt['languages'];
  if (
    !Array.isArray(languages) ||
    languages.length !== 2 ||
    languages[0] !== 'en' ||
    languages[1] !== 'es'
  ) {
    throw new ManifestValidationError(
      'localization.altPolicy.languages',
      'must be exactly ["en", "es"]',
    );
  }
  if (alt['hostCopyLanguage'] !== 'en') {
    throw new ManifestValidationError(
      'localization.altPolicy.hostCopyLanguage',
      `expected "en", got ${JSON.stringify(alt['hostCopyLanguage'])}`,
    );
  }
}

function assertAnchors(value: unknown): void {
  if (!isObject(value)) {
    throw new ManifestValidationError('anchors', 'must be an object');
  }
  const top = new Set(['home', 'shop']);
  if (!hasOnlyKeys(value, top)) {
    throw new ManifestValidationError('anchors', 'has unknown keys');
  }

  const home = value['home'];
  if (!isObject(home)) {
    throw new ManifestValidationError('anchors.home', 'must be an object');
  }
  const homeKeys = new Set(['heroText', 'featuredImage', 'sections']);
  if (!hasOnlyKeys(home, homeKeys)) {
    throw new ManifestValidationError('anchors.home', 'has unknown keys');
  }
  if (typeof home['heroText'] !== 'string' || home['heroText'].length === 0) {
    throw new ManifestValidationError('anchors.home.heroText', 'must be a non-empty string');
  }
  const featured = home['featuredImage'];
  if (!isObject(featured)) {
    throw new ManifestValidationError('anchors.home.featuredImage', 'must be an object');
  }
  const featuredKeys = new Set(['id', 'alt']);
  if (!hasOnlyKeys(featured, featuredKeys)) {
    throw new ManifestValidationError('anchors.home.featuredImage', 'has unknown keys');
  }
  for (const k of ['id', 'alt']) {
    if (typeof featured[k] !== 'string' || (featured[k] as string).length === 0) {
      throw new ManifestValidationError(
        `anchors.home.featuredImage.${k}`,
        'must be a non-empty string',
      );
    }
  }
  const sections = home['sections'];
  if (!isObject(sections)) {
    throw new ManifestValidationError('anchors.home.sections', 'must be an object');
  }
  const sectionKeys = new Set(['container', 'section']);
  if (!hasOnlyKeys(sections, sectionKeys)) {
    throw new ManifestValidationError('anchors.home.sections', 'has unknown keys');
  }
  for (const k of ['container', 'section']) {
    if (typeof sections[k] !== 'string' || (sections[k] as string).length === 0) {
      throw new ManifestValidationError(
        `anchors.home.sections.${k}`,
        'must be a non-empty string',
      );
    }
  }

  const shop = value['shop'];
  if (!isObject(shop)) {
    throw new ManifestValidationError('anchors.shop', 'must be an object');
  }
  const shopKeys = new Set(['productCollection']);
  if (!hasOnlyKeys(shop, shopKeys)) {
    throw new ManifestValidationError('anchors.shop', 'has unknown keys');
  }
  const productCollection = shop['productCollection'];
  if (!isObject(productCollection)) {
    throw new ManifestValidationError('anchors.shop.productCollection', 'must be an object');
  }
  const pcKeys = new Set(['container']);
  if (!hasOnlyKeys(productCollection, pcKeys)) {
    throw new ManifestValidationError('anchors.shop.productCollection', 'has unknown keys');
  }
  if (
    typeof productCollection['container'] !== 'string' ||
    (productCollection['container'] as string).length === 0
  ) {
    throw new ManifestValidationError(
      'anchors.shop.productCollection.container',
      'must be a non-empty string',
    );
  }
}

function assertManifestShape(value: unknown): CeraficaManifest {
  if (!isObject(value)) {
    throw new ManifestValidationError('$', 'manifest must be a JSON object');
  }
  const topKeys = new Set([
    'version',
    'manifestSchema',
    'host',
    'regeneration',
    'capabilities',
    'localization',
    'anchors',
  ]);
  if (!hasOnlyKeys(value, topKeys)) {
    throw new ManifestValidationError(
      '$',
      `manifest has unknown keys: ${Object.keys(value).filter((k) => !topKeys.has(k)).join(', ')}`,
    );
  }
  if (value['version'] !== 1) {
    throw new ManifestValidationError(
      'version',
      `expected 1, got ${JSON.stringify(value['version'])}`,
    );
  }
  if (value['manifestSchema'] !== 'cms-regions/v1') {
    throw new ManifestValidationError(
      'manifestSchema',
      `expected "cms-regions/v1", got ${JSON.stringify(value['manifestSchema'])}`,
    );
  }

  const host = value['host'];
  if (!isObject(host)) {
    throw new ManifestValidationError('host', 'must be an object');
  }
  const hostKeys = new Set(['repo', 'deployMode', 'canonicalProductPath', 'servedProductPath']);
  if (!hasOnlyKeys(host, hostKeys)) {
    throw new ManifestValidationError('host', 'has unknown keys');
  }
  if (host['repo'] !== 'cerafica') {
    throw new ManifestValidationError(
      'host.repo',
      `expected "cerafica", got ${JSON.stringify(host['repo'])}`,
    );
  }
  if (host['deployMode'] !== 'github_pages') {
    throw new ManifestValidationError(
      'host.deployMode',
      `expected "github_pages", got ${JSON.stringify(host['deployMode'])}`,
    );
  }
  for (const k of ['canonicalProductPath', 'servedProductPath']) {
    if (typeof host[k] !== 'string' || (host[k] as string).length === 0) {
      throw new ManifestValidationError(`host.${k}`, 'must be a non-empty string');
    }
  }

  const regeneration = value['regeneration'];
  if (!isObject(regeneration)) {
    throw new ManifestValidationError('regeneration', 'must be an object');
  }
  const regenKeys = new Set(['mode', 'source', 'target', 'readonly']);
  if (!hasOnlyKeys(regeneration, regenKeys)) {
    throw new ManifestValidationError('regeneration', 'has unknown keys');
  }
  if (regeneration['mode'] !== 'alias_symlink') {
    throw new ManifestValidationError(
      'regeneration.mode',
      `expected "alias_symlink", got ${JSON.stringify(regeneration['mode'])}`,
    );
  }
  for (const k of ['source', 'target']) {
    if (typeof regeneration[k] !== 'string' || (regeneration[k] as string).length === 0) {
      throw new ManifestValidationError(`regeneration.${k}`, 'must be a non-empty string');
    }
  }
  if (regeneration['readonly'] !== true) {
    throw new ManifestValidationError(
      'regeneration.readonly',
      `expected boolean true, got ${JSON.stringify(regeneration['readonly'])}`,
    );
  }

  assertCapabilities(value['capabilities']);
  assertLocalization(value['localization']);
  assertAnchors(value['anchors']);

  return value as unknown as CeraficaManifest;
}

export function parseManifest(value: unknown): CeraficaManifest {
  return assertManifestShape(value);
}

export async function loadManifest(path: string): Promise<CeraficaManifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterContractError(
      'E_BINDING_NOT_FOUND',
      `could not read manifest at ${path}: ${message}`,
      { manifestPath: path },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterContractError(
      'E_BINDING_NOT_FOUND',
      `manifest at ${path} is not valid JSON: ${message}`,
      { manifestPath: path },
    );
  }
  return parseManifest(parsed);
}

export interface ManifestActivationContract {
  readonly aliasPath: string;
  readonly aliasTargets: readonly [string];
  readonly canonicalRepoPath: string;
  readonly mode: 'alias_symlink';
}

export function manifestToActivationContract(
  manifest: CeraficaManifest,
): ManifestActivationContract {
  if (manifest.regeneration.mode !== 'alias_symlink') {
    throw new AdapterActivationContractMismatchError(
      `unsupported regeneration mode: ${manifest.regeneration.mode}`,
    );
  }
  return {
    aliasPath: manifest.host.servedProductPath,
    aliasTargets: [manifest.regeneration.target] as const,
    canonicalRepoPath: manifest.regeneration.source,
    mode: 'alias_symlink' as const,
  };
}

export function isFieldReadOnly(manifest: CeraficaManifest, field: CommerceField): boolean {
  const entry = manifest.capabilities.fields[field];
  return entry.mode === 'readonly';
}

// --------------------------------------------------------------------
// Deploy capability (injected client, no network fallback)
// --------------------------------------------------------------------

export interface GitHubPagesDeployClient {
  /**
   * Trigger a deploy. The implementation MUST return a promise that
   * resolves to a receipt (or rejects with an error). The adapter
   * does not await this promise at the apply boundary.
   */
  triggerDeploy(input: GitHubPagesDeployInput): Promise<GitHubPagesDeployReceipt>;
  /**
   * Query the live status of a deploy. The implementation is
   * free to cache; the adapter never calls this in a hot path.
   */
  getDeployStatus(input: { readonly deployReceiptId: string }): Promise<GitHubPagesDeployReceipt>;
}

export interface GitHubPagesDeployInput {
  readonly repo: string;
  readonly environment: 'staging' | 'production';
  readonly commitSha: string;
  readonly actor: Identity;
}

export interface GitHubPagesDeployReceipt {
  readonly deployReceiptId: string;
  readonly status: GitHubPagesDeployStatus;
  readonly startedAt: Iso8601;
  readonly finishedAt: Iso8601 | null;
  readonly url: string | null;
  readonly message: string | null;
}

export type GitHubPagesDeployStatus =
  | 'queued'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type DeployCapabilityState =
  | { readonly kind: 'canonical_written' }
  | { readonly kind: 'awaiting_receipt'; readonly deployReceiptId: string }
  | {
      readonly kind: 'succeeded';
      readonly deployReceiptId: string;
      readonly finishedAt: Iso8601;
      readonly url: string;
    }
  | {
      readonly kind: 'failed';
      readonly deployReceiptId: string;
      readonly finishedAt: Iso8601;
      readonly message: string;
    };

export interface CeraficaDeployCapability {
  trigger(input: DeployTriggerInput): Promise<DeployCapabilityState>;
  reconcile(): Promise<DeployCapabilityState>;
  rollback(input: RollbackInput): Promise<DeployCapabilityState>;
}

export interface DeployTriggerInput {
  readonly repo: string;
  readonly environment: 'staging' | 'production';
  readonly commitSha: string;
  readonly actor: Identity;
}

export interface RollbackInput {
  readonly approvalBytesPath: string;
  readonly canonicalPath: string;
  readonly approvalHash: Sha256Hex;
}


/**
 * Optional safety check installed on the deploy capability. Production
 * wiring plugs the canonical commerce gating into rollback so the
 * rollback can never bypass coordinator-gated authority. The hook is
 * awaited before the rollback writer commits any bytes; any throw
 * (typically an `AdapterContractError`) propagates and the writer is
 * not invoked.
 */
export type RollbackSafetyCheck = (
  bytes: Buffer,
  canonicalAbs: string,
) => Promise<void>;

export interface RollbackSafetyOptions {
  /**
   * Repository root used for canonical-path confinement. When
   * provided, rollback refuses a `canonicalPath` that resolves
   * outside the root or to a non-canonical source location.
   * Production wiring passes the adapter's `repoRoot`.
   */
  readonly repoRoot?: string;
  /**
   * Commerce-gating hook invoked against the rollback bytes before
   * the rollback writer is asked to commit them. Production wiring
   * passes a closure that delegates to the same gating the apply
   * path enforces.
   */
  readonly safetyCheck?: RollbackSafetyCheck;
}

export interface RollbackWriter {
  read(path: string): Promise<Buffer>;
  write(path: string, bytes: Buffer): Promise<void>;
}

export function createGitHubPagesDeployCapability(args: {
  readonly client: GitHubPagesDeployClient;
  readonly rollbackWriter: RollbackWriter;
  readonly rollbackSafety?: RollbackSafetyOptions;
}): CeraficaDeployCapability {
  type Pending = {
    readonly deployReceiptId: string;
    readonly startedAt: Iso8601;
  };

  let pending: Pending | null = null;
  let terminal: DeployCapabilityState | null = null;
  const safety = args.rollbackSafety;

  /**
   * Same lexical shape as `joinInsideRepo`: return true when `target`
   * (after lexical normalisation) is strictly under `repoRoot`. Used
   * by rollback to refuse a canonical path that escapes the host
   * repo.
   */
  function isConfined(target: string, repoRoot: string): boolean {
    const rel = relative(repoRoot, target);
    if (rel === '') return true;
    if (rel === '..') return false;
    if (rel.startsWith(`..${sep}`)) return false;
    return true;
  }

  return Object.freeze({
    async trigger(input: DeployTriggerInput): Promise<DeployCapabilityState> {
      terminal = null;
      pending = null;

      // Await the injected trigger receipt synchronously so the
      // caller's `canonical_written` return is backed by an
      // initiation receipt. The trigger is fail-closed: a client
      // rejection propagates to the caller instead of being
      // observed later via `reconcile`.
      let receipt: GitHubPagesDeployReceipt;
      try {
        receipt = await args.client.triggerDeploy({
          repo: input.repo,
          environment: input.environment,
          commitSha: input.commitSha,
          actor: input.actor,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new AdapterContractError(
          'E_AMBIGUOUS_BINDING',
          `deploy trigger rejected: ${message}`,
          { repo: input.repo, environment: input.environment, commitSha: input.commitSha },
        );
      }

      // The receipt may already be terminal at trigger time (a
      // client-side fail-fast, or a successful receipt returned
      // synchronously). When terminal, the caller MUST observe the
      // actual terminal state directly so a `failed`/`cancelled`
      // cannot be hidden behind a `canonical_written` return.
      // `receiptToState` throws on a malformed terminal receipt;
      // the throw propagates and leaves no `pending`/`terminal`
      // state, so a subsequent `reconcile` cannot resurrect the
      // malformed receipt.
      if (
        receipt.status === 'succeeded' ||
        receipt.status === 'failed' ||
        receipt.status === 'cancelled'
      ) {
        const observed = receiptToState(receipt);
        terminal = observed;
        pending = null;
        return observed;
      }

      pending = {
        deployReceiptId: receipt.deployReceiptId,
        startedAt: receipt.startedAt,
      };
      return { kind: 'canonical_written' };
    },

    async reconcile(): Promise<DeployCapabilityState> {
      if (terminal !== null) return terminal;
      if (pending === null) return { kind: 'canonical_written' };
      const receipt = await args.client.getDeployStatus({
        deployReceiptId: pending.deployReceiptId,
      });
      if (
        receipt.status === 'succeeded' ||
        receipt.status === 'failed' ||
        receipt.status === 'cancelled'
      ) {
        // A malformed terminal receipt observed during reconcile
        // throws via `receiptToState`; the throw propagates and
        // leaves no stale `pending` behind because the assignment
        // below only runs after a successful conversion.
        terminal = receiptToState(receipt);
        pending = null;
        return terminal;
      }
      return {
        kind: 'awaiting_receipt',
        deployReceiptId: pending.deployReceiptId,
      };
    },

    async rollback(input: RollbackInput): Promise<DeployCapabilityState> {
      // Repository confinement: when a repo root is configured,
      // refuse any canonical path that escapes it. The check mirrors
      // `joinInsideRepo` so the apply path and the rollback path
      // agree about what "inside the repository" means.
      if (safety?.repoRoot !== undefined) {
        const repoRootAbs = resolve(safety.repoRoot);
        const candidate = input.canonicalPath;
        const target = isAbsolute(candidate)
          ? candidate
          : resolve(repoRootAbs, candidate);
        if (!isAbsolute(target) || !isConfined(target, repoRootAbs)) {
          throw new AdapterContractError(
            'E_DERIVED_WRITE_FORBIDDEN',
            `rollback canonicalPath ${input.canonicalPath} escapes repository root`,
            { repoPath: input.canonicalPath, repoRoot: repoRootAbs },
          );
        }
        // Commerce-gating: the rollback bytes must satisfy the same
        // coordinator-gated authority the apply path enforces.
        // Invoking the safety hook before the writer commits keeps
        // the rollback from being a bypass hatch.
        if (safety.safetyCheck !== undefined) {
          const approvalBytes = await args.rollbackWriter.read(
            input.approvalBytesPath,
          );
          await safety.safetyCheck(approvalBytes, target);
        }
      }

      const bytes = await args.rollbackWriter.read(input.approvalBytesPath);
      const observedHash = brandSha256Hex(sha256HexOf(bytes));
      if (observedHash !== input.approvalHash) {
        throw new RollbackApprovalHashMismatchError(
          input.approvalBytesPath,
          input.approvalHash,
          observedHash,
        );
      }
      await args.rollbackWriter.write(input.canonicalPath, bytes);
      // Stale-deploy reset: a rollback returns the canonical state
      // to a known approved snapshot. Any pending/terminal receipt
      // from a prior deploy is no longer authoritative for the live
      // canonical, so reconcile MUST NOT report stale pre-rollback
      // status after the canonical has been reverted.
      pending = null;
      terminal = null;
      return { kind: 'canonical_written' };
    },
  });
}

function sha256HexOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function receiptToState(receipt: GitHubPagesDeployReceipt): DeployCapabilityState {
  if (receipt.status === 'succeeded') {
    if (receipt.finishedAt === null || receipt.url === null) {
      throw new AdapterContractError(
        'E_AMBIGUOUS_BINDING',
        'successful deploy receipt must include finishedAt and url',
        { deployReceiptId: receipt.deployReceiptId },
      );
    }
    return {
      kind: 'succeeded',
      deployReceiptId: receipt.deployReceiptId,
      finishedAt: brandIso8601(receipt.finishedAt),
      url: receipt.url,
    };
  }
  if (receipt.status === 'failed' || receipt.status === 'cancelled') {
    if (receipt.finishedAt === null || receipt.message === null) {
      throw new AdapterContractError(
        'E_AMBIGUOUS_BINDING',
        'failed deploy receipt must include finishedAt and message',
        { deployReceiptId: receipt.deployReceiptId, status: receipt.status },
      );
    }
    return {
      kind: 'failed',
      deployReceiptId: receipt.deployReceiptId,
      finishedAt: brandIso8601(receipt.finishedAt),
      message: receipt.message,
    };
  }
  return {
    kind: 'awaiting_receipt',
    deployReceiptId: receipt.deployReceiptId,
  };
}

// --------------------------------------------------------------------
// Adapter identity
// --------------------------------------------------------------------

export const CERAFICA_ADAPTER_ID: AdapterId = brandAdapterId('@cms/adapter-cerafica');

// --------------------------------------------------------------------
// Defaults
// --------------------------------------------------------------------

const DEFAULT_TENANT_ID = 'tenant-cerafica';
const DEFAULT_ENVIRONMENT: 'staging' = 'staging';
const DEFAULT_BINDING_ID = 'rb-cerafica-products';
const DEFAULT_CONTENT_TYPE = 'inventory/products';
const DEFAULT_LOCALE: 'en' = 'en';
const DEFAULT_GOVERNANCE_VERSION = 1;

const HUMAN_ACTOR: Identity = Object.freeze({
  id: 'cerafica-default-human',
  kind: 'actor',
  displayName: 'Cerafica Default Human',
  capabilities: Object.freeze(['canonical.write']),
});

const DEFAULT_ALIAS_REL_PATH = 'website/data/products.json';
const DEFAULT_CANONICAL_REL_PATH = 'inventory/products.json';
const DEFAULT_DECLARED_TARGET = '../../inventory/products.json';


// --------------------------------------------------------------------
// Adapter options
// --------------------------------------------------------------------

export interface CeraficaAdapterOptions {
  readonly repoRoot: string;
  readonly manifestPath: string;
  readonly deployClient: GitHubPagesDeployClient;
  readonly rollbackWriter: RollbackWriter;
  readonly tenantId?: string;
  readonly environment?: 'staging' | 'production';
  readonly locale?: 'en' | 'es';
}

// --------------------------------------------------------------------
// Internal state
// --------------------------------------------------------------------

interface AdapterState {
  manifest: CeraficaManifest;
  binding: RegionBinding;
  activation: AliasVerification | null;
  readonly deployCapability: CeraficaDeployCapability;
}

function buildBinding(args: {
  tenantId: string;
  environment: 'staging' | 'production';
  locale: 'en' | 'es';
  contract: ManifestActivationContract;
}) {
  return {
    id: DEFAULT_BINDING_ID,
    tenantId: args.tenantId,
    contentType: DEFAULT_CONTENT_TYPE,
    environment: args.environment,
    locale: args.locale,
    canonicalSource: {
      repoPath: args.contract.canonicalRepoPath,
      contentHash: brandSha256Hex('0'.repeat(64)),
      sizeBytes: 0,
    },
    derivedArtifacts: [
      {
        repoPath: args.contract.aliasPath,
        kind: 'manifest' as const,
        contentHash: brandSha256Hex('0'.repeat(64)),
        sizeBytes: 0,
      },
    ],
    regenerationContract: {
      mode: 'alias_symlink' as const,
      aliasPath: args.contract.aliasPath,
      aliasTargets: args.contract.aliasTargets,
    },
    governanceVersion: DEFAULT_GOVERNANCE_VERSION,
    createdAt: brandIso8601(new Date().toISOString()),
    createdBy: HUMAN_ACTOR,
  };
}

// --------------------------------------------------------------------
// Adapter factory
// --------------------------------------------------------------------

export async function createCeraficaAdapter(
  options: CeraficaAdapterOptions,
): Promise<CeraficaAdapter> {
  const manifest = await loadManifest(options.manifestPath);

  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const environment = options.environment ?? DEFAULT_ENVIRONMENT;
  const locale = options.locale ?? DEFAULT_LOCALE;

  const contractFields = manifestToActivationContract(manifest);
  const binding = buildBinding({
    tenantId,
    environment,
    locale,
    contract: contractFields,
  });

  const deployCapability = createGitHubPagesDeployCapability({
    client: options.deployClient,
    rollbackWriter: options.rollbackWriter,
    rollbackSafety: {
      repoRoot: options.repoRoot,
      // Run the same coordinator-gated commerce authority the apply
      // path enforces, so a rollback can never write bytes that
      // would normally be refused at the apply boundary.
      safetyCheck: async (bytes, _canonicalAbs) => {
        await enforceCommerceFieldGating({
          repoRoot: options.repoRoot,
          canonicalRelPath: contractFields.canonicalRepoPath,
          proposedBytes: bytes,
        });
      },
    },
  });

  const state: AdapterState = {
    manifest,
    binding,
    activation: null,
    deployCapability,
  };

  return new CeraficaAdapter(options, state);
}

// --------------------------------------------------------------------
// CeraficaAdapter
// --------------------------------------------------------------------

export class CeraficaAdapter implements Adapter {
  readonly id: AdapterId = CERAFICA_ADAPTER_ID;
  readonly contract = ADAPTER_SDK_VERSION;

  private readonly options: CeraficaAdapterOptions;
  private readonly state: AdapterState;

  constructor(options: CeraficaAdapterOptions, state: AdapterState) {
    this.options = options;
    this.state = state;
  }

  async discover(input: DiscoverInput): Promise<AdapterDiscovery> {
    const candidates: AdapterDiscoveryCandidate[] = input.bindings.map((binding) => {
      const issues = this.detectBindingIssues(binding);
      const capabilities: readonly AnyCapability[] = this.advertisedCapabilities(binding);
      return {
        bindingId: binding.id,
        tenantId: binding.tenantId,
        environment: binding.environment,
        issues,
        capabilities,
      };
    });

    return {
      adapterId: this.id,
      contract: this.contract,
      frozenCapabilities: this.frozenCapabilities(),
      provisionalCapabilities: this.provisionalCapabilities(),
      candidates,
    };
  }

  async activate(input: { readonly binding: RegionBinding }): Promise<AdapterActivation> {
    const issues = this.detectBindingIssues(input.binding);
    if (issues.length > 0) {
      return {
        adapterId: this.id,
        bindingId: input.binding.id,
        tenantId: input.binding.tenantId,
        environment: input.binding.environment,
        ok: false,
        refusalReasons: issues,
        enabledCapabilities: [],
        contract: this.activationContract(),
      };
    }

    const verification = await verifyAlias({
      repoRoot: this.options.repoRoot,
      aliasRelPath: this.state.manifest.host.servedProductPath,
      declaredTarget: this.state.manifest.regeneration.target,
    });

    if (!verification.ok) {
      return {
        adapterId: this.id,
        bindingId: input.binding.id,
        tenantId: input.binding.tenantId,
        environment: input.binding.environment,
        ok: false,
        refusalReasons: [`${verification.code}: ${verification.message}`],
        enabledCapabilities: [],
        contract: this.activationContract(),
      };
    }

    this.state.activation = verification;

    return {
      adapterId: this.id,
      bindingId: input.binding.id,
      tenantId: input.binding.tenantId,
      environment: input.binding.environment,
      ok: true,
      refusalReasons: [],
      enabledCapabilities: this.advertisedCapabilities(input.binding),
      contract: this.activationContract(),
    };
  }

  async reconcile(input: {
    readonly binding: RegionBinding;
  }): Promise<AdapterReconcileReceipt> {
    const verification = await verifyAlias({
      repoRoot: this.options.repoRoot,
      aliasRelPath: this.state.manifest.host.servedProductPath,
      declaredTarget: this.state.manifest.regeneration.target,
    });
    const observedAt: Iso8601 = brandIso8601(new Date().toISOString());
    if (!verification.ok) {
      throw new AdapterContractError(
        'E_AMBIGUOUS_BINDING',
        `${verification.code}: ${verification.message}`,
        {
          repoPath: this.state.manifest.host.servedProductPath,
          symlinkCode: verification.code,
        },
      );
    }
    const declaredHash = input.binding.canonicalSource.contentHash;
    const observedHash = brandSha256Hex(verification.canonicalHash);
    const inSync = declaredHash === observedHash;
    const drift: readonly AdapterDriftEntry[] = inSync
      ? []
      : [
          {
            repoPath: this.state.manifest.regeneration.source,
            declaredHash,
            observedHash,
          },
        ];
    return {
      adapterId: this.id,
      bindingId: input.binding.id,
      tenantId: input.binding.tenantId,
      environment: input.binding.environment,
      observedAt,
      inSync,
      drift,
    };
  }

  async apply(input: CanonicalWrite): Promise<AdapterApplyReceipt> {
    if (isServiceIdentity(input.actor)) {
      throw new AdapterContractError(
        'E_AUTHORITY_FORBIDDEN',
        `service or agent identity ${input.actor.id} cannot drive adapter writes`,
        { actorId: input.actor.id, actorKind: input.actor.kind },
      );
    }
    if (input.environment !== this.state.binding.environment) {
      throw new AdapterContractError(
        'E_ENVIRONMENT_MISMATCH',
        `binding ${this.state.binding.id} is in ${this.state.binding.environment}, got ${input.environment}`,
        { bindingEnv: this.state.binding.environment, writeEnv: input.environment },
      );
    }
    if (input.bindingId !== this.state.binding.id) {
      throw new AdapterContractError(
        'E_BINDING_NOT_FOUND',
        `binding ${input.bindingId} was not discovered or activated`,
        { bindingId: input.bindingId },
      );
    }
    if (input.target.repoPath === this.state.binding.regenerationContract.aliasPath) {
      throw new AdapterContractError(
        'E_ALIAS_WRITE_FORBIDDEN',
        `cannot write alias path ${input.target.repoPath}`,
        { repoPath: input.target.repoPath },
      );
    }
    if (this.state.binding.derivedArtifacts.some((a) => a.repoPath === input.target.repoPath)) {
      throw new AdapterContractError(
        'E_DERIVED_WRITE_FORBIDDEN',
        `cannot write derived artifact ${input.target.repoPath}`,
        { repoPath: input.target.repoPath },
      );
    }
    if (input.target.repoPath !== this.state.manifest.regeneration.source) {
      throw new AdapterContractError(
        'E_DERIVED_WRITE_FORBIDDEN',
        `writes are only permitted at the canonical source ${this.state.manifest.regeneration.source}`,
        { repoPath: input.target.repoPath },
      );
    }

    const bytes = materialiseBytes(input.bytes);
    // Commerce gating: id-matched product reconciliation refuses
     // add/remove and mutations to the closed commerce field set.
    await enforceCommerceFieldGating({
      repoRoot: this.options.repoRoot,
      canonicalRelPath: this.state.manifest.regeneration.source,
      proposedBytes: bytes,
    });
    const canonicalHash: Sha256Hex = brandSha256Hex(sha256HexOf(bytes));
    const canonicalAbs = joinInsideRepo(
      this.options.repoRoot,
      this.state.manifest.regeneration.source,
    );
    await mkdir(dirname(canonicalAbs), { recursive: true });
    await writeFile(canonicalAbs, bytes);

    return {
      adapterId: this.id,
      bindingId: input.bindingId,
      tenantId: input.tenantId,
      environment: input.environment,
      canonicalRepoPath: input.target.repoPath,
      canonicalHash,
      appliedAt: brandIso8601(new Date().toISOString()),
      actor: input.actor,
      contract: input.target.contract,
    };
  }

  // ------------------------------------------------------------------
  // Provisional extensions
  // ------------------------------------------------------------------

  async fieldCapabilities(): Promise<FieldCapabilitiesSnapshot> {
    const fields: readonly FieldCapability[] = COMMERCE_FIELDS.map((field) => {
      const readOnly = isFieldReadOnly(this.state.manifest, field);
      const note = readOnly
        ? 'coordinator-gated; adapter exposes no free-edit path'
        : 'unexpected free-edit declaration';
      return {
        field,
        capability: 'coordinator_gated',
        note,
      };
    });
    return {
      adapterId: this.id,
      bindingId: this.state.binding.id,
      tenantId: this.state.binding.tenantId,
      environment: this.state.binding.environment,
      observedAt: brandIso8601(new Date().toISOString()),
      fields,
    };
  }

  deployCapability(): CeraficaDeployCapability {
    return this.state.deployCapability;
  }

  deployCapabilitySnapshot(): DeployCapability {
    return {
      adapterId: this.id,
      bindingId: this.state.binding.id,
      tenantId: this.state.binding.tenantId,
      environment: this.state.binding.environment,
      kind: 'cache.invalidate',
      enabled: this.state.manifest.host.deployMode === 'github_pages',
    };
  }

  async discoverJournal(): Promise<{
    readonly provider: string;
    readonly moduleRelPath: string;
    readonly moduleAbsPath: string;
    readonly readonly: true;
  }> {
    const moduleRelPath = this.state.manifest.capabilities.journal.module;
    const moduleAbsPath = joinInsideRepo(this.options.repoRoot, moduleRelPath);
    await readFile(moduleAbsPath);
    return {
      provider: this.state.manifest.capabilities.journal.provider,
      moduleRelPath,
      moduleAbsPath,
      readonly: true as const,
    };
  }

  journalWrite(): Promise<never> {
    return Promise.reject(new JournalWriteUnsupportedError());
  }


  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private activationContract(): AdapterActivationContract {
    return {
      mode: 'alias_symlink',
      aliasPath: this.state.manifest.host.servedProductPath,
      aliasTargets: [this.state.manifest.regeneration.target],
      canonicalRepoPath: this.state.manifest.regeneration.source,
    };
  }

  private detectBindingIssues(
    binding: RegionBinding,
  ): readonly string[] {
    const issues: string[] = [];
    if (binding.derivedArtifacts.length === 0) {
      issues.push('derived artifacts list is empty');
    }
    if (binding.regenerationContract.mode !== 'alias_symlink') {
      issues.push(`unsupported regeneration mode: ${String(binding.regenerationContract.mode)}`);
    }
    if (binding.derivedArtifacts.some((a) => a.repoPath === binding.canonicalSource.repoPath)) {
      issues.push('a derived artifact collides with the canonical source');
    }
    const collisions = binding.regenerationContract.aliasTargets.filter(
      (t) => t === binding.canonicalSource.repoPath,
    ).length;
    if (collisions > 1) {
      issues.push('alias targets collide with the canonical source more than once');
    }
    return Object.freeze(issues);
  }

  private frozenCapabilities(): readonly AdapterCapability[] {
    return Object.freeze<AdapterCapability[]>([
      'canonical.read',
      'canonical.write',
      'media.alias_symlink',
      'binding.discover',
      'binding.activate',
      'binding.reconcile',
      'binding.apply',
    ]);
  }

  private provisionalCapabilities(): readonly ProvisionalCapability[] {
    return Object.freeze<ProvisionalCapability[]>([
      'field.capabilities.read',
      'deploy.receipt',
    ]);
  }

  private advertisedCapabilities(_binding: RegionBinding): readonly AnyCapability[] {
    return Object.freeze<AnyCapability[]>([
      'canonical.read',
      'canonical.write',
      'media.alias_symlink',
      'binding.discover',
      'binding.activate',
      'binding.reconcile',
      'binding.apply',
      'field.capabilities.read',
      'deploy.receipt',
    ]);
  }
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function materialiseBytes(payload: AdapterWritePayload): Buffer {
  if (payload.kind === 'utf8') return Buffer.from(payload.text, 'utf8');
  return Buffer.from(payload.data, 'base64');
}

function joinInsideRepo(repoRoot: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new AdapterContractError(
      'E_DERIVED_WRITE_FORBIDDEN',
      `path ${relPath} is absolute; only repository-relative paths are permitted`,
      { repoPath: relPath },
    );
  }
  if (relPath.includes('..')) {
    throw new AdapterContractError(
      'E_DERIVED_WRITE_FORBIDDEN',
      `path ${relPath} escapes the repository via '..' segments`,
      { repoPath: relPath },
    );
  }
  const rootResolved = resolve(repoRoot);
  const joined = resolve(rootResolved, relPath);
  const rel = relative(rootResolved, joined);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new AdapterContractError(
      'E_DERIVED_WRITE_FORBIDDEN',
      `path ${relPath} escapes the repository root`,
      { repoPath: relPath },
    );
  }
  return joined;
}

/**
 * Read a UTF-8 JSON file and parse it. Returns `null` when the file
 * does not exist. Throws an `AdapterContractError` when the file
 * exists but is not valid JSON.
 */
async function readJsonDocument(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterContractError(
      'E_BINDING_NOT_FOUND',
      `could not read canonical source at ${path}: ${message}`,
      { repoPath: path },
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterContractError(
      'E_BINDING_NOT_FOUND',
      `canonical source at ${path} is not valid JSON: ${message}`,
      { repoPath: path },
    );
  }
}

/**
 * Accept only the host's canonical top-level product array.
 */
function readProducts(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) {
    throw new AdapterContractError(
      'E_BINDING_NOT_FOUND',
      'canonical products must be a JSON array of objects',
    );
  }
  return value;
}

/**
 * Extract the id of a product record. Returns `null` when the
 * record carries no id.
 */
function readProductId(record: Record<string, unknown>): string | null {
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  return id;
}

/**
 * Enforce coordinator-gated commerce fields at the canonical write
 * boundary. The check is "id-matched": each product in the proposed
 * bytes is matched by id to a product in the existing canonical
 * bytes. Mismatches (added/removed ids) are refused. For matched
 * ids, mutations to the closed commerce field set are refused.
 *
 * When the canonical file does not yet exist, introducing products is
 * refused. Malformed or non-array input fails closed.
 *
 * Safe descriptive/image fields remain writable.
 */
async function enforceCommerceFieldGating(args: {
  readonly repoRoot: string;
  readonly canonicalRelPath: string;
  readonly proposedBytes: Buffer;
}): Promise<void> {
  const canonicalAbs = joinInsideRepo(args.repoRoot, args.canonicalRelPath);
  const [existingDoc, proposedValue] = await Promise.all([
    readJsonDocument(canonicalAbs),
    parseJsonDocument(args.proposedBytes),
  ]);

  const existing = existingDoc === null ? [] : readProducts(existingDoc);
  const proposed = readProducts(proposedValue);

  const existingById = new Map<string, Record<string, unknown>>();
  for (const record of existing) {
    const id = readProductId(record);
    if (id !== null) existingById.set(id, record);
  }

  const proposedById = new Map<string, Record<string, unknown>>();
  for (const record of proposed) {
    const id = readProductId(record);
    if (id !== null) proposedById.set(id, record);
  }
  if (
    existingById.size !== existing.length ||
    proposedById.size !== proposed.length
  ) {
    throw new AdapterContractError(
      'E_BINDING_NOT_FOUND',
      'every product must have a unique non-empty string id',
      { repoPath: args.canonicalRelPath },
    );
  }

  // Product add/remove: any id in the proposed set that is not in
  // the existing set (or vice versa) is refused. The first write
  // (no existing file) is treated as "no products may be
  // introduced" because the adapter never authors new products via
  // apply.
  const added: string[] = [];
  for (const id of proposedById.keys()) {
    if (!existingById.has(id)) added.push(id);
  }
  added.sort();

  const removed: string[] = [];
  for (const id of existingById.keys()) {
    if (!proposedById.has(id)) removed.push(id);
  }
  removed.sort();

  if (added.length > 0 || removed.length > 0) {
    throw new AdapterContractError(
      'E_DERIVED_WRITE_FORBIDDEN',
      `commerce products are coordinator-gated; product add/remove is forbidden (added=[${added.join(',')}] removed=[${removed.join(',')}])`,
      {
        repoPath: args.canonicalRelPath,
        commerceGating: 'add_remove',
        added,
        removed,
      },
    );
  }

  // Field-level check: for each matched id, refuse any change to a
  // closed commerce field.
  const changedFields: Array<{ readonly id: string; readonly field: string }> = [];
  for (const [id, proposedRecord] of proposedById) {
    const existingRecord = existingById.get(id);
    if (existingRecord === undefined) continue;
    for (const field of ENFORCED_HOST_KEYS) {
      if (JSON.stringify(proposedRecord[field]) !== JSON.stringify(existingRecord[field])) {
        changedFields.push({ id, field });
      }
    }
  }

  if (changedFields.length > 0) {
    throw new AdapterContractError(
      'E_DERIVED_WRITE_FORBIDDEN',
      `commerce fields are coordinator-gated; forbidden mutation (${changedFields
        .map((c) => `${c.id}.${c.field}`)
        .join(',')})`,
      {
        repoPath: args.canonicalRelPath,
        commerceGating: 'field',
        changedFields,
      },
    );
  }
}

function parseJsonDocument(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdapterContractError(
      'E_BINDING_NOT_FOUND',
      `proposed canonical products are not valid JSON: ${message}`,
    );
  }
}

// --------------------------------------------------------------------
// Re-exports
// --------------------------------------------------------------------

export type { CommerceField };
export type {
  AliasVerification,
  AliasVerificationResult,
  AliasRefusal,
  SymlinkRefusalCode,
} from './symlink.js';
export { SYMLINK_REFUSAL_CODES, verifyAlias } from './symlink.js';

export const CERAFICA_DEFAULTS = Object.freeze({
  tenantId: DEFAULT_TENANT_ID,
  environment: DEFAULT_ENVIRONMENT,
  bindingId: DEFAULT_BINDING_ID,
  contentType: DEFAULT_CONTENT_TYPE,
  locale: DEFAULT_LOCALE,
  aliasRelPath: DEFAULT_ALIAS_REL_PATH,
  canonicalRelPath: DEFAULT_CANONICAL_REL_PATH,
  declaredTarget: DEFAULT_DECLARED_TARGET,
});

// Internal helpers exposed for tests; production code MUST import via
// the SDK only.
export const __internal__ = {
  sha256HexOf,
  joinInsideRepo,
  commerceFieldHostKeys: COMMERCE_FIELD_HOST_KEYS,
  enforcedHostKeys: ENFORCED_HOST_KEYS,
  enforceCommerceFieldGating,
};
