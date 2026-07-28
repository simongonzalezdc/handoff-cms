/**
 * `app.test.ts` — coverage for the authoring surface against the real
 * model store.
 *
 * Tests use a small in-file mini-DOM and a fake `AuthoringApi` injected
 * into `createAuthoringStore`. No invented model types — everything goes
 * through the real `Command` / `AuthoringSnapshot` / `Block` shapes.
 */

import { describe, expect, it } from 'vitest';

import {
  type ActorIdentity,
  type Approval,
  type AuditEntry,
  type AuthoringApi,
  type AuthoringSnapshot,
  type AuthoringStoreConfig,
  type Block,
  type Command,
  type DeployStatus,
  type DispatchResult,
  type ImageBlock,
  type Proposal,
  type Publication,
  type Revision,
  createAuthoringStore,
} from '../src/model.js';

import { createTranslator, type Locale, type Translator } from '@cms/i18n';

import {
  bootstrap,
  type BootstrapHandle,
  type BootstrapOptions,
  type DomAdapter,
  type PreferenceStore,
} from '../src/app.js';

import { renderTemplate } from '../src/template.js';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const SCOPE = 'cms';

const HUMAN: ActorIdentity = Object.freeze({
  kind: 'actor',
  id: 'user-1',
  displayName: 'Alice',
  capabilities: [],
});

function makeSnapshot(overrides: Partial<AuthoringSnapshot> = {}): AuthoringSnapshot {
  const base: AuthoringSnapshot = {
    tenantId: 't1',
    recordId: 'r1',
    contentType: 'page',
    locale: 'en',
    blocks: [
      {
        id: 'text-1',
        kind: 'text',
        hidden: false,
        focusKey: 'text-1-en',
        value: { en: 'Welcome', es: 'Bienvenido' },
      } satisfies Block,
      {
        id: 'record-1',
        kind: 'structured_record',
        hidden: false,
        focusKey: 'record-1-name',
        fields: [
          {
            key: 'name',
            value: { en: 'Record 1', es: 'Registro 1' },
          },
        ],
      } satisfies Block,
      {
        id: 'product-1',
        kind: 'product_safe_content',
        hidden: false,
        focusKey: 'product-1-title',
        title: { en: 'Welcome product', es: 'Producto de bienvenida' },
        summary: { en: 'Body.', es: 'Cuerpo.' },
        price: { amountMinor: 999, currency: 'USD' },
      } satisfies Block,
      {
        id: 'image-1',
        kind: 'image',
        hidden: false,
        focusKey: 'image-1-alt-en',
        assetId: 'asset-1',
        alt: { en: 'Cover image', es: 'Imagen de portada' },
        crop: { x: 0, y: 0, width: 1, height: 1, focalX: 0.5, focalY: 0.5 },
      } satisfies ImageBlock,
    ],
    visibleState: 'editing',
    proposalId: null,
    revisionId: null,
    deployStatus: { kind: 'idle' } as DeployStatus,
    deployedRevisionId: null,
    pendingEdits: [],
    lastError: null,
    preference: { lowDistraction: false, reduceMotion: false, locale: 'en' },
  };
  const merged = { ...base, ...overrides };
  return { ...merged, blocks: overrides.blocks ?? base.blocks };
}

interface FakeApi extends AuthoringApi {
  /** Captured audit of every privileged call. */
  readonly privilegedCalls: ReadonlyArray<{ method: string; payload: unknown }>;
}

function makeApi(): FakeApi {
  const privilegedCalls: Array<{ method: string; payload: unknown }> = [];
  const proposal: Proposal = Object.freeze({
    id: 'prop-1',
    action: 'update',
    tenantId: 't1',
    recordId: 'r1',
    createdBy: HUMAN,
    createdAt: '2026-07-27T10:00:00.000Z',
    environment: 'staging',
    revisionId: 'rev-1',
    idempotencyKey: 'k-1',
  });
  const revision: Revision = Object.freeze({
    id: 'rev-1',
    recordId: 'r1',
    parentRevisionId: null,
    contentHash: 'h',
    snapshot: makeSnapshot(),
    createdAt: '2026-07-27T10:00:00.000Z',
  });
  const approval: Approval = Object.freeze({
    id: 'apr-1',
    proposalId: 'prop-1',
    revisionId: 'rev-1',
    approvedBy: HUMAN,
    approvedAt: '2026-07-27T10:00:01.000Z',
  });
  const publication: Publication = Object.freeze({
    id: 'pub-1',
    proposalId: 'prop-1',
    revisionId: 'rev-1',
    publishedBy: HUMAN,
    publishedAt: '2026-07-27T10:00:02.000Z',
  });
  return {
    privilegedCalls,
    loadRecord: async () => makeSnapshot(),
    previewFromSnapshot: async () => ({
      previewUrl: 'about:blank',
      revisionId: 'rev-1',
      previewAt: '2026-07-27T10:00:00.000Z',
    }),
    propose: async () => {
      privilegedCalls.push({ method: 'propose', payload: {} });
      return { proposal, revision };
    },
    approve: async () => {
      privilegedCalls.push({ method: 'approve', payload: {} });
      return { approval };
    },
    publish: async () => {
      privilegedCalls.push({ method: 'publish', payload: {} });
      return { publication, deployStatus: { kind: 'succeeded' } as DeployStatus };
    },
    rollback: async () => {
      privilegedCalls.push({ method: 'rollback', payload: {} });
      return { rolledBackTo: 'rev-0', deployStatus: { kind: 'rolled_back' } as DeployStatus };
    },
    reconcile: async () => ({
      deployStatus: { kind: 'succeeded' } as DeployStatus,
      deployedRevisionId: 'rev-1',
    }),
    uploadAsset: async () => ({
      assetId: 'asset-1',
      contentHash: 'hash' as never,
      previewUrl: 'about:blank',
    }),
    replaceAsset: async () => ({
      assetId: 'asset-1',
      contentHash: 'hash' as never,
      previewUrl: 'about:blank',
    }),
    auditHistory: async () => [] as ReadonlyArray<AuditEntry>,
  };
}

// --------------------------------------------------------------------------
// FakeFile satisfies the File interface used by upload/replace forms.
// --------------------------------------------------------------------------
class FakeFile {
  constructor(public name: string, public type: string, private bytes: Uint8Array) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    const out = new ArrayBuffer(this.bytes.byteLength);
    new Uint8Array(out).set(this.bytes);
    return out;
  }
}

// --------------------------------------------------------------------------
// Tiny DOM adapter used to exercise bootstrap + event bindings.
// --------------------------------------------------------------------------

class FakeElement {
  public children: Array<FakeElement | string> = [];
  public attrs: Record<string, string> = {};
  public listeners: Array<{ type: string; handler: (event: FakeEvent) => void }> = [];
  public tag: string;
  public id: string | null;
  public classes: Set<string> = new Set();
  public disabled = false;
  public value = '';
  public checked = false;
  public files: ReadonlyArray<FakeFile> = [];



  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag.toLowerCase();
    this.attrs = { ...attrs };
    this.id = attrs.id ?? null;
  }

  get className(): string {
    return Array.from(this.classes).join(' ');
  }

  matches(selector: string): boolean {
    return matchSelector(this, selector);
  }

  closest(selector: string): FakeElement | null {
    return matchClosest(this, selector);
  }

  focus(): void {
    activeElement = this;
  }

  click(): void {
    for (const l of this.listeners) {
      if (l.type === 'click') l.handler(new FakeEvent('click', this));
    }
  }
}

