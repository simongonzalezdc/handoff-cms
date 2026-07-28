/**
 * `@cms/web` — framework-free authoring model.
 *
 * This module is a thin client over an injected `AuthoringApi`. It NEVER
 * re-implements authorization, persistence, or canonical writes. The
 * authoritative authority surface is the API; this module only models
 * local state, dispatches commands, and asks the API to perform
 * propose / preview / approve / publish / rollback / reconcile /
 * upload / deploy operations.
 *
 * Design contract:
 *
 *   - Snapshots are immutable. Every state derivation returns a fresh
 *     frozen `AuthoringSnapshot`. Local drafts are stored in a small
 *     pending-edits layer that is itself read-only outside the store.
 *   - Commands are typed unions. The store accepts a `Command` and
 *     produces a new snapshot via `dispatch`. There is no implicit
 *     apply or publish.
 *   - Visible states are preserved exactly: `editing`, `preview_ready`,
 *     `proposed`, `approved`, `canonical_written`, `deploy_pending`,
 *     `live`, `rolled_back`, `error`.
 *   - Agent / service identities are NOT permitted to perform
 *     `approve`, `publish`, `rollback`, or `reconcile`. These commands
 *     always go through the API with a human (or delegated-human)
 *     actor. The store never silently succeeds; a service identity
 *     attempting a privileged command throws
 *     `ServiceAuthorityDeniedError`.
 *   - Peer-alt enforcement: any image-bearing block or product content
 *     carrying alt text MUST carry non-empty `alt.en` AND `alt.es`. No
 *     silent English fallback.
 *   - Reversible local edits: any edit-style command can be reverted by
 *     `undoLastLocalEdit` (or `undo_local_edit`) until the snapshot is
 *     committed through `propose`. Edits that cannot be reversed throw
 *     `E_NOT_REVERSIBLE` and the pending-edits ledger is NOT trimmed;
 *     the store fails closed so the user must explicitly `propose` or
 *     cancel the operation.
 *   - One-action rollback: `rollback` is a single compensating command
 *     that always calls the API, requires a human identity, and records
 *     the lineage in `auditHistory`.
 *   - Low-distraction preference: `preference.lowDistraction` is
 *     honored by `focusTargetFor` (predictable focus targets).
 *   - Audit history is append-only. Every dispatch records a frozen
 *     entry so consumers can render the timeline. API failures record
 *     an `api_error` entry; successes record an `api_call` entry; the
 *     command-audit `result` reflects the actual outcome of the call
 *     (`ok` / `error` / `denied`).
 *   - Per-store clock + id generator: two stores never share time or
 *     ids. There is no module-global clock or counter.
 *
 * The module re-exports i18n surface (`Locale`, `createTranslator`)
 * from `@cms/i18n`. Consumers should obtain translations through the
 * translator; this module never silently falls back to English on a
 * missing Spanish message.
 */

import {
  DomainInvariantError,
  type Approval,
  type DeployStatus,
  type ErrorCode,
  type Identity,
  type Iso8601,
  type Locale,
  type LocalizedValue,
  type Proposal,
  type ProposalAction,
  type Publication,
  type Revision,
  type Sha256Hex,
  brandIso8601,
  isServiceIdentity,
} from '@cms/core';

import { createTranslator, type MessageKey } from '@cms/i18n';

// --------------------------------------------------------------------
// Re-exports from i18n (peer surface)
// --------------------------------------------------------------------

export { createTranslator, type Locale, type MessageKey };
// --------------------------------------------------------------------
// Store error codes (declared early so they can be referenced by the
// AuthoringSnapshot lastError field below).
// --------------------------------------------------------------------

/**
 * Injected clock source. Tests pass an override; production callers
 * accept the default (host wall clock). The store invokes the clock
 * synchronously; it MUST return a brand-typed ISO string.
 */
export type Clock = () => Iso8601;

/**
 * Injected monotonic counter. Tests pass an override to make audit /
 * edit ids deterministic; production callers accept the default. Two
 * stores that share a counter will share id allocations, which is
 * allowed but rarely useful.
 */
export type Counter = () => number;

const defaultClock: Clock = () => brandIso8601(new Date().toISOString());

function makeCounter(): Counter {
  let n = 0;
  return () => {
    n += 1;
    return n;
  };
}

export const STORE_ERROR_CODES = [
  'E_BAD_BLOCK_ID',
  'E_BAD_LOCALE',
  'E_BAD_INDEX',
  'E_BAD_CROP',
  'E_BAD_FOCAL',
  'E_BAD_BYTES',
  'E_MISSING_ALT',
  'E_EMPTY_ALT',
  'E_MISSING_ALT_LOCALE',
  'E_SERVICE_APPROVAL_FORBIDDEN',
  'E_MCP_APPROVAL_FORBIDDEN',
  'E_NO_PROPOSAL',
  'E_NOT_PREVIEW_READY',
  'E_NOT_APPROVED',
  'E_NOT_LIVE',
  'E_API_ERROR',
  'E_INVALID_SNAPSHOT',
  'E_FROZEN_BLOCK',
  'E_NOT_REVERSIBLE',
  'E_NOT_DEPLOY_READY',
  'E_RECONCILE_FORBIDDEN',
] as const;

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

// --------------------------------------------------------------------
// Public domain types
// --------------------------------------------------------------------

/** All visible states the UI may render. The set is closed. */
export type VisibleState =
  | 'editing'
  | 'preview_ready'
  | 'proposed'
  | 'approved'
  | 'canonical_written'
  | 'deploy_pending'
  | 'live'
  | 'rolled_back'
  | 'error';

export const ALL_VISIBLE_STATES: readonly VisibleState[] = [
  'editing',
  'preview_ready',
  'proposed',
  'approved',
  'canonical_written',
  'deploy_pending',
  'live',
  'rolled_back',
  'error',
] as const;

Object.freeze(ALL_VISIBLE_STATES);
/**
 * Closed set of visible states from which `reconcile` is permitted.
 * Mirrors the boundary enforced by `applyReconcile` and lets renderers
 * disable the reconcile button in lockstep with the model.
 */
export const RECONCILABLE_STATES: ReadonlySet<VisibleState> = new Set<VisibleState>([
  'canonical_written',
  'deploy_pending',
  'live',
  'rolled_back',
  'error',
]);

/**
 * Closed set of visible states from which `rollback` is permitted.
 * Mirrors `applyRollback`: rollback is reachable from `live` (normal
 * reversal) and `error` (recoverable error); every other state forbids
 * the command at the dispatch boundary.
 */
export const ROLLBACK_ALLOWED_STATES: ReadonlySet<VisibleState> = new Set<VisibleState>([
  'live',
  'error',
]);

Object.freeze(RECONCILABLE_STATES);
Object.freeze(ROLLBACK_ALLOWED_STATES);

/**
 * Whether `reconcile` is permitted from the given visible state.
 * Mirrors the closed `RECONCILABLE_STATES` set used by the dispatch
 * boundary so renderers can disable the reconcile button in lockstep
 * with the model.
 */
export function isReconcilable(state: VisibleState): boolean {
  return RECONCILABLE_STATES.has(state);
}

/**
 * Whether `rollback` is permitted from the given visible state.
 * Mirrors `applyRollback`'s gate: rollback is allowed from `live`
 * (normal reversal) and `error` (recovery), and forbidden elsewhere.
 */
export function isRollbackAllowed(state: VisibleState): boolean {
  return ROLLBACK_ALLOWED_STATES.has(state);
}

/**
 * Whether a state is a recoverable error surface. Renderers can use
 * this to render error recovery affordances.
 */
export function isFailureVisible(state: VisibleState): boolean {
  return state === 'error';
}

/** Localized alt-text pair. Both locales are required — no silent fallback. */
export interface AltText {
  readonly en: string;
  readonly es: string;
}

/** Rectangular crop and focal-point metadata for an uploaded asset. */
export interface CropSpec {
  /** Crop rectangle in normalized 0..1 coordinates. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Focal point in normalized 0..1 coordinates. */
  readonly focalX: number;
  readonly focalY: number;
}

