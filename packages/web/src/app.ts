/**
 * `app.ts` — the thin event-binding layer over the template renderer.
 *
 * Design contract:
 *   - Framework-free: zero dependencies on any UI library, no virtual DOM,
 *     no global state. Imports only `@cms/i18n` and the sibling `model.js`.
 *   - Progressive enhancement: the page is fully usable when JS is disabled
 *     because `template.ts` produces a complete HTML5 surface with native
 *     controls. JS only enhances event handling.
 *   - Keyboard-complete: every action has a real `<button>`, every input
 *     has a real `<label>`, every landmark is reachable via Tab. Tab order
 *     is left-to-right, top-to-bottom within each region — no roving
 *     tabindex overrides that put decorative elements ahead of controls.
 *   - Focus restoration: after every command we record the originating
 *     element so we can return focus to it on completion. Errors move
 *     focus to the error summary region.
 *   - Live regions: polite `role="status"` for success confirmations and
 *     assertive `role="log"` for errors that block an action.
 *   - Confirmation: publish, rollback, and approve require an explicit
 *     native confirmation (no implicit transitions). On cancel, no command
 *     is dispatched and focus stays on the originating element.
 *   - No implicit submission: `<form>` elements never submit implicitly;
 *     the only path to a privileged action is its dedicated button.
 *   - All commands use the actual `Command` discriminator (`type`) and go
 *     through `store.dispatch`, which returns `Promise<DispatchResult>`.
 */

import { createTranslator, type Locale, type Translator } from '@cms/i18n';

import {
  type ApproveCommand,
  type AuthoringApi,
  type AuthoringSnapshot,
  type AuthoringStore,
  type AuthoringStoreConfig,
  type Command,
  type CropSpec,
  type EditImageAltCommand,
  type EditImageCropCommand,
  type EditRecordFieldCommand,
  type EditProductCommand,
  type EditTextCommand,
  type ImageBlock,
  type PreviewFromSnapshotCommand,
  type ProposeCommand,
  type PublishCommand,
  type ReconcileCommand,
  type ReorderBlockCommand,
  type HideBlockCommand,
  type DuplicateBlockCommand,
  type InsertBlockCommand,
  type RollbackCommand,
  type UndoLocalEditCommand,
  type UploadMediaCommand,
  type ReplaceMediaCommand,
  createAuthoringStore,
} from './model.js';

import { renderTemplate } from './template.js';

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/** Minimal DOM adapter required by the app layer. */
export interface DomAdapter {
  query(root: ParentNode, selector: string): Element | null;
  queryAll(root: ParentNode, selector: string): ReadonlyArray<Element>;
  create<K extends keyof ElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string>>, children?: ReadonlyArray<Node | string>): ElementTagNameMap[K];
  addEventListener<K extends keyof HTMLElementEventMap>(
    target: Element,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: { capture?: boolean; passive?: boolean },
  ): () => void;
  removeEventListener(handle: () => void): void;
  dispatch(target: Element, event: Event): boolean;
  focus(target: Element | null): void;
  activeElement(root: ParentNode): Element | null;
  textOf(target: Element): string;
  setText(target: Element, value: string): void;
  setHidden(target: Element, hidden: boolean): void;
  setDisabled(target: Element, disabled: boolean): void;
  attr(target: Element, name: string, value?: string | null): string | null;
  prop<K extends string>(target: Element, name: K, value?: unknown): unknown;
  preventDefault(event: Event): void;
  closest(start: Element, selector: string): Element | null;
  nextFocusable(root: ParentNode, current: Element): Element | null;
  previousFocusable(root: ParentNode, current: Element): Element | null;
  prefersReducedMotion(): boolean;
  prefersHighContrast(): boolean;
  confirm(message: string, title: string): boolean;
}