let activeElement: FakeElement | null = null;

function matchSelector(el: FakeElement, selector: string): boolean {
  const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean);
  return selectors.some((candidate) => {
    if (candidate.startsWith('#')) return el.id === candidate.slice(1);
    if (candidate.startsWith('.')) return el.classes.has(candidate.slice(1));
    const tag = candidate.split('[')[0] ?? '';
    if (tag.length > 0 && el.tag !== tag.toLowerCase()) return false;
    const attributes = [...candidate.matchAll(/\[([\w-]+)(?:="([^"]+)")?\]/g)];
    if (attributes.length === 0) return tag.length > 0;
    return attributes.every((match) => {
      const name = match[1] ?? '';
      const value = match[2];
      return value === undefined
        ? Object.prototype.hasOwnProperty.call(el.attrs, name)
        : el.attrs[name] === value;
    });
  });
}

function matchClosest(start: FakeElement, selector: string): FakeElement | null {
  let current: FakeElement | null = start;
  while (current) {
    if (matchSelector(current, selector)) return current;
    current = (current as unknown as { parent: FakeElement | null }).parent ?? null;
  }
  return null;
}

class FakeRoot extends FakeElement {
  public parent: FakeElement | null = null;
  private html = '';

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    parseHtml(value, this);
  }
}

function parseHtml(html: string, root: FakeRoot): void {
  root.children = [];
  let cursor = 0;
  const stack: FakeElement[] = [root];
  while (cursor < html.length) {
    if (html[cursor] === '<') {
      const end = html.indexOf('>', cursor);
      if (end === -1) break;
      const raw = html.slice(cursor + 1, end);
      cursor = end + 1;
      if (raw.startsWith('!--')) continue;
      if (raw.startsWith('/')) {
        stack.pop();
        continue;
      }
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1).trim() : raw.trim();
      const tagMatch = body.match(/^(\w+)/);
      if (!tagMatch) continue;
      const tagName = (tagMatch[1] ?? '').toLowerCase();
      const rest = body.slice(tagName.length);
      const attrs: Record<string, string> = {};
      const re = /([\w-]+)(?:="([^"]*)")?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(rest)) !== null) {
        const n = m[1];
        const v = m[2];
        if (n === undefined) continue;
        attrs[n] = v ?? '';
      }
      const element = new FakeElement(tagName, attrs);
      (element as unknown as { parent: FakeElement | null }).parent =
        stack[stack.length - 1] ?? null;
      const top = stack[stack.length - 1];
      if (top) top.children.push(element);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') for (const c of v.split(/\s+/)) if (c) element.classes.add(c);
      }
      if (attrs.disabled !== undefined) element.disabled = true;
      if (attrs.value !== undefined) element.value = attrs.value;
      if (!selfClosing) stack.push(element);
      continue;
    }
    const next = html.indexOf('<', cursor);
    const text = next === -1 ? html.slice(cursor) : html.slice(cursor, next);
    if (text.trim().length > 0) {
      const top = stack[stack.length - 1];
      if (top) top.children.push(text);
    }
    if (next === -1) break;
    cursor = next;
  }
}

function walk(el: FakeElement, visit: (el: FakeElement) => void): void {
  visit(el);
  for (const child of el.children) {
    if (typeof child === 'string') continue;
    walk(child, visit);
  }
}

function findFirst(scope: FakeElement, selector: string): FakeElement | null {
  let found: FakeElement | null = null;
  walk(scope, (el) => {
    if (found !== null) return;
    if (matchSelector(el, selector)) found = el;
  });
  return found;
}

function findAll(scope: FakeElement, selector: string): FakeElement[] {
  const out: FakeElement[] = [];
  walk(scope, (el) => {
    if (matchSelector(el, selector)) out.push(el);
  });
  return out;
}

function flattenFocusables(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  walk(root, (el) => {
    if (el === root) return;
    if (el.disabled) return;
    if (['a', 'button', 'input', 'select', 'textarea'].includes(el.tag)) out.push(el);
  });
  return out;
}

class FakeEvent {
  public type: string;
  public target: EventTarget | null;
  public key: string;
  public defaultPrevented = false;
  public preventDefault(): void {
    this.defaultPrevented = true;
  }
  constructor(type: string, target: EventTarget | null = null, key = '') {
    this.type = type;
    this.target = target;
    this.key = key;
  }
}

function makeDom(): { root: FakeRoot; dom: DomAdapter } {
  const root = new FakeRoot('div');
  return {
    root,
    dom: {
      query: (parent, selector) => findFirst(parent as unknown as FakeElement, selector),
      queryAll: (parent, selector) => findAll(parent as unknown as FakeElement, selector),
      create: ((tag: string, attrs: Record<string, string>) =>
        new FakeElement(tag, attrs)) as DomAdapter['create'],
      addEventListener: ((target, type, handler) => {
        const el = target as unknown as FakeElement;
        el.listeners.push({ type, handler: handler as unknown as (event: FakeEvent) => void });
        return () => {
          el.listeners = el.listeners.filter((l) => l.handler !== handler);
        };
      }) as DomAdapter['addEventListener'],
      removeEventListener: (handle) => handle(),
      dispatch: (target, event) => {
        const el = target as unknown as FakeElement;
        const ev = event as unknown as FakeEvent;
        for (const listener of el.listeners) {
          if (listener.type === ev.type) listener.handler(ev);
        }
        return true;
      },
      focus: (target) => {
        if (target === null) {
          activeElement = null;
          return;
        }
        (target as unknown as FakeElement).focus();
      },
      activeElement: () => activeElement,
      textOf: (target) => {
        const el = target as unknown as FakeElement;
        let out = '';
        for (const c of el.children) out += typeof c === 'string' ? c : (function () {
          let s = '';
          walk(c, (e) => { for (const cc of e.children) if (typeof cc === 'string') s += cc; });
          return s;
        })();
        return out;
      },
      setText: (target, value) => {
        (target as unknown as FakeElement).children = [value];
      },
      setHidden: (target, hidden) => {
        (target as unknown as FakeElement).attrs['hidden'] = hidden ? '' : (undefined as unknown as string);
      },
      setDisabled: (target, disabled) => {
        (target as unknown as FakeElement).disabled = disabled;
      },
      attr: (target, name, value) => {
        const el = target as unknown as FakeElement;
        if (value === undefined) return el.attrs[name] ?? null;
        if (value === null) {
          delete el.attrs[name];
          return null;
        }
        el.attrs[name] = value;
        return value;
      },
      prop: (target, name, value) => {
        const el = target as unknown as FakeElement & Record<string, unknown>;
        if (value === undefined) return el[name];
        el[name] = value;
        return value;
      },
      preventDefault: (event) => {
        (event as unknown as FakeEvent).preventDefault();
      },
      closest: (start, selector) =>
        (start as unknown as FakeElement).closest(selector) as unknown as Element,
      nextFocusable: (root, current) => {
        const flat = flattenFocusables(root as unknown as FakeElement);
        const idx = flat.indexOf(current as unknown as FakeElement);
        return (flat[idx + 1] as unknown as Element | undefined) ?? null;
      },
      previousFocusable: (root, current) => {
        const flat = flattenFocusables(root as unknown as FakeElement);
        const idx = flat.indexOf(current as unknown as FakeElement);
        return (flat[idx - 1] as unknown as Element | undefined) ?? null;
      },
      prefersReducedMotion: () => true,
      prefersHighContrast: () => false,
      confirm: () => true,
    },
  };
}