export type BlockKind =
  | 'text'
  | 'structured_record'
  | 'product_safe_content'
  | 'image'
  | 'unknown';

export interface BlockBase {
  readonly id: string;
  readonly kind: BlockKind;
  readonly hidden: boolean;
  readonly focusKey: string;
}

export interface TextBlock extends BlockBase {
  readonly kind: 'text';
  readonly value: LocalizedValue;
}

export interface StructuredRecordField {
  readonly key: string;
  readonly value: LocalizedValue;
}

export interface StructuredRecordBlock extends BlockBase {
  readonly kind: 'structured_record';
  readonly fields: readonly StructuredRecordField[];
}

export interface ProductSafeContentBlock extends BlockBase {
  readonly kind: 'product_safe_content';
  readonly title: LocalizedValue;
  readonly summary: LocalizedValue;
  readonly price: { readonly amountMinor: number; readonly currency: string };
}

export interface ImageBlock extends BlockBase {
  readonly kind: 'image';
  readonly assetId: string;
  readonly alt: AltText;
  readonly crop: CropSpec;
}

export type Block = TextBlock | StructuredRecordBlock | ProductSafeContentBlock | ImageBlock;

/**
 * One pending local edit. Local edits are reversible until the snapshot
 * is committed through `propose`. After that, reversal is via `rollback`
 * at the API.
 *
 * `before` and `after` carry the full state necessary to reverse the
 * edit without trusting the command payload. Reversal reconstructs the
 * pre-edit value from `before` and re-applies it through the matching
 * `edit_*` command. Edits whose `before` cannot fully reconstruct the
 * previous block (e.g. structural reorder / duplicate / insert) throw
 * `E_NOT_REVERSIBLE`; the pending-edits ledger is NOT trimmed in that
 * case so the user must explicitly commit or restart the draft.
 */
export interface LocalEdit {
  readonly id: string;
  readonly blockId: string;
  readonly kind:
    | 'edit_text'
    | 'edit_record_field'
    | 'edit_product'
    | 'edit_image_alt'
    | 'edit_image_crop'
    | 'reorder_block'
    | 'hide_block'
    | 'duplicate_block'
    | 'insert_block'
    | 'upload_media'
    | 'replace_media';
  readonly appliedAt: Iso8601;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

/**
 * A snapshot of one authoring record. Snapshots are immutable; commands
 * always produce a fresh snapshot.
 */
export interface AuthoringSnapshot {
  readonly tenantId: string;
  readonly recordId: string;
  readonly contentType: string;
  readonly locale: Locale;
  readonly blocks: readonly Block[];
  readonly visibleState: VisibleState;
  readonly proposalId: string | null;
  readonly revisionId: string | null;
  readonly deployStatus: DeployStatus;
  readonly deployedRevisionId: string | null;
  readonly pendingEdits: readonly LocalEdit[];
  readonly lastError: { readonly code: ErrorCode | StoreErrorCode; readonly message: string } | null;
  readonly preference: AuthoringPreference;
}

/** UI preferences that drive focus and density. */
export interface AuthoringPreference {
  readonly lowDistraction: boolean;
  readonly reduceMotion: boolean;
  readonly locale: Locale;
}

export interface AuditEntry {
  readonly id: string;
  readonly at: Iso8601;
  readonly actor: Identity;
  readonly kind:
    | 'command'
    | 'api_call'
    | 'api_error'
    | 'rollback'
    | 'rejected_privilege'
    | 'validation';
  readonly command?: Command;
  readonly result?: 'ok' | 'denied' | 'error';
  readonly message?: string;
  readonly code?: ErrorCode | StoreErrorCode;
}

// --------------------------------------------------------------------
// AuthoringApi — the injected authority surface.
// --------------------------------------------------------------------

/**
 * The authoritative API contract. The store never writes to the
 * canonical repository directly; every privileged transition calls a
 * method here. The host resolves authority before invoking these
 * methods; the store additionally refuses to call them on behalf of
 * service identities.
 */
export interface AuthoringApi {
  /** Fetch the current canonical snapshot for a record. */
  loadRecord(input: { tenantId: string; recordId: string; locale: Locale }, actor: Identity): Promise<AuthoringSnapshot>;

  /** Server-rendered preview for a snapshot. Returns a preview URL token. */
  previewFromSnapshot(input: {
    tenantId: string;
    recordId: string;
    snapshot: AuthoringSnapshot;
    actor: Identity;
  }): Promise<{ previewUrl: string; revisionId: string; previewAt: Iso8601 }>;

  /** Submit a proposal. Returns the persisted Proposal + revision candidate. */
  propose(input: {
    tenantId: string;
    recordId: string;
    snapshot: AuthoringSnapshot;
    actor: Identity;
    idempotencyKey: string;
  }): Promise<{ proposal: Proposal; revision: Revision }>;

  /** Approve a proposal. MUST be called by a human identity only. */
  approve(input: {
    tenantId: string;
    recordId: string;
    proposalId: string;
    actor: Identity;
    ifMatch: string;
    idempotencyKey: string;
  }): Promise<{ approval: Approval }>;

  /**
   * Publish an approved proposal. MUST be called by a human identity
   * only. The returned `deployStatus` may indicate the deploy is
   * still `in_flight`; the store records `deploy_pending` until the
   * deploy transitions to `succeeded`.
   */
  publish(input: {
    tenantId: string;
    recordId: string;
    proposalId: string;
    actor: Identity;
    ifMatch: string;
    idempotencyKey: string;
  }): Promise<{ publication: Publication; deployStatus: DeployStatus }>;

  /** Rollback. MUST be called by a human identity only. */
  rollback(input: {
    tenantId: string;
    recordId: string;
    proposalId: string;
    actor: Identity;
    ifMatch: string;
    idempotencyKey: string;
  }): Promise<{ rolledBackTo: string; deployStatus: DeployStatus }>;

  /**
   * Reconcile the deployed revision with the latest approved one.
   * MUST be called by a human identity only. Reconcile is restricted
   * to records that are currently in a deploy-related state
   * (`canonical_written`, `deploy_pending`, `live`, `rolled_back`,
   * or a recoverable error).
   */
  reconcile(input: {
    tenantId: string;
    recordId: string;
    actor: Identity;
  }): Promise<{ deployStatus: DeployStatus; deployedRevisionId: string | null }>;

  /** Upload an asset (image). The host returns the asset id + content hash. */
  uploadAsset(input: {
    tenantId: string;
    recordId: string;
    bytes: Uint8Array;
    mimeType: string;
    alt: AltText;
    crop: CropSpec;
    actor: Identity;
  }): Promise<{ assetId: string; contentHash: Sha256Hex; previewUrl: string }>;

  /** Replace the bytes for an existing asset (e.g. a higher-resolution version). */
  replaceAsset(input: {
    tenantId: string;
    recordId: string;
    assetId: string;
    bytes: Uint8Array;
    mimeType: string;
    alt: AltText;
    crop: CropSpec;
    actor: Identity;
  }): Promise<{ assetId: string; contentHash: Sha256Hex; previewUrl: string }>;