/** Native browser implementation of the DOM seam used by `bootstrap`. */
export function createBrowserDomAdapter(doc: Document = document): DomAdapter {
  const focusables = (root: ParentNode): Element[] =>
    Array.from(root.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ));

  return {
    query: (root, selector) => root.querySelector(selector),
    queryAll: (root, selector) => Array.from(root.querySelectorAll(selector)),
    create(tag, attrs, children = []) {
      const element = doc.createElement(tag);
      for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
      for (const child of children) {
        element.append(typeof child === 'string' ? doc.createTextNode(child) : child);
      }
      return element as ElementTagNameMap[typeof tag];
    },
    addEventListener(target, type, handler, options) {
      const listener = handler as EventListener;
      target.addEventListener(type, listener, options);
      return () => target.removeEventListener(type, listener, options);
    },
    removeEventListener: (handle) => handle(),
    dispatch: (target, event) => target.dispatchEvent(event),
    focus(target) {
      if (target instanceof HTMLElement) target.focus();
    },
    activeElement: (root) => root.ownerDocument?.activeElement ?? doc.activeElement,
    textOf: (target) => target.textContent ?? '',
    setText(target, value) { target.textContent = value; },
    setHidden(target, hidden) {
      if (target instanceof HTMLElement) target.hidden = hidden;
      else if (hidden) target.setAttribute('hidden', '');
      else target.removeAttribute('hidden');
    },
    setDisabled(target, disabled) {
      if ('disabled' in target) (target as HTMLButtonElement).disabled = disabled;
      else target.setAttribute('aria-disabled', String(disabled));
    },
    attr(target, name, value) {
      if (value === undefined) return target.getAttribute(name);
      if (value === null) target.removeAttribute(name);
      else target.setAttribute(name, value);
      return target.getAttribute(name);
    },
    prop(target, name, value) {
      const record = target as unknown as Record<string, unknown>;
      if (value === undefined) return record[name];
      record[name] = value;
      return value;
    },
    preventDefault: (event) => event.preventDefault(),
    closest: (start, selector) => start.closest(selector),
    nextFocusable(root, current) {
      const elements = focusables(root);
      const index = elements.indexOf(current);
      return index >= 0 ? elements[index + 1] ?? null : elements[0] ?? null;
    },
    previousFocusable(root, current) {
      const elements = focusables(root);
      const index = elements.indexOf(current);
      return index > 0 ? elements[index - 1] ?? null : null;
    },
    prefersReducedMotion: () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    prefersHighContrast: () => globalThis.matchMedia?.('(prefers-contrast: more)').matches ?? false,
    confirm: (message, title) => globalThis.confirm(`${title}\n\n${message}`),
  };
}

/** Storage for low-distraction mode + accessibility preferences. */
export interface PreferenceStore {
  load(): { readonly lowDistraction: boolean; readonly reduceMotion: boolean };
  save(prefs: { readonly lowDistraction: boolean; readonly reduceMotion: boolean }): void;
}

export interface BootstrapOptions {
  readonly root: Element;
  readonly api: AuthoringApi;
  readonly translator: Translator;
  readonly snapshot: AuthoringSnapshot;
  readonly preferences?: PreferenceStore;
  readonly dom: DomAdapter;
  readonly scopeId?: string;
  readonly tenantId?: string;
  readonly recordId?: string;
  readonly contentType?: string;
}

export interface BootstrapHandle {
  render(): void;
  onCommand(handler: (command: Command) => void): () => void;
  destroy(): void;
  store(): AuthoringStore;
}

const PRIVILEGED_ACTIONS = new Set(['approve', 'publish', 'rollback']);
// `reconcile` mutates canonical deploy state but is initiated from the
// renderer's deploy region; gate it through a governed confirmation that
// resolves the localized title via the active translator.
const GOVERNED_CONFIRM_ACTIONS: Readonly<Record<string, string>> = {
  reconcile: 'reconcile.confirmTitle',
};
// Maps action button names to their success announcement message keys.
const ACTION_DONE_KEYS: Readonly<Record<string, string>> = {
  preview: 'action.preview.done',
  propose: 'action.propose.done',
  approve: 'action.approve.done',
  publish: 'action.publish.done',
  rollback: 'action.rollback.done',
  reconcile: 'action.reconcile.done',
};
// Preference-toggle buttons announce the resulting state via a localized
// key resolved against the preference key and next value.
const PREFERENCE_ANNOUNCE_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  lowDistraction: {
    'true': 'a11y.lowDistraction.on',
    'false': 'a11y.lowDistraction.off',
  },
  reduceMotion: {
    'true': 'a11y.reducedMotion.on',
    'false': 'a11y.reducedMotion.off',
  },
};

// --------------------------------------------------------------------------
// Bootstrap
// --------------------------------------------------------------------------