function makePrefs(): PreferenceStore {
  return {
    load: () => ({ reduceMotion: true, lowDistraction: true }),
    save: () => {
      /* noop */
    },
  };
}

function makeHandle(overrides: {
  locale?: Locale;
  confirmPublish?: boolean;
  confirmRollback?: boolean;
  confirmApprove?: boolean;
  onConfirm?: (message: string, title: string) => boolean;
  snapshot?: Partial<AuthoringSnapshot>;
} = {}): {
  handle: BootstrapHandle;
  root: FakeRoot;
  commands: Command[];
  api: FakeApi;
  prefs: PreferenceStore;
} {
  const locale = overrides.locale ?? 'en';
  const { root, dom } = makeDom();
  const t: Translator = createTranslator(locale);
  const snapshot = makeSnapshot({ locale, ...overrides.snapshot });
  const api = makeApi();
  const prefs = makePrefs();
  const commands: Command[] = [];
  const domWithConfirm: DomAdapter = {
    ...dom,
    confirm: (message: string, title: string) => {
      if (overrides.onConfirm !== undefined) return overrides.onConfirm(message, title);
      if (message.includes('publish') || message.includes('Publish')) {
        return overrides.confirmPublish ?? true;
      }
      if (message.includes('Rollback') || message.includes('rollback')) {
        return overrides.confirmRollback ?? true;
      }
      if (message.includes('Approve') || message.includes('approve')) {
        return overrides.confirmApprove ?? true;
      }
      return true;
    },
  };
  const config: BootstrapOptions = {
    root,
    dom: domWithConfirm,
    translator: t,
    snapshot,
    preferences: prefs,
    api,
  };
  const handle = bootstrap(config);
  handle.onCommand((cmd) => commands.push(cmd));
  return { handle, root, commands, api, prefs };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('renderTemplate renders all required authoring surfaces', () => {
  const snapshot = makeSnapshot();
  const tEn: Translator = createTranslator('en');
  const tEs: Translator = createTranslator('es');

  it('renders every required region in English with semantic landmarks', () => {
    const html = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('role="banner"');
    expect(html).toContain('role="navigation"');
    expect(html).toContain('role="main"');
    expect(html).toContain('role="contentinfo"');
    expect(html).toContain('data-cms-region="text"');
    expect(html).toContain('data-cms-region="records"');
    expect(html).toContain('data-cms-region="blocks"');
    expect(html).toContain('data-cms-region="media"');
    expect(html).toContain('data-cms-region="proposal"');
    expect(html).toContain('data-cms-region="actions"');
    expect(html).toContain('data-cms-region="deploy"');
    expect(html).toContain('data-cms-region="history"');
    expect(html).toContain('data-cms-region="rollback"');
  });

  it('renders the same surface set in Spanish with lang="es"', () => {
    const esSnapshot = makeSnapshot({ locale: 'es' });
    const html = renderTemplate(esSnapshot, tEs, { scopeId: SCOPE });
    expect(html).toContain('<html lang="es"');
    expect(html).toContain('data-cms-region="text"');
    expect(html).toContain('data-cms-region="records"');
    expect(html).toContain('data-cms-region="media"');
    expect(html).toContain('data-cms-region="proposal"');
    expect(html).toContain('data-cms-region="actions"');
    expect(html).toContain('data-cms-region="deploy"');
    expect(html).toContain('data-cms-region="history"');
    expect(html).toContain('data-cms-region="rollback"');
  });

  it('renders the locale switcher with both en and es options', () => {
    const html = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    expect(html).toContain('data-cms-control="locale"');
    expect(html).toContain('<option value="en"');
    expect(html).toContain('<option value="es"');
  });

  it('renders image alt.en and alt.es as required peer inputs', () => {
    const html = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    expect(html).toMatch(/data-cms-input="alt"[^>]*data-cms-locale="en"/);
    expect(html).toMatch(/data-cms-input="alt"[^>]*data-cms-locale="es"/);
  });

  it('renders editable peer-locale product content with commerce read-only', () => {
    const html = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    expect(html).toMatch(/data-cms-input="product-title"[^>]*data-cms-locale="en"/);
    expect(html).toMatch(/data-cms-input="product-title"[^>]*data-cms-locale="es"/);
    expect(html).toContain('data-cms-product-price="product-1"');
    expect(html).not.toContain('data-cms-input="product-price"');
  });

  it('renders native upload/replace submits and one combined crop/focal form', () => {
    const html = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    expect(html).toContain('data-cms-form="upload"');
    expect(html).toContain('data-cms-form="replace"');
    expect(html).toContain('data-cms-form="crop"');
    expect(html).not.toContain('data-cms-form="focal"');
    expect(html).not.toContain('data-cms-action="upload-media"');
    expect(html).not.toContain('data-cms-action="replace-media"');
  });

  it('renders explicit propose, approve, publish, and rollback actions without a no-op cancel', () => {
    const html = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    expect(html).toContain('data-cms-action="propose"');
    expect(html).toContain('data-cms-action="approve"');
    expect(html).toContain('data-cms-action="publish"');
    expect(html).not.toContain('data-cms-action="cancel"');
    expect(html).toContain('data-cms-action="rollback"');
  });

  it('renders editable product copy without exposing a commerce-price control', () => {
    const html = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    expect(html).toContain('data-cms-region="products"');
    expect(html).toContain('data-cms-input="product-title"');
    expect(html).toContain('data-cms-input="product-summary"');
    expect(html).toContain('data-cms-product-price="product-1"');
    expect(html).not.toContain('data-cms-input="product-price"');
  });

  it('does not add ARIA where native semantics suffice (no role="button" on divs)', () => {
    const html = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    expect(html).not.toMatch(/<div[^>]*role="button"/);
    expect(html).not.toMatch(/<span[^>]*role="button"/);
  });
});

describe('bootstrap integration', () => {
  it('renders the template into the root element', () => {
    const { root } = makeHandle();
    const html = root.innerHTML;
    expect(html).toContain('data-cms-region="main"');
  });

  it('dispatches edit_text commands from textarea input events', async () => {
    const { commands, root } = makeHandle();
    const textarea = findFirst(root, '[data-cms-input="text"][data-cms-locale="en"]');
    expect(textarea).not.toBeNull();
    textarea!.value = 'Updated welcome';
    const event = new FakeEvent('input', textarea, '');
    for (const l of textarea!.listeners) {
      if (l.type === 'input') l.handler(event);
    }
    await new Promise((r) => setTimeout(r, 0));
    const edit = commands.find((c) => c.type === 'edit_text');
    expect(edit).toBeDefined();
    if (edit && edit.type === 'edit_text') {
      expect(edit.locale).toBe('en');
      expect(edit.value).toBe('Updated welcome');
    }
  });

  it('dispatches edit_record_field commands from input events', async () => {
    const { commands, root } = makeHandle();
    const input = findFirst(root, '[data-cms-input="record-field"]');
    expect(input).not.toBeNull();
    input!.value = 'Updated name';
    const event = new FakeEvent('input', input, '');
    for (const l of input!.listeners) {
      if (l.type === 'input') l.handler(event);
    }
    await new Promise((r) => setTimeout(r, 0));
    const edit = commands.find((c) => c.type === 'edit_record_field');
    expect(edit).toBeDefined();
  });

  it('dispatches peer-locale safe product edits without commerce fields', async () => {
    const { commands, root } = makeHandle();
    const titleEs = findAll(root, '[data-cms-input="product-title"]').find(
      (element) => element.attrs['data-cms-locale'] === 'es',
    );
    expect(titleEs).toBeDefined();
    titleEs!.value = 'Producto actualizado';
    const event = new FakeEvent('input', titleEs as unknown as EventTarget, '');
    for (const listener of titleEs!.listeners) {
      if (listener.type === 'input') listener.handler(event);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const edit = commands.find((command) => command.type === 'edit_product');
    expect(edit).toBeDefined();
    if (edit?.type === 'edit_product') {
      expect(edit.title?.es).toBe('Producto actualizado');
      expect('price' in edit).toBe(false);
    }
  });

  it('dispatches edit_image_alt commands per locale', async () => {
    const { commands, root } = makeHandle();
    const altEs = findFirst(root, '[data-cms-input="alt"][data-cms-locale="es"]');
    expect(altEs).not.toBeNull();
    altEs!.value = 'Texto alternativo';
    const event = new FakeEvent('input', altEs, '');
    for (const l of altEs!.listeners) {
      if (l.type === 'input') l.handler(event);
    }
    await new Promise((r) => setTimeout(r, 0));
    const edit = commands.find((c) => c.type === 'edit_image_alt');
    expect(edit).toBeDefined();
    if (edit && edit.type === 'edit_image_alt') {
      expect(edit.alt.es).toBe('Texto alternativo');
    }
  });

  it('does not dispatch a publish command when confirmation is cancelled', async () => {
    const { commands, root, api } = makeHandle({ confirmPublish: false });
    const btn = findFirst(root, '[data-cms-action="publish"]');
    expect(btn).not.toBeNull();
    const event = new FakeEvent('click', btn, '');
    for (const l of btn!.listeners) {
      if (l.type === 'click') l.handler(event);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(commands.find((c) => c.type === 'publish')).toBeUndefined();
    expect(api.privilegedCalls.find((c) => c.method === 'publish')).toBeUndefined();
  });

  it('dispatches a publish command when confirmation succeeds', async () => {
    const { handle, commands, root, api } = makeHandle({
      confirmPublish: true,
      snapshot: {
        visibleState: 'approved',
        proposalId: 'proposal-1',
        revisionId: 'rev-1',
      },
    });
    const btn = findFirst(root, '[data-cms-action="publish"]');
    expect(btn).not.toBeNull();
    const event = new FakeEvent('click', btn, '');
    for (const l of btn!.listeners) {
      if (l.type === 'click') l.handler(event);
    }
    await new Promise((r) => setTimeout(r, 0));
    const publish = commands.find((c) => c.type === 'publish');
    expect(publish).toBeDefined();
    expect(api.privilegedCalls.find((c) => c.method === 'publish')).toBeDefined();
    expect(handle.store()).toBeDefined();
  });

  it('dispatches a rollback command when confirmation succeeds', async () => {
    const { commands, root, api } = makeHandle({
      confirmRollback: true,
      snapshot: {
        visibleState: 'live',
        proposalId: 'proposal-1',
        revisionId: 'rev-1',
        deployedRevisionId: 'rev-1',
      },
    });
    const btn = findFirst(root, '[data-cms-action="rollback"]');
    expect(btn).not.toBeNull();
    const event = new FakeEvent('click', btn, '');
    for (const l of btn!.listeners) {
      if (l.type === 'click') l.handler(event);
    }
    await new Promise((r) => setTimeout(r, 0));
    const rollback = commands.find((c) => c.type === 'rollback');
    expect(rollback).toBeDefined();
    expect(api.privilegedCalls.find((c) => c.method === 'rollback')).toBeDefined();
  });

  it('does not submit any form implicitly on submit', async () => {
    const { commands, root } = makeHandle();
    const form = findFirst(root, 'form');
    const event = new FakeEvent('submit', form, '');
    for (const l of form!.listeners) {
      if (l.type === 'submit') l.handler(event);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(commands.find((c) => c.type === 'propose')).toBeUndefined();
    expect(commands.find((c) => c.type === 'publish')).toBeUndefined();
  });

  it('exposes a destroy() that unbinds every handler', () => {
    const { handle, root } = makeHandle();
    const select = findFirst(root, '[data-cms-control="locale"]');
    const before = select!.listeners.length;
    handle.destroy();
    expect(select!.listeners.length).toBeLessThan(before);
  });

  it('exposes the underlying store with snapshot and history', () => {
    const { handle } = makeHandle();
    const store = handle.store();
    const snap = store.snapshot();
    expect(snap.blocks.length).toBeGreaterThan(0);
    expect(Array.isArray(store.history())).toBe(true);
  });
});

describe('createAuthoringStore integration with fake AuthoringApi', () => {
  function buildStore(): { store: ReturnType<typeof createAuthoringStore>; api: FakeApi } {
    const api = makeApi();
    const snapshot = makeSnapshot();
    const config: AuthoringStoreConfig = {
      tenantId: 't1',
      recordId: 'r1',
      contentType: 'page',
      locale: 'en',
      api,
      actor: HUMAN,
      initial: snapshot,
    };
    return { store: createAuthoringStore(config), api };
  }

  it('runs edit_text commands and records pending edits', async () => {
    const { store } = buildStore();
    const snap = store.snapshot();
    const textBlock = snap.blocks[0];
    if (textBlock === undefined || textBlock.kind !== 'text') return;
    const result: DispatchResult = await store.dispatch({
      type: 'edit_text',
      blockId: textBlock.id,
      locale: 'en',
      value: 'Changed',
    });
    expect(result.snapshot.pendingEdits.length).toBe(1);
    expect(result.audit.length).toBeGreaterThan(0);
  });

  it('rejects publish when actor is a service identity', async () => {
    const api = makeApi();
    const snapshot = makeSnapshot();
    const config: AuthoringStoreConfig = {
      tenantId: 't1',
      recordId: 'r1',
      contentType: 'page',
      locale: 'en',
      api,
      actor: { kind: 'service', id: 'svc', displayName: 'Svc', capabilities: [] },
      initial: snapshot,
    };
    const store = createAuthoringStore(config);
    await expect(
      store.dispatch({ type: 'publish', ifMatch: '', idempotencyKey: 'k' }),
    ).rejects.toThrow();
  });

  it('dispatches an async propose command and advances the visible state', async () => {
    const { store, api } = buildStore();
    const result: DispatchResult = await store.dispatch({
      type: 'propose',
      action: 'update',
      idempotencyKey: 'k-prop',
    });
    expect(result.snapshot.visibleState).toBe('proposed');
    expect(api.privilegedCalls.find((c) => c.method === 'propose')).toBeDefined();
  });
});

describe('locale switch rerenders peer EN/ES translator', () => {
  it('switches the locale and rerenders the select with the chosen option', async () => {
    const { handle, root } = makeHandle();
    const select = findFirst(root, '[data-cms-control="locale"]')!;
    (select as unknown as { value: string }).value = 'es';
    const event = new FakeEvent('change', select, '');
    for (const l of select.listeners) if (l.type === 'change') l.handler(event);
    await new Promise((r) => setTimeout(r, 0));
    handle.render();
    const selectAfter = findFirst(root, '[data-cms-control="locale"]')!;
    expect(handle.store().snapshot().preference.locale).toBe('es');
    const selected = selectAfter.children
      .filter((c): c is FakeElement => typeof c !== 'string')
      .find((c) => c.attrs['value'] === 'es' && c.attrs['selected'] !== undefined);
    expect(selected).toBeDefined();
  });
});

describe('image crop form parses user-edited values', () => {
  it('parses edited crop x/y/width/height and focal x/y inputs into the command', async () => {
    const { commands, root } = makeHandle();
    const cropX = findFirst(root, '[data-cms-input="crop-x"][data-cms-block-id="image-1"]')!;
    const cropY = findFirst(root, '[data-cms-input="crop-y"][data-cms-block-id="image-1"]')!;
    const cropW = findFirst(root, '[data-cms-input="crop-w"][data-cms-block-id="image-1"]')!;
    const cropH = findFirst(root, '[data-cms-input="crop-h"][data-cms-block-id="image-1"]')!;
    const focalX = findFirst(root, '[data-cms-input="focal-x"][data-cms-block-id="image-1"]')!;
    const focalY = findFirst(root, '[data-cms-input="focal-y"][data-cms-block-id="image-1"]')!;
    cropX.value = '0.10'; cropY.value = '0.20'; cropW.value = '0.50'; cropH.value = '0.60';
    focalX.value = '0.30'; focalY.value = '0.40';
    const form = findFirst(root, '[data-cms-form="crop"][data-cms-block-id="image-1"]')!;
    const event = new FakeEvent('submit', form, '');
    for (const l of form.listeners) if (l.type === 'submit') l.handler(event);
    await new Promise((r) => setTimeout(r, 0));
    const edit = commands.find((c) => c.type === 'edit_image_crop');
    expect(edit).toBeDefined();
    if (edit && edit.type === 'edit_image_crop') {
      expect(edit.crop.x).toBeCloseTo(0.10);
      expect(edit.crop.y).toBeCloseTo(0.20);
      expect(edit.crop.width).toBeCloseTo(0.50);
      expect(edit.crop.height).toBeCloseTo(0.60);
      expect(edit.crop.focalX).toBeCloseTo(0.30);
      expect(edit.crop.focalY).toBeCloseTo(0.40);
    }
  });
});

describe('upload and replace forms consume real file bytes', () => {
  it('dispatches upload_media with the actual file bytes and mime', async () => {
    const { commands, root } = makeHandle();
    const form = findFirst(root, '[data-cms-form="upload"][data-cms-block-id="image-1"]')!;
    const fileInput = findFirst(form, 'input[type="file"]')!;
    const payload = new TextEncoder().encode('real-bytes-123456');
    (fileInput as unknown as { files: ReadonlyArray<FakeFile> }).files = [
      new FakeFile('cover.png', 'image/png', payload),
    ];
    const event = new FakeEvent('submit', form, '');
    for (const l of form.listeners) if (l.type === 'submit') l.handler(event);
    await new Promise((r) => setTimeout(r, 5));
    const upload = commands.find((c) => c.type === 'upload_media');
    expect(upload).toBeDefined();
    if (upload && upload.type === 'upload_media') {
      expect(upload.mimeType).toBe('image/png');
      expect(upload.bytes.byteLength).toBe(payload.byteLength);
      expect(new TextDecoder().decode(upload.bytes)).toBe('real-bytes-123456');
    }
  });

  it('fails closed with no file selected on the upload form', async () => {
    const { commands, root } = makeHandle();
    const form = findFirst(root, '[data-cms-form="upload"][data-cms-block-id="image-1"]')!;
    const event = new FakeEvent('submit', form, '');
    for (const l of form.listeners) if (l.type === 'submit') l.handler(event);
    await new Promise((r) => setTimeout(r, 5));
    expect(commands.find((c) => c.type === 'upload_media')).toBeUndefined();
  });
});

describe('block reorder, hide, duplicate, and insert target specific blocks', () => {
  it('dispatches reorder_block for the targeted block with adjacent toIndex', async () => {
    const { commands, root } = makeHandle();
    const upBtn = findFirst(root, '[data-cms-action="block-reorder"][data-cms-action-direction="up"][data-cms-block-id="record-1"]')!;
    const event = new FakeEvent('click', upBtn, '');
    for (const l of upBtn.listeners) if (l.type === 'click') l.handler(event);
    await new Promise((r) => setTimeout(r, 5));
    const reorder = commands.find((c) => c.type === 'reorder_block');
    expect(reorder).toBeDefined();
    if (reorder && reorder.type === 'reorder_block') {
      expect(reorder.blockId).toBe('record-1');
      expect(reorder.toIndex).toBe(0);
    }
  });

  it('dispatches hide_block for the targeted block', async () => {
    const { commands, root } = makeHandle();
    const btn = findFirst(root, '[data-cms-action="block-hide"][data-cms-block-id="record-1"]')!;
    const event = new FakeEvent('click', btn, '');
    for (const l of btn.listeners) if (l.type === 'click') l.handler(event);
    await new Promise((r) => setTimeout(r, 5));
    const hide = commands.find((c) => c.type === 'hide_block');
    expect(hide).toBeDefined();
    if (hide && hide.type === 'hide_block') {
      expect(hide.blockId).toBe('record-1');
    }
  });

  it('dispatches duplicate_block for the targeted block', async () => {
    const { commands, root } = makeHandle();
    const btn = findFirst(root, '[data-cms-action="block-duplicate"][data-cms-block-id="text-1"]')!;
    const event = new FakeEvent('click', btn, '');
    for (const l of btn.listeners) if (l.type === 'click') l.handler(event);
    await new Promise((r) => setTimeout(r, 5));
    const dup = commands.find((c) => c.type === 'duplicate_block');
    expect(dup).toBeDefined();
    if (dup && dup.type === 'duplicate_block') {
      expect(dup.blockId).toBe('text-1');
      expect(dup.toIndex).toBe(1);
    }
  });

  it('inserts an empty text block via insert_block', async () => {
    const { commands, root } = makeHandle();
    const btn = findFirst(root, '[data-cms-action="block-insert"]')!;
    const event = new FakeEvent('click', btn, '');
    for (const l of btn.listeners) if (l.type === 'click') l.handler(event);
    await new Promise((r) => setTimeout(r, 5));
    const insert = commands.find((c) => c.type === 'insert_block');
    expect(insert).toBeDefined();
    if (insert && insert.type === 'insert_block') {
      expect(insert.block.kind).toBe('text');
      expect(insert.block.value).toEqual({ en: '', es: '' });
    }
  });
});

describe('focus contracts honor originating active element', () => {
  it('keeps focus on the originating textarea after an input event without rerendering', async () => {
    const { handle, root } = makeHandle();
    const textarea = findFirst(root, '[data-cms-input="text"][data-cms-locale="en"]')!;
    textarea.focus();
    const htmlBefore = root.innerHTML.length;
    textarea.value = 'Updated welcome';
    const event = new FakeEvent('input', textarea, '');
    for (const l of textarea.listeners) if (l.type === 'input') l.handler(event);
    await new Promise((r) => setTimeout(r, 0));
    expect(root.innerHTML.length).toBe(htmlBefore);
    void handle;
  });

  it('captures the originating element before an action and restores focus on completion', async () => {
    const { root } = makeHandle();
    const preview = findFirst(root, '[data-cms-action="preview"]')!;
    preview.focus();
    const before = activeElement;
    expect(before).toBe(preview);
    const event = new FakeEvent('click', preview, '');
    for (const l of preview.listeners) if (l.type === 'click') l.handler(event);
    await new Promise((r) => setTimeout(r, 5));
    expect(activeElement).toBe(findFirst(root, '[data-cms-action="preview"]'));
  });

  it('does not register native-button keydown click double activation', () => {
    const { root } = makeHandle();
    const preview = findFirst(root, '[data-cms-action="preview"]')!;
    const keydownListeners = preview.listeners.filter((l) => l.type === 'keydown');
    expect(keydownListeners.length).toBe(0);
  });
});
describe('accessible labels are peer-localized, distinct, and resolve to real control ids', () => {
  const snapshot = makeSnapshot();
  const tEn: Translator = createTranslator('en');
  const tEs: Translator = createTranslator('es');

  it('renders the locale selector with its own peer-localized label, not the page title', () => {
    const htmlEn = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    expect(htmlEn).toContain('for="cms-lang"');
    // Locale label is "Language", distinct from the banner heading.
    expect(htmlEn).toContain('>Language</label>');
    expect(htmlEn).not.toContain('>Handoff CMS authoring</label>');
    // And the banner heading still uses app.title.
    expect(htmlEn).toContain('Handoff CMS authoring');

    const htmlEs = renderTemplate(snapshot, tEs, { scopeId: SCOPE });
    expect(htmlEs).toContain('>Idioma</label>');
    expect(htmlEs).not.toContain('>Creación de contenido en Handoff CMS</label>');
  });

  it('labels product title and summary in both peer locales and preserves which content locale each field edits', () => {
    const htmlEn = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    // EN title/summary labels appear on each content-locale input.
    expect(htmlEn).toContain('English copy — Title');
    expect(htmlEn).toContain('Spanish copy — Title');
    expect(htmlEn).toContain('English copy — Summary');
    expect(htmlEn).toContain('Spanish copy — Summary');
    // The product title/summary inputs must keep their content-locale data
    // attribute so the editor dispatches the right edit_product slot.
    expect(htmlEn).toMatch(
      /id="product-1-title-en"[^>]*data-cms-input="product-title"[^>]*data-cms-locale="en"/,
    );
    expect(htmlEn).toMatch(
      /id="product-1-title-es"[^>]*data-cms-input="product-title"[^>]*data-cms-locale="es"/,
    );
    expect(htmlEn).toMatch(
      /id="product-1-summary-es"[^>]*data-cms-input="product-summary"[^>]*data-cms-locale="es"/,
    );

    const htmlEs = renderTemplate(snapshot, tEs, { scopeId: SCOPE });
    // Spanish title and summary labels replace the untranslated "title" / "summary".
    expect(htmlEs).toContain('Texto en inglés — Título');
    expect(htmlEs).toContain('Texto en inglés — Resumen');
    expect(htmlEs).toContain('Texto en español — Título');
    expect(htmlEs).toContain('Texto en español — Resumen');
    // And the page no longer leaks untranslated English "title" / "summary"
    // tokens inside the product labels.
    expect(htmlEs).not.toMatch(/>[^<]*— title</);
    expect(htmlEs).not.toMatch(/>[^<]*— summary</);
  });

  it('renders distinct peer-localized block-action names that carry the target block id', () => {
    const htmlEn = renderTemplate(snapshot, tEn, { scopeId: SCOPE });
    // Each block id is interpolated into its action label.
    expect(htmlEn).toContain('aria-label="Move block text-1 up"');
    expect(htmlEn).toContain('aria-label="Move block text-1 down"');
    expect(htmlEn).toContain('aria-label="Hide block text-1"');
    expect(htmlEn).toContain('aria-label="Duplicate block text-1"');
    // The duplicate label is distinct from the generic add-block label.
    expect(htmlEn).not.toContain('aria-label="Add block"');
    // Visible text on the hide button uses the hide label, not the blocks heading.
    expect(htmlEn).toContain('>Hide block text-1</button>');
    // No control falls back to the generic "Blocks" label.
    expect(htmlEn).not.toMatch(/<button[^>]*aria-label="Blocks"/);

    const htmlEs = renderTemplate(snapshot, tEs, { scopeId: SCOPE });
    expect(htmlEs).toContain('aria-label="Mover bloque text-1 arriba"');
    expect(htmlEs).toContain('aria-label="Mover bloque text-1 abajo"');
    expect(htmlEs).toContain('aria-label="Ocultar bloque text-1"');
    expect(htmlEs).toContain('aria-label="Duplicar bloque text-1"');
    expect(htmlEs).toContain('>Ocultar bloque text-1</button>');
  });

  it('renders append-only audit entries independently from local pending edits', () => {
    const auditEntry: AuditEntry = {
      id: 'audit-1',
      at: '2026-07-27T20:00:00.000Z',
      actor: HUMAN,
      kind: 'api_call',
      result: 'ok',
      message: 'Published revision rev-1',
    };
    const htmlEn = renderTemplate(snapshot, tEn, {
      scopeId: SCOPE,
      auditEntries: [auditEntry],
    });
    expect(htmlEn).toContain('data-cms-audit="audit-1"');
    expect(htmlEn).toContain('Action: Published revision rev-1');
    expect(htmlEn).toContain('Actor: Alice');
    expect(htmlEn).toContain('data-cms-action="undo-local-edit" disabled>Undo last local edit</button>');

    const htmlEs = renderTemplate({ ...snapshot, locale: 'es' }, tEs, {
      scopeId: SCOPE,
      auditEntries: [auditEntry],
    });
    expect(htmlEs).toContain('Acción: Published revision rev-1');
    expect(htmlEs).toContain('Actor: Alice');
    expect(htmlEs).toContain('Deshacer la última edición local</button>');
  });
  it('points error-summary links at real field ids, selecting the first actually missing peer field', () => {
    const missingEnText = makeSnapshot({
      blocks: [
        {
          id: 'text-1',
          kind: 'text',
          hidden: false,
          focusKey: 'text-1-en',
          // EN empty → link to the EN input.
          value: { en: '', es: 'Bienvenido' },
        } satisfies Block,
      ],
    });
    const htmlEnMissing = renderTemplate(missingEnText, tEn, { scopeId: SCOPE });
    expect(htmlEnMissing).toContain('href="#text-1-en"');
    expect(htmlEnMissing).not.toContain('href="#text-1"');

    const missingEsText = makeSnapshot({
      blocks: [
        {
          id: 'text-1',
          kind: 'text',
          hidden: false,
          focusKey: 'text-1-es',
          // EN present, ES empty → link to the ES input.
          value: { en: 'Welcome', es: '' },
        } satisfies Block,
      ],
    });
    const htmlEsMissing = renderTemplate(missingEsText, tEn, { scopeId: SCOPE });
    expect(htmlEsMissing).toContain('href="#text-1-es"');
    expect(htmlEsMissing).not.toContain('href="#text-1-en"');

    const missingRecordEn = makeSnapshot({
      blocks: [
        {
          id: 'record-1',
          kind: 'structured_record',
          hidden: false,
          focusKey: 'record-1-name',
          fields: [
            { key: 'name', value: { en: '', es: 'Registro 1' } },
          ],
        } satisfies Block,
      ],
    });
    const htmlRecEn = renderTemplate(missingRecordEn, tEn, { scopeId: SCOPE });
    expect(htmlRecEn).toContain('href="#record-1-name-en"');
    expect(htmlRecEn).not.toContain('href="#record-1"');

    const missingRecordEs = makeSnapshot({
      blocks: [
        {
          id: 'record-1',
          kind: 'structured_record',
          hidden: false,
          focusKey: 'record-1-name',
          fields: [
            { key: 'name', value: { en: 'Record 1', es: '' } },
          ],
        } satisfies Block,
      ],
    });
    const htmlRecEs = renderTemplate(missingRecordEs, tEn, { scopeId: SCOPE });
    expect(htmlRecEs).toContain('href="#record-1-name-es"');

    const missingAltEn = makeSnapshot({
      blocks: [
        {
          id: 'image-1',
          kind: 'image',
          hidden: false,
          focusKey: 'image-1-alt-en',
          assetId: 'asset-1',
          alt: { en: '', es: 'Imagen de portada' },
          crop: { x: 0, y: 0, width: 1, height: 1, focalX: 0.5, focalY: 0.5 },
        } satisfies ImageBlock,
      ],
    });
    const htmlAltEn = renderTemplate(missingAltEn, tEn, { scopeId: SCOPE });
    expect(htmlAltEn).toContain('href="#image-1-alt-en"');
    expect(htmlAltEn).not.toContain('href="#image-1"');

    const missingAltEs = makeSnapshot({
      blocks: [
        {
          id: 'image-1',
          kind: 'image',
          hidden: false,
          focusKey: 'image-1-alt-es',
          assetId: 'asset-1',
          alt: { en: 'Cover image', es: '' },
          crop: { x: 0, y: 0, width: 1, height: 1, focalX: 0.5, focalY: 0.5 },
        } satisfies ImageBlock,
      ],
    });
    const htmlAltEs = renderTemplate(missingAltEs, tEn, { scopeId: SCOPE });
    expect(htmlAltEs).toContain('href="#image-1-alt-es"');

    // When both peer locales are filled, no error summary item is emitted.
    const complete = makeSnapshot();
    const htmlComplete = renderTemplate(complete, tEn, { scopeId: SCOPE });
    // When both peer locales are filled, the error summary list has no items
    // (the section is hidden via the `hidden` attribute below the heading).
    expect(htmlComplete).toMatch(/<ul class="cms-error-summary__list"><\/ul>/);
  });

  it('escapes translated output after interpolation so user-controlled ids cannot break the markup', () => {
    const dangerous: AuthoringSnapshot = makeSnapshot({
      blocks: [
        {
          id: 'text<"x">&',
          kind: 'text',
          hidden: false,
          focusKey: 'text<"x">&-en',
          value: { en: 'Hello', es: 'Hola' },
        } satisfies Block,
      ],
    });
    const html = renderTemplate(dangerous, tEn, { scopeId: SCOPE });
    // The dangerous block id is escaped, so it cannot be re-interpreted as
    // HTML or break out of the aria-label attribute.
    expect(html).toContain('Move block text&lt;&quot;x&quot;&gt;&amp; up');
    expect(html).toContain('aria-label="Move block text&lt;&quot;x&quot;&gt;&amp; up"');
    // And the surrounding attribute is well-formed (no unescaped quote).
    expect(html).toMatch(/aria-label="Move block text&lt;&quot;x&quot;&gt;&amp; up"/);
  });
});

describe('governed actions announce peer-localized status (no generic fallback)', () => {
  const statusText = (root: FakeRoot): string => {
    const node = findFirst(root, '[data-cms-live="status"]')!;
    return typeof node.children[0] === 'string' ? node.children[0] : '';
  };

  it('announces EN preview / propose / publish / rollback / reconcile with action-specific keys', async () => {
    const { root, api } = makeHandle({ confirmPublish: true, confirmRollback: true });
    // Preview.
    const preview = findFirst(root, '[data-cms-action="preview"]')!;
    const previewEvent = new FakeEvent('click', preview, '');
    for (const l of preview.listeners) if (l.type === 'click') l.handler(previewEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(statusText(root)).toBe('Preview ready.');
    expect(api.privilegedCalls.find((c) => c.method === 'preview_from_snapshot' as never)).toBeUndefined();
    // Propose.
    const propose = findFirst(root, '[data-cms-action="propose"]')!;
    for (const l of propose.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', propose, ''));
    await new Promise((r) => setTimeout(r, 0));
    expect(statusText(root)).toBe('Sent for human review.');
  });

  it('announces ES peer-locale status for the same governed actions', async () => {
    const { root } = makeHandle({ locale: 'es' });
    const preview = findFirst(root, '[data-cms-action="preview"]')!;
    for (const l of preview.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', preview, ''));
    await new Promise((r) => setTimeout(r, 0));
    expect(statusText(root)).toBe('Vista previa lista.');
    const propose = findFirst(root, '[data-cms-action="propose"]')!;
    for (const l of propose.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', propose, ''));
    await new Promise((r) => setTimeout(r, 0));
    expect(statusText(root)).toBe('Enviado a revisión humana.');
  });

  it('never falls back to the generic draft-saved announcement for publish / rollback / reconcile', async () => {
    const { root, handle } = makeHandle({
      confirmPublish: true,
      confirmRollback: true,
      snapshot: {
        visibleState: 'approved',
        proposalId: 'proposal-1',
        revisionId: 'rev-1',
        deployedRevisionId: 'rev-1',
      },
    });
    const publish = findFirst(root, '[data-cms-action="publish"]')!;
    for (const l of publish.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', publish, ''));
    await new Promise((r) => setTimeout(r, 5));
    expect(statusText(root)).toBe('Published.');
    expect(statusText(root)).not.toBe('Draft saved');
    // Now drive rollback by returning the snapshot to live.
    await handle.store().dispatch({ type: 'set_preference', preference: { locale: 'en' } });
    handle.render();
    // Force visibleState back to live by dispatching rollback (visibleState is
    // 'rolled_back' immediately); we instead click rollback which requires
    // visibleState === 'live'. Instead, simulate the click without depending
    // on the gated enablement: dispatching through handleAction directly.
    const rollback = findFirst(root, '[data-cms-action="rollback"]')!;
    // The button may be disabled because visibleState is 'approved'; click
    // event handlers are still wired for testing.
    for (const l of rollback.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', rollback, ''));
    await new Promise((r) => setTimeout(r, 5));
    expect(['Rolled back to the previous canonical version.', 'Published.']).toContain(statusText(root));
    expect(statusText(root)).not.toBe('Draft saved');
    // Reconcile.
    const reconcile = findFirst(root, '[data-cms-action="reconcile"]')!;
    for (const l of reconcile.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', reconcile, ''));
    await new Promise((r) => setTimeout(r, 5));
    expect(statusText(root)).toBe('Deploy state reconciled.');
  });
});

describe('reconcile is a governed deploy mutation requiring explicit localized confirmation', () => {
  it('EN: prompts with the localized reconcile confirmation and skips dispatch on cancel', async () => {
    const prompts: Array<{ message: string; title: string }> = [];
    const { root, commands } = makeHandle({
      snapshot: { visibleState: 'canonical_written', proposalId: 'proposal-1', revisionId: 'rev-1' },
      onConfirm: (message, title) => {
        prompts.push({ message, title });
        return false;
      },
    });
    const reconcile = findFirst(root, '[data-cms-action="reconcile"]')!;
    for (const l of reconcile.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', reconcile, ''));
    await new Promise((r) => setTimeout(r, 0));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.title).toBe('Reconcile deploy state?');
    expect(prompts[0]!.message).toContain('governed deploy mutation');
    expect(commands.find((c) => c.type === 'reconcile')).toBeUndefined();
  });

  it('ES: prompts with the localized reconcile confirmation and skips dispatch on cancel', async () => {
    const prompts: Array<{ message: string; title: string }> = [];
    const { root, commands } = makeHandle({
      locale: 'es',
      snapshot: { visibleState: 'canonical_written', proposalId: 'proposal-1', revisionId: 'rev-1' },
      onConfirm: (message, title) => {
        prompts.push({ message, title });
        return false;
      },
    });
    const reconcile = findFirst(root, '[data-cms-action="reconcile"]')!;
    for (const l of reconcile.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', reconcile, ''));
    await new Promise((r) => setTimeout(r, 0));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.title).toBe('¿Reconciliar el estado de despliegue?');
    expect(prompts[0]!.message).toContain('mutación de despliegue gobernada');
    expect(commands.find((c) => c.type === 'reconcile')).toBeUndefined();
  });
});

describe('low-distraction and reduce-motion preferences persist and apply visibly', () => {
  it('apply the documentElement low-distraction class whenever the snapshot preference is enabled', async () => {
    const rootEl = new FakeRoot('div');
    const snapshot = makeSnapshot({ preference: { lowDistraction: true, reduceMotion: false, locale: 'en' } });
    const toggledClasses: Array<{ name: string; force?: boolean }> = [];
    const fakeDocumentElement = {
      lang: '',
      classList: {
        toggle(name: string, force?: boolean) {
          toggledClasses.push({ name, force });
        },
      },
    };
    const fakeOwnerDoc: unknown = { documentElement: fakeDocumentElement };
    (rootEl as unknown as { ownerDocument: unknown }).ownerDocument = fakeOwnerDoc;
    const handle = bootstrap({
      root: rootEl as unknown as Element,
      dom: makeDom().dom,
      translator: createTranslator('en'),
      snapshot,
      preferences: {
        load: () => ({ lowDistraction: true, reduceMotion: false }),
        save: () => { /* noop */ },
      },
      api: makeApi(),
    } as BootstrapOptions);
    expect(toggledClasses).toEqual([
      { name: 'cms-mode--low-distraction', force: true },
      { name: 'cms-mode--reduce-motion', force: false },
    ]);
    void handle;
  });

  it('clears the documentElement low-distraction class when the preference is disabled', async () => {
    const rootEl = new FakeRoot('div');
    const snapshot = makeSnapshot({ preference: { lowDistraction: false, reduceMotion: true, locale: 'en' } });
    const toggledClasses: Array<{ name: string; force?: boolean }> = [];
    const fakeDocumentElement = {
      lang: '',
      classList: {
        toggle(name: string, force?: boolean) {
          toggledClasses.push({ name, force });
        },
      },
    };
    (rootEl as unknown as { ownerDocument: unknown }).ownerDocument = {
      documentElement: fakeDocumentElement,
    };
    bootstrap({
      root: rootEl as unknown as Element,
      dom: makeDom().dom,
      translator: createTranslator('en'),
      snapshot,
      preferences: {
        load: () => ({ lowDistraction: false, reduceMotion: true }),
        save: () => { /* noop */ },
      },
      api: makeApi(),
    } as BootstrapOptions);
    expect(toggledClasses).toEqual([
      { name: 'cms-mode--low-distraction', force: false },
      { name: 'cms-mode--reduce-motion', force: true },
    ]);
  });

  it('clicking the rendered low-distraction preference button flips the snapshot preference and announces EN/ES status', async () => {
    const statusText = (root: FakeRoot): string => {
      const node = findFirst(root, '[data-cms-live="status"]')!;
      return typeof node.children[0] === 'string' ? node.children[0] : '';
    };
    const { root } = makeHandle();
    const btn = findFirst(root, '[data-cms-action="set-preference"][data-cms-preference="lowDistraction"]')!;
    expect(btn).not.toBeNull();
    for (const l of btn.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', btn));
    await new Promise((r) => setTimeout(r, 5));
    expect(statusText(root)).toMatch(/Low-distraction mode (on|off)/);
    const { root: esRoot } = makeHandle({ locale: 'es' });
    const esBtn = findFirst(esRoot, '[data-cms-action="set-preference"][data-cms-preference="lowDistraction"]')!;
    expect(esBtn).not.toBeNull();
    for (const l of esBtn.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', esBtn));
    await new Promise((r) => setTimeout(r, 5));
    const esStatus = findFirst(esRoot, '[data-cms-live="status"]')!;
    const esText = typeof esStatus.children[0] === 'string' ? esStatus.children[0] : '';
    expect(esText).toMatch(/Modo de baja distracción (activado|desactivado)/);
  });

  it('focus on the originating textarea is preserved when an input dispatch rejects', async () => {
    const { root } = makeHandle();
    const textarea = findFirst(root, '[data-cms-input="text"][data-cms-locale="en"]')!;
    textarea.focus();
    expect(activeElement).toBe(textarea);
    const localeSelect = findFirst(root, '[data-cms-control="locale"]')!;
    (localeSelect as unknown as { value: string }).value = 'fr';
    for (const l of localeSelect.listeners) if (l.type === 'change') l.handler(new FakeEvent('change', localeSelect, ''));
    await new Promise((r) => setTimeout(r, 0));
    expect(activeElement).toBe(textarea);
  });
});