  /** Audit history fetch — used for the timeline. */
  auditHistory(input: { tenantId: string; recordId: string }, actor: Identity): Promise<readonly AuditEntry[]>;
}

// --------------------------------------------------------------------
// Commands — every state change goes through one of these.
// --------------------------------------------------------------------

export interface EditTextCommand {
  readonly type: 'edit_text';
  readonly blockId: string;
  readonly locale: Locale;
  readonly value: string;
}

export interface EditRecordFieldCommand {
  readonly type: 'edit_record_field';
  readonly blockId: string;
  readonly fieldKey: string;
  readonly locale: Locale;
  readonly value: string;
}

export interface EditProductCommand {
  readonly type: 'edit_product';
  readonly blockId: string;
  readonly title?: LocalizedValue;
  readonly summary?: LocalizedValue;
  /** Commerce pricing is coordinator-gated and cannot be changed here. */
  readonly price?: never;
}

export interface EditImageAltCommand {
  readonly type: 'edit_image_alt';
  readonly blockId: string;
  readonly alt: AltText;
}

export interface EditImageCropCommand {
  readonly type: 'edit_image_crop';
  readonly blockId: string;
  readonly crop: CropSpec;
}

export interface UploadMediaCommand {
  readonly type: 'upload_media';
  readonly blockId: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly alt: AltText;
  readonly crop: CropSpec;
}

export interface ReplaceMediaCommand {
  readonly type: 'replace_media';
  readonly blockId: string;
  readonly assetId: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly alt: AltText;
  readonly crop: CropSpec;
}

export interface ReorderBlockCommand {
  readonly type: 'reorder_block';
  readonly blockId: string;
  readonly toIndex: number;
}

export interface HideBlockCommand {
  readonly type: 'hide_block';
  readonly blockId: string;
}

export interface DuplicateBlockCommand {
  readonly type: 'duplicate_block';
  readonly blockId: string;
  readonly toIndex: number;
}

export interface InsertBlockCommand {
  readonly type: 'insert_block';
  readonly atIndex: number;
  readonly block: Block;
}

export interface UndoLocalEditCommand {
  readonly type: 'undo_local_edit';
  readonly editId: string;
}

export interface PreviewFromSnapshotCommand {
  readonly type: 'preview_from_snapshot';
}

export interface ProposeCommand {
  readonly type: 'propose';
  readonly action: ProposalAction;
  readonly idempotencyKey: string;
}

export interface ApproveCommand {
  readonly type: 'approve';
  readonly ifMatch: string;
  readonly idempotencyKey: string;
}

export interface PublishCommand {
  readonly type: 'publish';
  readonly ifMatch: string;
  readonly idempotencyKey: string;
}

export interface RollbackCommand {
  readonly type: 'rollback';
  readonly ifMatch: string;
  readonly idempotencyKey: string;
}

export interface ReconcileCommand {
  readonly type: 'reconcile';
}

export interface RefreshCommand {
  readonly type: 'refresh';
}

export interface SetPreferenceCommand {
  readonly type: 'set_preference';
  readonly preference: Partial<AuthoringPreference>;
}

export type Command =
  | EditTextCommand
  | EditRecordFieldCommand
  | EditProductCommand
  | EditImageAltCommand
  | EditImageCropCommand
  | UploadMediaCommand
  | ReplaceMediaCommand
  | ReorderBlockCommand
  | HideBlockCommand
  | DuplicateBlockCommand
  | InsertBlockCommand
  | UndoLocalEditCommand
  | PreviewFromSnapshotCommand
  | ProposeCommand
  | ApproveCommand
  | PublishCommand
  | RollbackCommand
  | ReconcileCommand
  | RefreshCommand
  | SetPreferenceCommand;

export interface DispatchOptions {
  /** When true, dispatch returns the new snapshot without invoking the API. */
  readonly dryRun?: boolean;
}

export interface DispatchResult {
  readonly snapshot: AuthoringSnapshot;
  readonly audit: readonly AuditEntry[];
}

// --------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------

/**
 * Thrown when a service / MCP identity attempts approve / publish /
 * rollback / reconcile. The store refuses these commands before the
 * API is even called so the authoritative surface cannot be tricked
 * into performing a privileged transition on behalf of a bot.
 */
export class ServiceAuthorityDeniedError extends StoreError {
  readonly actor: Identity;
  readonly attempted: 'approve' | 'publish' | 'rollback' | 'reconcile';
  constructor(actor: Identity, attempted: 'approve' | 'publish' | 'rollback' | 'reconcile') {
    super(
      isServiceIdentity(actor)
        ? 'E_SERVICE_APPROVAL_FORBIDDEN'
        : 'E_MCP_APPROVAL_FORBIDDEN',
      `identity ${actor.id} of kind ${actor.kind} may not perform ${attempted}`,
    );
    this.name = 'ServiceAuthorityDeniedError';
    this.actor = actor;
    this.attempted = attempted;
  }
}

export class ApiError extends StoreError {
  readonly apiCode: ErrorCode;
  readonly apiMessage: string;
  constructor(apiCode: ErrorCode, apiMessage: string) {
    super('E_API_ERROR', `api error [${apiCode}]: ${apiMessage}`);
    this.name = 'ApiError';
    this.apiCode = apiCode;
    this.apiMessage = apiMessage;
  }
}

// --------------------------------------------------------------------
// Store configuration and creation
// --------------------------------------------------------------------

export interface AuthoringStoreConfig {
  readonly tenantId: string;
  readonly recordId: string;
  readonly contentType: string;
  readonly locale: Locale;
  readonly api: AuthoringApi;
  readonly actor: Identity;
  readonly initial: AuthoringSnapshot;
  readonly preference?: Partial<AuthoringPreference>;
  /**
   * Optional injected clock. When omitted the store uses the host
   * wall clock (no module-global state). Two stores never share
   * time even when neither overrides the clock.
   */
  readonly clock?: Clock;
  /**
   * Optional injected monotonic counter used to mint audit + edit
   * ids. When omitted, the store allocates its own counter so two
   * stores never collide.
   */
  readonly counter?: Counter;
}

export interface AuthoringStore {
  /** Current immutable snapshot. */
  readonly snapshot: () => AuthoringSnapshot;
  /** Current audit history (append-only). */
  readonly history: () => readonly AuditEntry[];
  /** Subscribe to snapshot changes. Returns an unsubscribe function. */
  readonly subscribe: (listener: (snapshot: AuthoringSnapshot) => void) => () => void;
  /** Dispatch a command. Returns the new snapshot + new audit entries. */
  readonly dispatch: (command: Command, options?: DispatchOptions) => Promise<DispatchResult>;
  /**
   * Undo the last local edit (synchronous). Either reverses the edit
   * and removes the entry, or throws `E_NOT_REVERSIBLE` without
   * trimming the pending-edits ledger. Returns the new snapshot.
   */
  readonly undoLastLocalEdit: () => AuthoringSnapshot;
  /** Compute the next focus target for the UI (predictable, low-distraction friendly). */
  readonly focusTargetFor: (kind: 'next_block' | 'previous_block' | 'first_invalid', currentBlockId?: string) => string | null;
  /** Compute whether the current snapshot is preview-ready. */
  readonly isPreviewReady: () => boolean;
}

// --------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freeze(entry))) as unknown as T;
  }
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[key];
      if (v && typeof v === 'object' && !Object.isFrozen(v)) {
        freeze(v);
      }
    }
    return Object.freeze(value);
  }
  return value;
}

function errorCode(err: unknown): ErrorCode | StoreErrorCode {
  if (err instanceof ApiError) return err.apiCode;
  if (err instanceof DomainInvariantError || err instanceof StoreError) return err.code;
  // Truthful fallback: surface unknown failures as the closed
  // "API error" envelope rather than masquerading as a proposal fault.
  return 'E_API_ERROR';
}

/**
 * Per-store clock + counter closures. Each store owns its own clock
 * and id generator so two stores never share state. Tests pass a
 * clock / counter explicitly via {@link AuthoringStoreConfig};
 * production callers get deterministic defaults scoped to the store.
 */
interface StoreInternals {
  readonly now: () => Iso8601;
  readonly nextId: () => string;
}

function makeStoreInternals(config: { clock?: Clock; counter?: Counter }): StoreInternals {
  const counter = config.counter ?? makeCounter();
  const clock = config.clock ?? defaultClock;
  return {
    now: clock,
    nextId: () => `aud-${counter().toString(36)}`,
  };
}

function assertValidLocale(locale: Locale): void {
  if (locale !== 'en' && locale !== 'es') {
    throw new StoreError('E_BAD_LOCALE', `unsupported locale: ${String(locale)}`);
  }
}

function assertValidAlt(alt: AltText): void {
  if (alt === null || typeof alt !== 'object') {
    throw new StoreError('E_MISSING_ALT', 'alt text object required');
  }
  if (typeof alt.en !== 'string' || alt.en.trim().length === 0) {
    throw new StoreError('E_EMPTY_ALT', 'alt.en must be a non-empty string');
  }
  if (typeof alt.es !== 'string' || alt.es.trim().length === 0) {
    throw new StoreError('E_EMPTY_ALT', 'alt.es must be a non-empty string');
  }
}