export function bootstrap(options: BootstrapOptions): BootstrapHandle {
  const dom = options.dom;
  let t = options.translator;
  const scope = options.scopeId ?? 'cms';
  const tenantId = options.tenantId ?? options.snapshot.tenantId;
  const recordId = options.recordId ?? options.snapshot.recordId;
  const contentType = options.contentType ?? options.snapshot.contentType;
  const persistedPreferences = options.preferences?.load();
  const initialSnapshot: AuthoringSnapshot = {
    ...options.snapshot,
    preference: {
      ...options.snapshot.preference,
      locale: options.snapshot.locale,
      ...(persistedPreferences === undefined ? {} : {
        lowDistraction: persistedPreferences.lowDistraction,
        reduceMotion: persistedPreferences.reduceMotion,
      }),
    },
  };

  const storeConfig: AuthoringStoreConfig = {
    tenantId,
    recordId,
    contentType,
    locale: options.snapshot.locale,
    api: options.api,
    actor: { kind: 'actor', id: 'bootstrap', displayName: 'Bootstrap', capabilities: [] },
    initial: initialSnapshot,
    preference: initialSnapshot.preference,
  };
  const store = createAuthoringStore(storeConfig);
  const handlers: Array<(command: Command) => void> = [];
  let bindingUnbinds: Array<() => void> = [];
  let deferRender = false;
  const render = (): void => {
    for (const unbind of bindingUnbinds) unbind();
    const snapshot = store.snapshot();
    const locale = snapshot.preference.locale;
    const documentElement = options.root.ownerDocument?.documentElement;
    if (documentElement !== undefined) {
      documentElement.lang = locale;
      const docEl = documentElement as unknown as { classList: { toggle(name: string, force?: boolean): void } };
      docEl.classList.toggle('cms-mode--low-distraction', snapshot.preference.lowDistraction === true);
      docEl.classList.toggle('cms-mode--reduce-motion', snapshot.preference.reduceMotion === true);
    }
    if (t.locale !== locale) t = createTranslator(locale);
    applyHtml(options.root, renderTemplate(
      { ...snapshot, locale },
      t,
      { scopeId: scope, fullDocument: false, auditEntries: store.history() },
    ));
    bindingUnbinds = wireBindings(options.root, store, () => t, dom, options.preferences, handlers, () => {
      deferRender = true;
      return () => { deferRender = false; };
    });
  };

  render();
  const unsubscribe = store.subscribe(() => {
    if (!deferRender) render();
  });

  return {
    render,
    onCommand(handler) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    destroy() {
      for (const unbind of bindingUnbinds) unbind();
      bindingUnbinds = [];
      unsubscribe();
    },
    store() {
      return store;
    },
  };
}

function applyHtml(root: Element, html: string): void {
  (root as unknown as { innerHTML: string }).innerHTML = html;
}

// --------------------------------------------------------------------------
// Event bindings
// --------------------------------------------------------------------------

function emitCommand(handlers: ReadonlyArray<(command: Command) => void>, command: Command): void {
  for (const handler of handlers) handler(command);
}

function wireBindings(
  root: Element,
  store: AuthoringStore,
  translator: () => Translator,
  dom: DomAdapter,
  preferences: PreferenceStore | undefined,
  handlers: ReadonlyArray<(command: Command) => void>,
  beginInputDispatch: () => () => void,
): Array<() => void> {
  const t = translator();
  const unbinds: Array<() => void> = [];
  const liveStatus = dom.query(root, '[data-cms-live="status"]');
  const liveLog = dom.query(root, '[data-cms-live="log"]');
  const errorSummary = dom.query(root, '[data-cms-region="errors"]');

  const dispatchInput = (command: Command): void => {
    const before = dom.activeElement(root);
    emitCommand(handlers, command);
    const finish = beginInputDispatch();
    store.dispatch(command).catch((err: unknown) => {
      announceError(liveLog, errorSummary, err, translator(), dom);
      // Error-summary focus takes precedence: once we have announced
      // the failure we must not steal focus back to the originating
      // input, otherwise screen-reader users lose context.
    }).finally(() => {
      finish();
      const undoButton = dom.query(root, '[data-cms-action="undo-local-edit"]');
      if (undoButton !== null) {
        dom.setDisabled(undoButton, store.snapshot().pendingEdits.length === 0);
      }
      // If focus has not moved (still pointing at the originating DOM
      // reference the user was typing into), keep it there. The store
      // subscription may trigger a full re-render that replaces the
      // children; the originating element is restored so caret and
      // selection survive — except when the error summary has taken
      // focus, in which case we must not steal it back.
      const summaryFocused = errorSummary !== null && dom.activeElement(root) === errorSummary;
      if (before !== null && !summaryFocused) dom.focus(before);
    });
  };

  // Locale switcher.
  const localeSelect = dom.query(root, '[data-cms-control="locale"]');
  if (localeSelect !== null) {
    unbinds.push(
      dom.addEventListener(localeSelect, 'change', (event) => {
        dom.preventDefault(event);
        const value = String(dom.prop(localeSelect, 'value') ?? '');
        if (value !== 'en' && value !== 'es') return;
        const command: Command = { type: 'set_preference', preference: { locale: value as Locale } };
        emitCommand(handlers, command);
        store.dispatch(command).then(() => {
          const renderedLocaleSelect = dom.query(root, '[data-cms-control="locale"]');
          if (renderedLocaleSelect !== null) dom.focus(renderedLocaleSelect);
        }).catch((err: unknown) => {
          announceError(liveLog, errorSummary, err, translator(), dom);
        });
      }),
    );
  }

  // Preference buttons (low-distraction / reduce-motion) are routed
  // through the unified action handler below so the localized
  // announcement and focus behavior share the same code path as
  // other governed actions. The handler reads `data-cms-preference`
  // and `data-cms-preference-value` off the button.
  // Action buttons.
  for (const button of dom.queryAll(root, '[data-cms-action]')) {
    const action = dom.attr(button, 'data-cms-action') ?? '';
    unbinds.push(
      dom.addEventListener(button, 'click', (event) => {
        dom.preventDefault(event);
        void handleAction(action, button, store, t, dom, liveStatus, liveLog, errorSummary, handlers, root, preferences);
      }),
    );
  }

  // Text input bindings.
  for (const input of dom.queryAll(root, '[data-cms-input="text"]')) {
    unbinds.push(
      dom.addEventListener(input, 'input', (event) => {
        dom.preventDefault(event);
        const blockId = dom.attr(input, 'data-cms-block-id');
        const locale = dom.attr(input, 'data-cms-locale');
        if (blockId === null || locale === null) return;
        if (locale !== 'en' && locale !== 'es') return;
        const cmd: EditTextCommand = {
          type: 'edit_text',
          blockId,
          locale,
          value: String(dom.prop(input, 'value') ?? ''),
        };
        dispatchInput(cmd);
      }),
    );
  }

  // Structured record field bindings.
  for (const input of dom.queryAll(root, '[data-cms-input="record-field"]')) {
    unbinds.push(
      dom.addEventListener(input, 'input', (event) => {
        dom.preventDefault(event);
        const blockId = dom.attr(input, 'data-cms-block-id');
        const fieldKey = dom.attr(input, 'data-cms-field-key');
        const locale = dom.attr(input, 'data-cms-locale');
        if (
          blockId === null ||
          fieldKey === null ||
          (locale !== 'en' && locale !== 'es')
        ) return;
        const cmd: EditRecordFieldCommand = {
          type: 'edit_record_field',
          blockId,
          fieldKey,
          locale,
          value: String(dom.prop(input, 'value') ?? ''),
        };
        dispatchInput(cmd);
      }),
    );
  }

  // Safe product content bindings. Price and commerce fields have no input.
  for (const input of dom.queryAll(root, '[data-cms-input="product-title"], [data-cms-input="product-summary"]')) {
    unbinds.push(
      dom.addEventListener(input, 'input', (event) => {
        dom.preventDefault(event);
        const blockId = dom.attr(input, 'data-cms-block-id');
        const locale = dom.attr(input, 'data-cms-locale');
        const field = dom.attr(input, 'data-cms-input');
        if (
          blockId === null ||
          (locale !== 'en' && locale !== 'es') ||
          (field !== 'product-title' && field !== 'product-summary')
        ) return;
        const block = store.snapshot().blocks.find(
          (candidate) => candidate.id === blockId && candidate.kind === 'product_safe_content',
        );
        if (block === undefined || block.kind !== 'product_safe_content') return;
        const value = String(dom.prop(input, 'value') ?? '');
        const localized = locale === 'en'
          ? { en: value, es: field === 'product-title' ? block.title.es : block.summary.es }
          : { en: field === 'product-title' ? block.title.en : block.summary.en, es: value };
        const cmd: EditProductCommand = field === 'product-title'
          ? { type: 'edit_product', blockId, title: localized }
          : { type: 'edit_product', blockId, summary: localized };
        dispatchInput(cmd);
      }),
    );
  }
  // Image alt-text bindings (en + es).
  for (const input of dom.queryAll(root, '[data-cms-input="alt"]')) {
    unbinds.push(
      dom.addEventListener(input, 'input', (event) => {
        dom.preventDefault(event);
        const blockId = dom.attr(input, 'data-cms-block-id');
        const locale = dom.attr(input, 'data-cms-locale');
        if (blockId === null || locale === null) return;
        if (locale !== 'en' && locale !== 'es') return;
        const snapshot = store.snapshot();
        const block = snapshot.blocks.find((b): b is ImageBlock => b.id === blockId && b.kind === 'image');
        if (block === undefined) return;
        const value = String(dom.prop(input, 'value') ?? '');
        const alt = locale === 'es'
          ? { en: block.alt.en, es: value }
          : { en: value, es: block.alt.es };
        const cmd: EditImageAltCommand = { type: 'edit_image_alt', blockId, alt };
        dispatchInput(cmd);
      }),
    );
  }

  // Crop and focal-point inputs share the rendered crop form.
  for (const form of dom.queryAll(root, '[data-cms-form="crop"]')) {
    unbinds.push(
      dom.addEventListener(form, 'submit', (event) => {
        dom.preventDefault(event);
        const blockId = dom.attr(form, 'data-cms-block-id');
        if (blockId === null) return;
        const block = store.snapshot().blocks.find((b): b is ImageBlock => b.id === blockId && b.kind === 'image');
        if (block === undefined) return;
        const readNumber = (selector: string, fallback: number): number => {
          const input = dom.query(form, selector);
          return input === null ? fallback : Number(dom.prop(input, 'value'));
        };
        const crop: CropSpec = {
          x: readNumber('[data-cms-input="crop-x"]', block.crop.x),
          y: readNumber('[data-cms-input="crop-y"]', block.crop.y),
          width: readNumber('[data-cms-input="crop-w"]', block.crop.width),
          height: readNumber('[data-cms-input="crop-h"]', block.crop.height),
          focalX: readNumber('[data-cms-input="focal-x"]', block.crop.focalX),
          focalY: readNumber('[data-cms-input="focal-y"]', block.crop.focalY),
        };
        const cmd: EditImageCropCommand = { type: 'edit_image_crop', blockId, crop };
        emitCommand(handlers, cmd);
        store.dispatch(cmd).catch((err: unknown) => {
          announceError(liveLog, errorSummary, err, translator(), dom);
        });
      }),
    );
  }

  // Upload / replace forms consume the selected File through the DOM adapter.
  for (const form of dom.queryAll(root, '[data-cms-form="upload"], [data-cms-form="replace"]')) {
    unbinds.push(
      dom.addEventListener(form, 'submit', (event) => {
        dom.preventDefault(event);
        const blockId = dom.attr(form, 'data-cms-block-id');
        if (blockId === null) return;
        const block = store.snapshot().blocks.find((b): b is ImageBlock => b.id === blockId && b.kind === 'image');
        const fileInput = dom.query(form, 'input[type="file"]');
        const files = fileInput === null ? null : dom.prop(fileInput, 'files') as FileList | readonly File[] | null;
        const file = files?.[0];
        if (block === undefined || file === undefined) {
          announceError(liveLog, errorSummary, new Error('No file selected'), translator(), dom);
          return;
        }
        void file.arrayBuffer().then((buffer) => {
          const bytes = new Uint8Array(buffer);
          const mimeType = file.type || 'application/octet-stream';
          const isReplace = dom.attr(form, 'data-cms-form') === 'replace';
          const cmd: UploadMediaCommand | ReplaceMediaCommand = isReplace
            ? { type: 'replace_media', blockId, assetId: block.assetId, bytes, mimeType, alt: block.alt, crop: block.crop }
            : { type: 'upload_media', blockId, bytes, mimeType, alt: block.alt, crop: block.crop };
          emitCommand(handlers, cmd);
          return store.dispatch(cmd);
        }).catch((err: unknown) => announceError(liveLog, errorSummary, err, translator(), dom));
      }),
    );
  }

  // Block reorder / hide / duplicate / insert are dispatched on button click
  // through the unified action handler.

  // Audit list: history-load-more is wired through action handler.
  // Undo: dispatched on the action button click.

  // Form submit guard: never submit text/locale/forms implicitly.
  for (const form of dom.queryAll(root, 'form')) {
    if (dom.attr(form, 'data-cms-no-submit') === 'true') continue;
    unbinds.push(
      dom.addEventListener(form, 'submit', (event) => {
        dom.preventDefault(event);
      }),
    );
  }

  return unbinds;
}