function assertValidCrop(crop: CropSpec): void {
  for (const v of [crop.x, crop.y, crop.width, crop.height, crop.focalX, crop.focalY]) {
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1) {
      throw new StoreError('E_BAD_CROP', `crop coordinate must be in [0,1]: ${String(v)}`);
    }
  }
  if (crop.width === 0 || crop.height === 0) {
    throw new StoreError('E_BAD_CROP', 'crop width/height must be > 0');
  }
  if (crop.focalX < crop.x || crop.focalX > crop.x + crop.width) {
    throw new StoreError('E_BAD_FOCAL', 'focalX must lie within crop');
  }
  if (crop.focalY < crop.y || crop.focalY > crop.y + crop.height) {
    throw new StoreError('E_BAD_FOCAL', 'focalY must lie within crop');
  }
}

function assertValidBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new StoreError('E_BAD_BYTES', 'bytes must be Uint8Array');
  }
  if (bytes.byteLength === 0) {
    throw new StoreError('E_BAD_BYTES', 'bytes must be non-empty');
  }
}

function isHumanIdentity(actor: Identity): boolean {
  return actor.kind === 'actor' || actor.kind === 'delegated_human';
}

function guardHumanOnly(actor: Identity, attempted: 'approve' | 'publish' | 'rollback' | 'reconcile'): void {
  if (isServiceIdentity(actor)) {
    throw new ServiceAuthorityDeniedError(actor, attempted);
  }
  if (!isHumanIdentity(actor)) {
    throw new ServiceAuthorityDeniedError(actor, attempted);
  }
}

function findBlock(snapshot: AuthoringSnapshot, blockId: string): Block | null {
  return snapshot.blocks.find((b) => b.id === blockId) ?? null;
}

function replaceBlock(snapshot: AuthoringSnapshot, updated: Block): AuthoringSnapshot {
  const next = snapshot.blocks.map((b) => (b.id === updated.id ? updated : b));
  return { ...snapshot, blocks: freeze(next) };
}


function blockOrder(snapshot: AuthoringSnapshot): readonly string[] {
  return freeze(snapshot.blocks.map((b) => b.id));
}

function defaultPreference(locale: Locale): AuthoringPreference {
  return Object.freeze({ lowDistraction: false, reduceMotion: false, locale });
}

// --------------------------------------------------------------------
// Store factory
// --------------------------------------------------------------------

/**
 * Create an authoring store for one record. The store is a thin client
 * over the injected `AuthoringApi`; all privileged transitions call the
 * API. Local edits are reversible until `propose` clears them.
 */