// --------------------------------------------------------------------------
// Privileged action handling
// --------------------------------------------------------------------------

async function handleAction(
  action: string,
  button: Element,
  store: AuthoringStore,
  t: Translator,
  dom: DomAdapter,
  liveStatus: Element | null,
  liveLog: Element | null,
  errorSummary: Element | null,
  handlers: ReadonlyArray<(command: Command) => void>,
  root: Element,
  preferences: PreferenceStore | undefined,
): Promise<void> {
  const before = dom.activeElement(root);
  // Privileged commands require an explicit native confirmation. We never
  // auto-approve, publish, or rollback. Governed deploy mutations
  // (`reconcile`) require a localized confirmation resolved through the
  // active translator so the prompt reads in the operator's locale.
  if (PRIVILEGED_ACTIONS.has(action) || GOVERNED_CONFIRM_ACTIONS[action] !== undefined) {
    const titleKey = GOVERNED_CONFIRM_ACTIONS[action];
    const titleLabel = titleKey !== undefined
      ? (t as unknown as (k: string) => string)(titleKey)
      : (dom.attr(button, 'data-confirm') ?? action);
    const bodyLabel = titleKey !== undefined
      ? (t as unknown as (k: string) => string)(`${titleKey.replace(/\.confirmTitle$/, '.confirmBody')}`)
      : titleLabel;
    const confirmed = dom.confirm(bodyLabel, titleLabel);
    if (!confirmed) {
      // Cancelled: no command dispatched, focus stays on the button.
      return;
    }
  }

  const snapshot = store.snapshot();
  const ifMatch = snapshot.revisionId ?? '';
  const idempotencyKey = `cms-${action}-${store.history().length + 1}`;

  let command: Command | null = null;
  switch (action) {
    case 'propose': {
      command = { type: 'propose', action: 'update', idempotencyKey } satisfies ProposeCommand;
      break;
    }
    case 'approve': {
      command = { type: 'approve', ifMatch, idempotencyKey } satisfies ApproveCommand;
      break;
    }
    case 'publish': {
      command = { type: 'publish', ifMatch, idempotencyKey } satisfies PublishCommand;
      break;
    }
    case 'rollback': {
      command = { type: 'rollback', ifMatch, idempotencyKey } satisfies RollbackCommand;
      break;
    }
    case 'preview': {
      command = { type: 'preview_from_snapshot' } satisfies PreviewFromSnapshotCommand;
      break;
    }
    case 'reconcile': {
      command = { type: 'reconcile' } satisfies ReconcileCommand;
      break;
    }
    case 'undo-local-edit': {
      const last = snapshot.pendingEdits[snapshot.pendingEdits.length - 1];
      if (last === undefined) return;
      command = { type: 'undo_local_edit', editId: last.id } satisfies UndoLocalEditCommand;
      break;
    }
    case 'block-reorder': {
      const direction = dom.attr(button, 'data-cms-action-direction') ?? 'down';
      const targetId = dom.attr(button, 'data-cms-block-id');
      if (targetId === null) return;
      const orderedIds = snapshot.blocks.map((b) => b.id);
      const index = orderedIds.indexOf(targetId);
      if (index < 0) return;
      const toIndex = direction === 'up' ? Math.max(0, index - 1) : Math.min(orderedIds.length - 1, index + 1);
      command = { type: 'reorder_block', blockId: targetId, toIndex } satisfies ReorderBlockCommand;
      break;
    }
    case 'block-hide': {
      const targetId = dom.attr(button, 'data-cms-block-id');
      if (targetId === null) return;
      command = { type: 'hide_block', blockId: targetId } satisfies HideBlockCommand;
      break;
    }
    case 'block-duplicate': {
      const targetId = dom.attr(button, 'data-cms-block-id');
      if (targetId === null) return;
      const toIndex = snapshot.blocks.findIndex((b) => b.id === targetId) + 1;
      command = { type: 'duplicate_block', blockId: targetId, toIndex } satisfies DuplicateBlockCommand;
      break;
    }
    case 'block-insert': {
      const atIndex = snapshot.blocks.length;
      const newId = `text-${idempotencyKey}`;
      command = {
        type: 'insert_block',
        atIndex,
        block: {
          id: newId,
          kind: 'text',
          hidden: false,
          focusKey: `${newId}-en`,
          value: { en: '', es: '' },
        },
      } satisfies InsertBlockCommand;
      break;
    }
    case 'set-preference': {
      // Template/model contract: data-cms-preference carries the
      // preference key (lowDistraction|reduceMotion) and
      // data-cms-preference-value carries the next boolean state.
      const key = dom.attr(button, 'data-cms-preference');
      const valueAttr = dom.attr(button, 'data-cms-preference-value');
      if (key !== 'lowDistraction' && key !== 'reduceMotion') return;
      const next = valueAttr === 'true';
      command = { type: 'set_preference', preference: { [key]: next } };
      break;
    }
    case 'upload-media':
    case 'replace-media':
    case 'edit-image-crop':
    case 'edit-image-alt':
    case 'edit-product':
    case 'edit-text':
    case 'edit-record-field':
    case 'refresh':
      // These commands are bound to dedicated forms / inputs, not buttons.
      return;
    default:
      return;
  }

  if (command === null) return;
  emitCommand(handlers, command);
  try {
    const result = await store.dispatch(command);
    if (result.snapshot.lastError !== null) {
      announceError(
        dom.query(root, '[data-cms-live="log"]') ?? liveLog,
        dom.query(root, '[data-cms-region="errors"]') ?? errorSummary,
        new Error(result.snapshot.lastError.message),
        t,
        dom,
      );
      return;
    }
    const currentStatus = dom.query(root, '[data-cms-live="status"]') ?? liveStatus;
    if (action === 'set-preference') {
      const prefKey = dom.attr(button, 'data-cms-preference');
      const valueAttr = dom.attr(button, 'data-cms-preference-value') ?? 'false';
      const lookup = prefKey !== null ? PREFERENCE_ANNOUNCE_KEYS[prefKey] : undefined;
      const announceKey = lookup?.[valueAttr];
      if (announceKey !== undefined) announce(currentStatus, t, announceKey, dom);
      preferences?.save({
        lowDistraction: result.snapshot.preference.lowDistraction,
        reduceMotion: result.snapshot.preference.reduceMotion,
      });
    } else {
      const doneKey = ACTION_DONE_KEYS[action];
      if (doneKey !== undefined) announce(currentStatus, t, doneKey, dom);
    }
    const currentButton = dom.query(root, `[data-cms-action="${action}"]`);
    dom.focus(currentButton ?? before ?? button);
  } catch (err: unknown) {
    announceError(
      dom.query(root, '[data-cms-live="log"]') ?? liveLog,
      dom.query(root, '[data-cms-region="errors"]') ?? errorSummary,
      err,
      t,
      dom,
    );
  }
}

// --------------------------------------------------------------------------
// Live-region announcements
// --------------------------------------------------------------------------

function announce(target: Element | null, t: Translator, key: string, dom: DomAdapter): void {
  if (target === null) return;
  const text = (t as unknown as (k: string) => string)(key);
  dom.setText(target, text);
}

function announceError(
  log: Element | null,
  summary: Element | null,
  err: unknown,
  t: Translator,
  dom: DomAdapter,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const genericText = (t as unknown as (k: string) => string)('errors.generic');
  const concrete = `${genericText}: ${message}`;
  if (summary !== null) {
    const runtimeMessage = dom.query(summary, '[data-cms-error-runtime]');
    if (runtimeMessage !== null) dom.setText(runtimeMessage, concrete);
    dom.setHidden(summary, false);
  }
  if (log !== null) {
    dom.setText(log, concrete);
  }
  if (summary !== null) {
    dom.focus(summary);
  }
}