export function createAuthoringStore(config: AuthoringStoreConfig): AuthoringStore {
  const { tenantId, recordId, contentType, locale, api, actor, initial } = config;

  if (initial.tenantId !== tenantId || initial.recordId !== recordId || initial.contentType !== contentType || initial.locale !== locale) {
    throw new StoreError('E_INVALID_SNAPSHOT', 'initial snapshot does not match store configuration');
  }

  const internals = makeStoreInternals(config);

  let current: AuthoringSnapshot = freeze({
    ...initial,
    preference: freeze({ ...defaultPreference(locale), ...(config.preference ?? {}) }),
  });

  let audit: AuditEntry[] = [];
  const listeners = new Set<(snapshot: AuthoringSnapshot) => void>();

  function recordAudit(entry: AuditEntry): void {
    audit = freeze([...audit, entry]);
  }

  function commit(snapshot: AuthoringSnapshot): AuthoringSnapshot {
    current = freeze(snapshot);
    for (const l of listeners) l(current);
    return current;
  }

  function withError(snapshot: AuthoringSnapshot, code: ErrorCode | StoreErrorCode, message: string): AuthoringSnapshot {
    return freeze({ ...snapshot, visibleState: 'error', lastError: freeze({ code, message }) });
  }

  // ------------------------- local commands -------------------------

  function applyEditText(cmd: EditTextCommand): AuthoringSnapshot {
    const block = findBlock(current, cmd.blockId);
    if (block === null) throw new StoreError('E_BAD_BLOCK_ID', `unknown block ${cmd.blockId}`);
    if (block.kind !== 'text') throw new StoreError('E_BAD_BLOCK_ID', `block ${cmd.blockId} is not text`);
    assertValidLocale(cmd.locale);
    const updated: TextBlock = freeze({
      ...block,
      value: freeze({ ...block.value, [cmd.locale]: cmd.value }),
    });
    const before = freeze({ locale: cmd.locale, value: block.value[cmd.locale] });
    const after = freeze({ locale: cmd.locale, value: cmd.value });
    const edit: LocalEdit = freeze({
      id: internals.nextId(),
      blockId: cmd.blockId,
      kind: 'edit_text',
      appliedAt: internals.now(),
      before,
      after,
    });
    return commit({
      ...replaceBlock(current, updated),
      visibleState: 'editing',
      pendingEdits: [...current.pendingEdits, edit],
    });
  }

  function applyEditRecordField(cmd: EditRecordFieldCommand): AuthoringSnapshot {
    const block = findBlock(current, cmd.blockId);
    if (block === null) throw new StoreError('E_BAD_BLOCK_ID', `unknown block ${cmd.blockId}`);
    if (block.kind !== 'structured_record') throw new StoreError('E_BAD_BLOCK_ID', `block ${cmd.blockId} is not structured_record`);
    assertValidLocale(cmd.locale);
    const existingField = block.fields.find((f) => f.key === cmd.fieldKey);
    if (existingField === undefined) {
      throw new StoreError('E_BAD_BLOCK_ID', `unknown field ${cmd.fieldKey} on block ${cmd.blockId}`);
    }
    const fields = block.fields.map((f) =>
      f.key === cmd.fieldKey ? freeze({ ...f, value: freeze({ ...f.value, [cmd.locale]: cmd.value }) }) : f,
    );
    const updated: StructuredRecordBlock = freeze({ ...block, fields: freeze(fields) });
    const before = freeze({
      fieldKey: cmd.fieldKey,
      locale: cmd.locale,
      value: existingField.value[cmd.locale],
    });
    const after = freeze({ fieldKey: cmd.fieldKey, locale: cmd.locale, value: cmd.value });
    const edit: LocalEdit = freeze({
      id: internals.nextId(),
      blockId: cmd.blockId,
      kind: 'edit_record_field',
      appliedAt: internals.now(),
      before,
      after,
    });
    return commit({
      ...replaceBlock(current, updated),
      visibleState: 'editing',
      pendingEdits: [...current.pendingEdits, edit],
    });
  }

  function applyEditProduct(cmd: EditProductCommand): AuthoringSnapshot {
    const block = findBlock(current, cmd.blockId);
    if (block === null) throw new StoreError('E_BAD_BLOCK_ID', `unknown block ${cmd.blockId}`);
    if (block.kind !== 'product_safe_content') throw new StoreError('E_BAD_BLOCK_ID', `block ${cmd.blockId} is not product_safe_content`);
    if ('price' in cmd && cmd.price !== undefined) {
      throw new StoreError('E_FROZEN_BLOCK', 'product price is coordinator-gated');
    }
    if (cmd.title !== undefined) assertLocalized(cmd.title);
    if (cmd.summary !== undefined) assertLocalized(cmd.summary);
    const nextTitle = cmd.title !== undefined ? freeze(cmd.title) : block.title;
    const nextSummary = cmd.summary !== undefined ? freeze(cmd.summary) : block.summary;
    const updated: ProductSafeContentBlock = freeze({
      ...block,
      title: nextTitle,
      summary: nextSummary,
      price: block.price,
    });
    const before = freeze({
      title: cmd.title !== undefined ? block.title : undefined,
      summary: cmd.summary !== undefined ? block.summary : undefined,
      hidden: block.hidden,
    });
    const after = freeze({
      title: cmd.title !== undefined ? nextTitle : undefined,
      summary: cmd.summary !== undefined ? nextSummary : undefined,
      hidden: block.hidden,
    });
    const edit: LocalEdit = freeze({
      id: internals.nextId(),
      blockId: cmd.blockId,
      kind: 'edit_product',
      appliedAt: internals.now(),
      before,
      after,
    });
    return commit({
      ...replaceBlock(current, updated),
      visibleState: 'editing',
      pendingEdits: [...current.pendingEdits, edit],
    });
  }

  function applyEditImageAlt(cmd: EditImageAltCommand): AuthoringSnapshot {
    assertValidAlt(cmd.alt);
    const block = findBlock(current, cmd.blockId);
    if (block === null) throw new StoreError('E_BAD_BLOCK_ID', `unknown block ${cmd.blockId}`);
    if (block.kind !== 'image') throw new StoreError('E_BAD_BLOCK_ID', `block ${cmd.blockId} is not image`);
    const updated: ImageBlock = freeze({ ...block, alt: freeze(cmd.alt) });
    const before = freeze({ alt: block.alt });
    const after = freeze({ alt: cmd.alt });
    const edit: LocalEdit = freeze({
      id: internals.nextId(),
      blockId: cmd.blockId,
      kind: 'edit_image_alt',
      appliedAt: internals.now(),
      before,
      after,
    });
    return commit({
      ...replaceBlock(current, updated),
      visibleState: 'editing',
      pendingEdits: [...current.pendingEdits, edit],
    });
  }

  function applyEditImageCrop(cmd: EditImageCropCommand): AuthoringSnapshot {
    assertValidCrop(cmd.crop);
    const block = findBlock(current, cmd.blockId);
    if (block === null) throw new StoreError('E_BAD_BLOCK_ID', `unknown block ${cmd.blockId}`);
    if (block.kind !== 'image') throw new StoreError('E_BAD_BLOCK_ID', `block ${cmd.blockId} is not image`);
    const updated: ImageBlock = freeze({ ...block, crop: freeze(cmd.crop) });
    const before = freeze({ crop: block.crop });
    const after = freeze({ crop: cmd.crop });
    const edit: LocalEdit = freeze({
      id: internals.nextId(),
      blockId: cmd.blockId,
      kind: 'edit_image_crop',
      appliedAt: internals.now(),
      before,
      after,
    });
    return commit({
      ...replaceBlock(current, updated),
      visibleState: 'editing',
      pendingEdits: [...current.pendingEdits, edit],
    });
  }

  function applyReorder(cmd: ReorderBlockCommand): AuthoringSnapshot {
    const block = findBlock(current, cmd.blockId);
    if (block === null) throw new StoreError('E_BAD_BLOCK_ID', `unknown block ${cmd.blockId}`);
    if (cmd.toIndex < 0 || cmd.toIndex >= current.blocks.length) {
      throw new StoreError('E_BAD_INDEX', `toIndex out of range: ${cmd.toIndex}`);
    }
    const without = current.blocks.filter((b) => b.id !== cmd.blockId);
    const next = [...without.slice(0, cmd.toIndex), block, ...without.slice(cmd.toIndex)];
    const before = freeze({ order: blockOrder(current) });
    const after = freeze({ order: blockOrder({ ...current, blocks: next }) });
    const edit: LocalEdit = freeze({
      id: internals.nextId(),
      blockId: cmd.blockId,
      kind: 'reorder_block',
      appliedAt: internals.now(),
      before,
      after,
    });
    return commit({
      ...current,
      blocks: freeze(next),
      visibleState: 'editing',
      pendingEdits: [...current.pendingEdits, edit],
    });
  }

  function applyHide(cmd: HideBlockCommand): AuthoringSnapshot {
    const block = findBlock(current, cmd.blockId);
    if (block === null) throw new StoreError('E_BAD_BLOCK_ID', `unknown block ${cmd.blockId}`);
    if (block.hidden) return current;
    const updated = freeze({ ...block, hidden: true });
    const before = freeze({ hidden: false });
    const after = freeze({ hidden: true });
    const edit: LocalEdit = freeze({
      id: internals.nextId(),
      blockId: cmd.blockId,
      kind: 'hide_block',
      appliedAt: internals.now(),
      before,
      after,
    });
    return commit({
      ...replaceBlock(current, updated),
      visibleState: 'editing',
      pendingEdits: [...current.pendingEdits, edit],
    });
  }

  function applyDuplicate(cmd: DuplicateBlockCommand): AuthoringSnapshot {
    const block = findBlock(current, cmd.blockId);
    if (block === null) throw new StoreError('E_BAD_BLOCK_ID', `unknown block ${cmd.blockId}`);
    if (cmd.toIndex < 0 || cmd.toIndex > current.blocks.length) {
      throw new StoreError('E_BAD_INDEX', `toIndex out of range: ${cmd.toIndex}`);
    }
    const cloneId = `${block.id}-dup-${(current.pendingEdits.length + 1).toString(36)}`;
    const clone = freeze({ ...block, id: cloneId });
    const next = [...current.blocks.slice(0, cmd.toIndex), clone, ...current.blocks.slice(cmd.toIndex)];
    const before = freeze({ order: blockOrder(current) });
    const after = freeze({
      order: blockOrder({ ...current, blocks: next }),
      fromBlockId: cmd.blockId,
      cloneId,
    });
    const edit: LocalEdit = freeze({
      id: internals.nextId(),
      blockId: cloneId,
      kind: 'duplicate_block',
      appliedAt: internals.now(),
      before,
      after,
    });
    return commit({
      ...current,
      blocks: freeze(next),
      visibleState: 'editing',
      pendingEdits: [...current.pendingEdits, edit],
    });
  }

  function applyInsert(cmd: InsertBlockCommand): AuthoringSnapshot {
    if (cmd.atIndex < 0 || cmd.atIndex > current.blocks.length) {
      throw new StoreError('E_BAD_INDEX', `atIndex out of range: ${cmd.atIndex}`);
    }
    if (cmd.block.kind === 'image') assertValidAlt(cmd.block.alt);
    const next = [...current.blocks.slice(0, cmd.atIndex), freeze(cmd.block), ...current.blocks.slice(cmd.atIndex)];
    const before = freeze({ order: blockOrder(current) });
    const after = freeze({
      order: blockOrder({ ...current, blocks: next }),
      blockId: cmd.block.id,
    });
    const edit: LocalEdit = freeze({
      id: internals.nextId(),
      blockId: cmd.block.id,
      kind: 'insert_block',
      appliedAt: internals.now(),
      before,
      after,
    });
    return commit({
      ...current,
      blocks: freeze(next),
      visibleState: 'editing',
      pendingEdits: [...current.pendingEdits, edit],
    });
  }

  function applyUndo(cmd: UndoLocalEditCommand): AuthoringSnapshot {
    const edit = current.pendingEdits.find((e) => e.id === cmd.editId);
    if (edit === undefined) return current;
    const reversed = reverseEdit(current, edit);
    // `reverseEdit` either throws (no trim) or returns the snapshot
    // with the edit's effects removed. In both cases the pending-edits
    // ledger is trimmed to remove the entry we just reversed; on
    // failure we rethrow without trimming (fail closed).
    const trimmed = current.pendingEdits.filter((e) => e.id !== cmd.editId);
    return commit({ ...reversed, pendingEdits: freeze(trimmed) });
  }

  function reverseEdit(snapshot: AuthoringSnapshot, edit: LocalEdit): AuthoringSnapshot {
    switch (edit.kind) {
      case 'edit_text': {
        const before = edit.before as { locale: Locale; value: string };
        const block = findBlock(snapshot, edit.blockId);
        if (block === null || block.kind !== 'text') {
          throw new StoreError('E_NOT_REVERSIBLE', `cannot reverse edit_text: block missing or wrong kind`);
        }
        const restored: TextBlock = freeze({ ...block, value: freeze({ ...block.value, [before.locale]: before.value }) });
        return replaceBlock(snapshot, restored);
      }
      case 'edit_record_field': {
        const before = edit.before as { fieldKey: string; locale: Locale; value: string };
        const block = findBlock(snapshot, edit.blockId);
        if (block === null || block.kind !== 'structured_record') {
          throw new StoreError('E_NOT_REVERSIBLE', `cannot reverse edit_record_field: block missing or wrong kind`);
        }
        const fields = block.fields.map((f) =>
          f.key === before.fieldKey ? freeze({ ...f, value: freeze({ ...f.value, [before.locale]: before.value }) }) : f,
        );
        const restored: StructuredRecordBlock = freeze({ ...block, fields: freeze(fields) });
        return replaceBlock(snapshot, restored);
      }
      case 'edit_product': {
        const before = edit.before as { title?: LocalizedValue; summary?: LocalizedValue; hidden: boolean };
        const block = findBlock(snapshot, edit.blockId);
        if (block === null || block.kind !== 'product_safe_content') {
          throw new StoreError('E_NOT_REVERSIBLE', `cannot reverse edit_product: block missing or wrong kind`);
        }
        const restored: ProductSafeContentBlock = freeze({
          ...block,
          title: before.title ?? block.title,
          summary: before.summary ?? block.summary,
          hidden: before.hidden,
          price: block.price,
        });
        return replaceBlock(snapshot, restored);
      }
      case 'edit_image_alt': {
        const before = edit.before as { alt: AltText };
        const block = findBlock(snapshot, edit.blockId);
        if (block === null || block.kind !== 'image') {
          throw new StoreError('E_NOT_REVERSIBLE', `cannot reverse edit_image_alt: block missing or wrong kind`);
        }
        const restored: ImageBlock = freeze({ ...block, alt: freeze(before.alt) });
        return replaceBlock(snapshot, restored);
      }
      case 'edit_image_crop': {
        const before = edit.before as { crop: CropSpec };
        const block = findBlock(snapshot, edit.blockId);
        if (block === null || block.kind !== 'image') {
          throw new StoreError('E_NOT_REVERSIBLE', `cannot reverse edit_image_crop: block missing or wrong kind`);
        }
        const restored: ImageBlock = freeze({ ...block, crop: freeze(before.crop) });
        return replaceBlock(snapshot, restored);
      }
      case 'hide_block': {
        const before = edit.before as { hidden: boolean };
        const block = findBlock(snapshot, edit.blockId);
        if (block === null) {
          throw new StoreError('E_NOT_REVERSIBLE', `cannot reverse hide_block: block missing`);
        }
        const restored: Block = freeze({ ...block, hidden: before.hidden });
        return replaceBlock(snapshot, restored);
      }
      case 'reorder_block': {
        const before = edit.before as { order: readonly string[] };
        const restored = freeze(before.order.map((id) => snapshot.blocks.find((b) => b.id === id)).filter((b): b is Block => b !== undefined));
        return { ...snapshot, blocks: restored };
      }
      case 'duplicate_block': {
        const after = edit.after as { cloneId: string; order: readonly string[] };
        const without = snapshot.blocks.filter((b) => b.id !== after.cloneId);
        const restored = freeze(after.order.map((id) => without.find((b) => b.id === id)).filter((b): b is Block => b !== undefined));
        return { ...snapshot, blocks: restored };
      }
      case 'insert_block': {
        const after = edit.after as { blockId: string; order: readonly string[] };
        const without = snapshot.blocks.filter((b) => b.id !== after.blockId);
        const restored = freeze(after.order.map((id) => without.find((b) => b.id === id)).filter((b): b is Block => b !== undefined));
        return { ...snapshot, blocks: restored };
      }
      case 'upload_media':
      case 'replace_media':
        // Asset mutations always require a follow-up API call to
        // re-upload or re-replace; we cannot fully reconstruct the
        // previous bytes locally. Fail closed so the caller can
        // explicitly `propose` or restart.
        throw new StoreError('E_NOT_REVERSIBLE', `${edit.kind} cannot be undone locally; submit the proposal or restart the draft`);
    }
  }

  function applySetPreference(cmd: SetPreferenceCommand): AuthoringSnapshot {
    return commit({
      ...current,
      preference: freeze({ ...current.preference, ...cmd.preference }),
    });
  }

  // ------------------------- async commands -------------------------

  async function applyUpload(cmd: UploadMediaCommand): Promise<AuthoringSnapshot> {
    assertValidBytes(cmd.bytes);
    assertValidAlt(cmd.alt);
    assertValidCrop(cmd.crop);
    const block = findBlock(current, cmd.blockId);
    if (block === null) throw new StoreError('E_BAD_BLOCK_ID', `unknown block ${cmd.blockId}`);
    if (block.kind !== 'image') throw new StoreError('E_BAD_BLOCK_ID', `block ${cmd.blockId} is not image`);
    try {
      const result = await api.uploadAsset({
        tenantId,
        recordId,
        bytes: cmd.bytes,
        mimeType: cmd.mimeType,
        alt: cmd.alt,
        crop: cmd.crop,
        actor,
      });
      const updated: ImageBlock = freeze({
        ...block,
        assetId: result.assetId,
        alt: freeze(cmd.alt),
        crop: freeze(cmd.crop),
      });
      const before = freeze({ assetId: block.assetId, alt: block.alt, crop: block.crop });
      const after = freeze({ assetId: result.assetId, alt: cmd.alt, crop: cmd.crop });
      const edit: LocalEdit = freeze({
        id: internals.nextId(),
        blockId: cmd.blockId,
        kind: 'upload_media',
        appliedAt: internals.now(),
        before,
        after,
      });
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_call',
        command: cmd,
        result: 'ok',
        message: `uploaded asset ${result.assetId}`,
      });
      return commit({
        ...replaceBlock(current, updated),
        visibleState: 'editing',
        pendingEdits: [...current.pendingEdits, edit],
      });
    } catch (err) {
      const apiCode = errorCode(err);
      const message = err instanceof Error ? err.message : 'upload failed';
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_error',
        command: cmd,
        result: 'error',
        code: apiCode,
        message,
      });
      return commit(withError(current, apiCode, message));
    }
  }

  async function applyReplace(cmd: ReplaceMediaCommand): Promise<AuthoringSnapshot> {
    assertValidBytes(cmd.bytes);
    assertValidAlt(cmd.alt);
    assertValidCrop(cmd.crop);
    const block = findBlock(current, cmd.blockId);
    if (block === null) throw new StoreError('E_BAD_BLOCK_ID', `unknown block ${cmd.blockId}`);
    if (block.kind !== 'image') throw new StoreError('E_BAD_BLOCK_ID', `block ${cmd.blockId} is not image`);
    if (block.assetId !== cmd.assetId) {
      throw new StoreError('E_BAD_BLOCK_ID', `assetId mismatch on block ${cmd.blockId}`);
    }
    try {
      const result = await api.replaceAsset({
        tenantId,
        recordId,
        assetId: cmd.assetId,
        bytes: cmd.bytes,
        mimeType: cmd.mimeType,
        alt: cmd.alt,
        crop: cmd.crop,
        actor,
      });
      const updated: ImageBlock = freeze({
        ...block,
        assetId: result.assetId,
        alt: freeze(cmd.alt),
        crop: freeze(cmd.crop),
      });
      const before = freeze({ assetId: block.assetId, alt: block.alt, crop: block.crop });
      const after = freeze({ assetId: result.assetId, alt: cmd.alt, crop: cmd.crop });
      const edit: LocalEdit = freeze({
        id: internals.nextId(),
        blockId: cmd.blockId,
        kind: 'replace_media',
        appliedAt: internals.now(),
        before,
        after,
      });
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_call',
        command: cmd,
        result: 'ok',
        message: `replaced asset ${result.assetId}`,
      });
      return commit({
        ...replaceBlock(current, updated),
        visibleState: 'editing',
        pendingEdits: [...current.pendingEdits, edit],
      });
    } catch (err) {
      const apiCode = errorCode(err);
      const message = err instanceof Error ? err.message : 'replace failed';
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_error',
        command: cmd,
        result: 'error',
        code: apiCode,
        message,
      });
      return commit(withError(current, apiCode, message));
    }
  }

  function validateForPreview(snapshot: AuthoringSnapshot): { ok: true } | { ok: false; missing: string[] } {
    const missing: string[] = [];
    for (const block of snapshot.blocks) {
      if (block.kind === 'text') {
        if (block.value.en.trim().length === 0 || block.value.es.trim().length === 0) {
          missing.push(`text:${block.id}:locale`);
        }
      } else if (block.kind === 'structured_record') {
        for (const f of block.fields) {
          if (f.value.en.trim().length === 0 || f.value.es.trim().length === 0) {
            missing.push(`record:${block.id}:${f.key}`);
          }
        }
      } else if (block.kind === 'product_safe_content') {
        if (block.title.en.trim().length === 0 || block.title.es.trim().length === 0) missing.push(`product:${block.id}:title`);
        if (block.summary.en.trim().length === 0 || block.summary.es.trim().length === 0) missing.push(`product:${block.id}:summary`);
      } else if (block.kind === 'image') {
        if (block.alt.en.trim().length === 0) missing.push(`image:${block.id}:alt.en`);
        if (block.alt.es.trim().length === 0) missing.push(`image:${block.id}:alt.es`);
      }
    }
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  }

  async function applyPreview(): Promise<AuthoringSnapshot> {
    const v = validateForPreview(current);
    if (!v.ok) {
      const message = `not preview-ready: ${v.missing.join(', ')}`;
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'validation',
        command: { type: 'preview_from_snapshot' },
        result: 'error',
        code: 'E_INVALID_PROPOSAL',
        message,
      });
      return commit(withError(current, 'E_INVALID_PROPOSAL', message));
    }
    try {
      const result = await api.previewFromSnapshot({ tenantId, recordId, snapshot: current, actor });
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_call',
        command: { type: 'preview_from_snapshot' },
        result: 'ok',
        message: result.previewUrl,
      });
      return commit({
        ...current,
        visibleState: 'preview_ready',
        revisionId: result.revisionId,
        lastError: null,
      });
    } catch (err) {
      const apiCode = errorCode(err);
      const message = err instanceof Error ? err.message : 'preview failed';
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_error',
        command: { type: 'preview_from_snapshot' },
        result: 'error',
        code: apiCode,
        message,
      });
      return commit(withError(current, apiCode, message));
    }
  }

  async function applyPropose(cmd: ProposeCommand): Promise<AuthoringSnapshot> {
    if (current.visibleState !== 'preview_ready' && current.visibleState !== 'editing') {
      throw new StoreError('E_NOT_PREVIEW_READY', `cannot propose from state ${current.visibleState}`);
    }
    const v = validateForPreview(current);
    if (!v.ok) {
      const message = `proposal validation failed: ${v.missing.join(', ')}`;
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'validation',
        command: cmd,
        result: 'error',
        code: 'E_INVALID_PROPOSAL',
        message,
      });
      return commit(withError(current, 'E_INVALID_PROPOSAL', message));
    }
    try {
      const result = await api.propose({ tenantId, recordId, snapshot: current, actor, idempotencyKey: cmd.idempotencyKey });
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_call',
        command: cmd,
        result: 'ok',
        message: result.proposal.id,
      });
      return commit({
        ...current,
        visibleState: 'proposed',
        proposalId: result.proposal.id,
        revisionId: result.revision.id,
        pendingEdits: freeze([]),
        lastError: null,
      });
    } catch (err) {
      const apiCode = errorCode(err);
      const message = err instanceof Error ? err.message : 'propose failed';
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_error',
        command: cmd,
        result: 'error',
        code: apiCode,
        message,
      });
      return commit(withError(current, apiCode, message));
    }
  }

  async function applyApprove(cmd: ApproveCommand): Promise<AuthoringSnapshot> {
    guardHumanOnly(actor, 'approve');
    if (current.proposalId === null) throw new StoreError('E_NO_PROPOSAL', 'no proposal to approve');
    if (current.visibleState !== 'proposed' && current.visibleState !== 'preview_ready' && current.visibleState !== 'approved') {
      throw new StoreError('E_NOT_PREVIEW_READY', `cannot approve from state ${current.visibleState}`);
    }
    try {
      const result = await api.approve({ tenantId, recordId, proposalId: current.proposalId, actor, ifMatch: cmd.ifMatch, idempotencyKey: cmd.idempotencyKey });
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_call',
        command: cmd,
        result: 'ok',
        message: result.approval.id,
      });
      return commit({
        ...current,
        visibleState: 'approved',
        revisionId: result.approval.revisionId,
        lastError: null,
      });
    } catch (err) {
      const apiCode = errorCode(err);
      const message = err instanceof Error ? err.message : 'approve failed';
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_error',
        command: cmd,
        result: 'error',
        code: apiCode,
        message,
      });
      return commit(withError(current, apiCode, message));
    }
  }

  /**
   * Derive the visible state from a deploy status. Publishes that
   * succeed promote to `live`; in-flight publishes promote to
   * `deploy_pending`; everything else keeps the prior state and
   * records an error so the UI can recover.
   */
  function derivePublishedState(deploy: DeployStatus): VisibleState {
    if (deploy.kind === 'succeeded') return 'live';
    if (deploy.kind === 'in_flight') return 'deploy_pending';
    return 'error';
  }

  async function applyPublish(cmd: PublishCommand): Promise<AuthoringSnapshot> {
    guardHumanOnly(actor, 'publish');
    if (current.proposalId === null) throw new StoreError('E_NO_PROPOSAL', 'no proposal to publish');
    if (current.visibleState !== 'approved' && current.visibleState !== 'canonical_written' && current.visibleState !== 'deploy_pending') {
      throw new StoreError('E_NOT_APPROVED', `cannot publish from state ${current.visibleState}`);
    }
    try {
      const result = await api.publish({ tenantId, recordId, proposalId: current.proposalId, actor, ifMatch: cmd.ifMatch, idempotencyKey: cmd.idempotencyKey });
      const nextVisible = derivePublishedState(result.deployStatus);
      const succeeded = nextVisible === 'live';
      const deployedRevisionId = succeeded ? current.revisionId : current.deployedRevisionId;
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_call',
        command: cmd,
        result: nextVisible === 'error' ? 'error' : 'ok',
        message: `publish ${result.publication.id} deploy=${result.deployStatus.kind}`,
      });
      if (nextVisible === 'error') {
        const message = `publish did not converge (deploy=${result.deployStatus.kind})`;
        recordAudit({
          id: internals.nextId(),
          at: internals.now(),
          actor,
          kind: 'validation',
          command: cmd,
          result: 'error',
          code: 'E_NOT_DEPLOY_READY',
          message,
        });
        return commit({
          ...current,
          deployStatus: result.deployStatus,
          visibleState: 'error',
          lastError: freeze({ code: 'E_NOT_DEPLOY_READY', message }),
        });
      }
      return commit({
        ...current,
        visibleState: nextVisible,
        deployStatus: result.deployStatus,
        deployedRevisionId,
        lastError: null,
      });
    } catch (err) {
      const apiCode = errorCode(err);
      const message = err instanceof Error ? err.message : 'publish failed';
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_error',
        command: cmd,
        result: 'error',
        code: apiCode,
        message,
      });
      return commit(withError(current, apiCode, message));
    }
  }

  async function applyRollback(cmd: RollbackCommand): Promise<AuthoringSnapshot> {
    guardHumanOnly(actor, 'rollback');
    if (current.proposalId === null) throw new StoreError('E_NO_PROPOSAL', 'no proposal to rollback');
    if (current.visibleState !== 'live' && !isFailureVisible(current.visibleState)) {
      throw new StoreError('E_NOT_LIVE', `cannot rollback from state ${current.visibleState}`);
    }
    const previousRevisionId = current.deployedRevisionId;
    try {
      const result = await api.rollback({ tenantId, recordId, proposalId: current.proposalId, actor, ifMatch: cmd.ifMatch, idempotencyKey: cmd.idempotencyKey });
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'rollback',
        command: cmd,
        result: 'ok',
        message: `rolled back to ${result.rolledBackTo} (was ${previousRevisionId ?? 'none'})`,
      });
      return commit({
        ...current,
        visibleState: 'canonical_written',
        deployStatus: result.deployStatus,
        deployedRevisionId: result.rolledBackTo,
        lastError: null,
      });
    } catch (err) {
      const apiCode = errorCode(err);
      const message = err instanceof Error ? err.message : 'rollback failed';
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_error',
        command: cmd,
        result: 'error',
        code: apiCode,
        message,
      });
      return commit(withError(current, apiCode, message));
    }
  }


  async function applyReconcile(): Promise<AuthoringSnapshot> {
    // Human identity is enforced at the dispatch boundary.
    if (!RECONCILABLE_STATES.has(current.visibleState)) {
      const message = `cannot reconcile from state ${current.visibleState}`;
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'validation',
        command: { type: 'reconcile' },
        result: 'error',
        code: 'E_RECONCILE_FORBIDDEN',
        message,
      });
      throw new StoreError('E_RECONCILE_FORBIDDEN', message);
    }
    try {
      const result = await api.reconcile({ tenantId, recordId, actor });
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_call',
        command: { type: 'reconcile' },
        result: 'ok',
        message: result.deployedRevisionId ?? 'none',
      });
      const deployKind = result.deployStatus.kind;
      const nextVisible: VisibleState =
        deployKind === 'succeeded' ? 'live'
          : deployKind === 'in_flight' ? 'deploy_pending'
          : deployKind === 'rolled_back' ? 'rolled_back'
          : 'canonical_written';
      return commit({
        ...current,
        visibleState: nextVisible,
        deployStatus: result.deployStatus,
        deployedRevisionId: result.deployedRevisionId,
        lastError: null,
      });
    } catch (err) {
      const apiCode = errorCode(err);
      const message = err instanceof Error ? err.message : 'reconcile failed';
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_error',
        command: { type: 'reconcile' },
        result: 'error',
        code: apiCode,
        message,
      });
      return commit(withError(current, apiCode, message));
    }
  }

  async function applyRefresh(): Promise<AuthoringSnapshot> {
    try {
      const next = await api.loadRecord({ tenantId, recordId, locale }, actor);
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_call',
        command: { type: 'refresh' },
        result: 'ok',
        message: 'loaded',
      });
      return commit({ ...next, preference: current.preference, pendingEdits: freeze([]), visibleState: next.visibleState });
    } catch (err) {
      const apiCode = errorCode(err);
      const message = err instanceof Error ? err.message : 'refresh failed';
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'api_error',
        command: { type: 'refresh' },
        result: 'error',
        code: apiCode,
        message,
      });
      return commit(withError(current, apiCode, message));
    }
  }

  async function dispatch(command: Command, options: DispatchOptions = {}): Promise<DispatchResult> {
    const previousState = current.visibleState;
    const auditBefore = audit.length;
    const isDry = options.dryRun === true;
    try {
      let next: AuthoringSnapshot;
      switch (command.type) {
        case 'edit_text': next = applyEditText(command); break;
        case 'edit_record_field': next = applyEditRecordField(command); break;
        case 'edit_product': next = applyEditProduct(command); break;
        case 'edit_image_alt': next = applyEditImageAlt(command); break;
        case 'edit_image_crop': next = applyEditImageCrop(command); break;
        case 'reorder_block': next = applyReorder(command); break;
        case 'hide_block': next = applyHide(command); break;
        case 'duplicate_block': next = applyDuplicate(command); break;
        case 'insert_block': next = applyInsert(command); break;
        case 'undo_local_edit': next = applyUndo(command); break;
        case 'set_preference': next = applySetPreference(command); break;
        case 'upload_media':
          if (isDry) { next = current; }
          else { next = await applyUpload(command); }
          break;
        case 'replace_media':
          if (isDry) { next = current; }
          else { next = await applyReplace(command); }
          break;
        case 'preview_from_snapshot':
          if (isDry) { next = current; }
          else { next = await applyPreview(); }
          break;
        case 'propose':
          if (isDry) { next = current; }
          else { next = await applyPropose(command); }
          break;
        case 'approve':
          guardHumanOnly(actor, 'approve');
          if (isDry) { next = current; }
          else { next = await applyApprove(command); }
          break;
        case 'publish':
          guardHumanOnly(actor, 'publish');
          if (isDry) { next = current; }
          else { next = await applyPublish(command); }
          break;
        case 'rollback':
          guardHumanOnly(actor, 'rollback');
          if (isDry) { next = current; }
          else { next = await applyRollback(command); }
          break;
        case 'reconcile':
          guardHumanOnly(actor, 'reconcile');
          if (isDry) { next = current; }
          else { next = await applyReconcile(); }
          break;
        case 'refresh':
          if (isDry) { next = current; }
          else { next = await applyRefresh(); }
          break;
        default: {
          const exhaustive: never = command;
          throw new StoreError('E_INVALID_SNAPSHOT', `unhandled command: ${String(exhaustive)}`);
        }
      }
      const commandFailed = next.lastError !== null;
      recordAudit({
        id: internals.nextId(),
        at: internals.now(),
        actor,
        kind: 'command',
        command,
        result: commandFailed ? 'error' : 'ok',
        ...(commandFailed && next.lastError !== null ? { code: next.lastError.code } : {}),
        message: isDry ? `dry-run ${command.type}` : `${previousState}->${next.visibleState} via ${command.type}`,
      });
      const newEntries = audit.slice(auditBefore);
      return { snapshot: next, audit: newEntries };
    } catch (err) {
      if (err instanceof ServiceAuthorityDeniedError) {
        recordAudit({
          id: internals.nextId(),
          at: internals.now(),
          actor,
          kind: 'rejected_privilege',
          command,
          result: 'denied',
          code: err.code,
          message: err.message,
        });
      } else {
        // Surface every other error on the audit log with the actual
        // outcome (`error`). This includes synchronous validation
        // throws (e.g. unknown block) and async API throws that were
        // re-thrown by applyUpload / applyReplace.
        recordAudit({
          id: internals.nextId(),
          at: internals.now(),
          actor,
          kind: err instanceof StoreError || err instanceof DomainInvariantError ? 'validation' : 'api_error',
          command,
          result: 'error',
          code: err instanceof StoreError || err instanceof DomainInvariantError ? err.code : 'E_API_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  function undoLastLocalEdit(): AuthoringSnapshot {
    if (current.pendingEdits.length === 0) return current;
    const last = current.pendingEdits[current.pendingEdits.length - 1];
    if (last === undefined) return current;
    // Reuse the unified reverseEdit helper. If it throws
    // E_NOT_REVERSIBLE, the caller learns it must propose or restart;
    // the pending-edits ledger is NOT trimmed on failure.
    const reversed = reverseEdit(current, last);
    const trimmed = current.pendingEdits.filter((e) => e.id !== last.id);
    return commit({ ...reversed, pendingEdits: freeze(trimmed) });
  }

  function focusTargetFor(kind: 'next_block' | 'previous_block' | 'first_invalid', currentBlockId?: string): string | null {
    const blocks = current.blocks;
    if (blocks.length === 0) return null;
    if (kind === 'first_invalid') {
      for (const b of blocks) {
        if (b.kind === 'text' && (b.value.en.trim().length === 0 || b.value.es.trim().length === 0)) return b.focusKey;
        if (b.kind === 'image' && (b.alt.en.trim().length === 0 || b.alt.es.trim().length === 0)) return b.focusKey;
      }
      return null;
    }
    if (currentBlockId === undefined) return blocks[0]?.focusKey ?? null;
    const idx = blocks.findIndex((b) => b.id === currentBlockId);
    if (idx < 0) return blocks[0]?.focusKey ?? null;
    if (kind === 'next_block') {
      const next = blocks[idx + 1];
      return next ? next.focusKey : null;
    }
    const prev = blocks[idx - 1];
    return prev ? prev.focusKey : null;
  }

  function isPreviewReady(): boolean {
    return validateForPreview(current).ok;
  }

  return {
    snapshot: () => current,
    history: () => audit,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch,
    undoLastLocalEdit,
    focusTargetFor,
    isPreviewReady,
  };
}



function assertLocalized(value: LocalizedValue): void {
  if (typeof value.en !== 'string' || value.en.trim().length === 0) {
    throw new StoreError('E_MISSING_ALT_LOCALE', 'localized value missing en');
  }
  if (typeof value.es !== 'string' || value.es.trim().length === 0) {
    throw new StoreError('E_MISSING_ALT_LOCALE', 'localized value missing es');
  }
}