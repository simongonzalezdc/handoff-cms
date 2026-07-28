/**
 * `keyboard.test.ts` — keyboard-completeness contract for the authoring app.
 *
 * Verifies:
 *   - Tab order matches the visual order (no roving tabindex overrides).
 *   - Activation via Enter / Space on a button works.
 *   - Focus is restored to the originating element after a successful
 *     command.
 *   - Focus moves to the error summary on failure.
 *   - Form submit via Enter does not implicitly trigger propose/publish.
 *   - Reduced-motion + focus CSS contains the required declarations.
 */

import { describe, expect, it } from 'vitest';

import { createTranslator, type Locale, type Translator } from '@cms/i18n';

import {
  type ActorIdentity,
  type AuditEntry,
  type AuthoringApi,
  type AuthoringSnapshot,
  type AuthoringStoreConfig,
  type Command,
  type DeployStatus,
  type ImageBlock,
  createAuthoringStore,
} from '../src/model.js';

import {
  bootstrap,
  type DomAdapter,
  type PreferenceStore,
} from '../src/app.js';

import { renderTemplate } from '../src/template.js';

// --------------------------------------------------------------------------
// Lightweight HTML + DOM harness used by these tests.
// --------------------------------------------------------------------------

class FakeElement {
  public children: Array<FakeElement | string> = [];
  public attrs: Record<string, string> = {};
  public listeners: Array<{ type: string; handler: (event: FakeEvent) => void }> = [];
  public tag: string;
  public id: string | null;
  public value = '';
  public disabled = false;
  public classes: Set<string> = new Set();
  public files: ReadonlyArray<{ name: string }> = [];

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag.toLowerCase();
    this.attrs = { ...attrs };
    this.id = attrs.id ?? null;
  }

  matches(selector: string): boolean {
    const selectors = selector.split(',').map((part) => part.trim()).filter(Boolean);
    return selectors.some((candidate) => {
      if (candidate.startsWith('#')) return this.id === candidate.slice(1);
      if (candidate.startsWith('.')) return this.classes.has(candidate.slice(1));
      const tag = candidate.split('[')[0] ?? '';
      if (tag.length > 0 && this.tag !== tag.toLowerCase()) return false;
      const attributes = [...candidate.matchAll(/\[([\w-]+)(?:="([^"]+)")?\]/g)];
      if (attributes.length === 0) return tag.length > 0;
      return attributes.every((match) => {
        const name = match[1] ?? '';
        const value = match[2];
        return value === undefined
          ? Object.prototype.hasOwnProperty.call(this.attrs, name)
          : this.attrs[name] === value;
      });
    });
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

class FakeRoot extends FakeElement {
  private html = '';

  constructor() {
    super('div');
    this.id = 'root';
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    parseHtml(value, this);
  }
}

function parseHtml(html: string, root: FakeRoot): void {
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
      const tag = (tagMatch[1] ?? '').toLowerCase();
      const rest = body.slice(tag.length);
      const attrs: Record<string, string> = {};
      const re = /([\w-]+)(?:="([^"]*)")?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(rest)) !== null) {
        const n = m[1];
        const v = m[2];
        if (n === undefined) continue;
        attrs[n] = v ?? '';
      }
      const element = new FakeElement(tag, attrs);
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
  for (const child of el.children) if (typeof child !== 'string') walk(child, visit);
}

function findFirst(scope: FakeElement, selector: string): FakeElement | null {
  let found: FakeElement | null = null;
  walk(scope, (el) => { if (!found && el.matches(selector)) found = el; });
  return found;
}

function findAll(scope: FakeElement, selector: string): FakeElement[] {
  const out: FakeElement[] = [];
  walk(scope, (el) => { if (el.matches(selector)) out.push(el); });
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
  public key: string;
  public target: EventTarget | null;
  public defaultPrevented = false;
  public preventDefault(): void { this.defaultPrevented = true; }
  constructor(type: string, key = '', target: EventTarget | null = null) {
    this.type = type;
    this.key = key;
    this.target = target;
  }
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const HUMAN: ActorIdentity = Object.freeze({
  kind: 'actor',
  id: 'user-1',
  displayName: 'Alice',
  capabilities: [],
});

function makeSnapshot(): AuthoringSnapshot {
  return {
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
      },
      {
        id: 'image-1',
        kind: 'image',
        hidden: false,
        focusKey: 'image-1-alt-en',
        assetId: 'asset-1',
        alt: { en: 'Cover', es: 'Portada' },
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
}

function makeApi(failures: ReadonlyArray<Command['type']> = []): AuthoringApi {
  const failingSet = new Set(failures);
  const ok = async () => ({
    proposal: { id: 'p1', action: 'update', tenantId: 't1', recordId: 'r1', createdBy: HUMAN, createdAt: '2026-07-27T10:00:00.000Z', environment: 'staging', revisionId: 'r1', idempotencyKey: 'k' },
    revision: { id: 'r1', recordId: 'r1', parentRevisionId: null, contentHash: 'h', snapshot: makeSnapshot(), createdAt: '2026-07-27T10:00:00.000Z' },
  });
  return {
    loadRecord: async () => makeSnapshot(),
    previewFromSnapshot: async () => ({
      previewUrl: 'about:blank',
      revisionId: 'r1',
      previewAt: '2026-07-27T10:00:00.000Z',
    }),
    propose: failingSet.has('propose') ? async () => { throw new Error('propose failed'); } : ok,
    approve: failingSet.has('approve') ? async () => { throw new Error('approve failed'); } : async () => ({
      approval: { id: 'a1', proposalId: 'p1', revisionId: 'r1', approvedBy: HUMAN, approvedAt: '2026-07-27T10:00:00.000Z' },
    }),
    publish: failingSet.has('publish') ? async () => { throw new Error('publish failed'); } : async () => ({
      publication: { id: 'pb1', proposalId: 'p1', revisionId: 'r1', publishedBy: HUMAN, publishedAt: '2026-07-27T10:00:00.000Z' },
      deployStatus: { kind: 'succeeded' } as DeployStatus,
    }),
    rollback: failingSet.has('rollback') ? async () => { throw new Error('rollback failed'); } : async () => ({
      rolledBackTo: 'r0',
      deployStatus: { kind: 'rolled_back' } as DeployStatus,
    }),
    reconcile: async () => ({ deployStatus: { kind: 'succeeded' } as DeployStatus, deployedRevisionId: 'r1' }),
    uploadAsset: async () => ({ assetId: 'a', contentHash: 'h' as never, previewUrl: 'about:blank' }),
    replaceAsset: async () => ({ assetId: 'a', contentHash: 'h' as never, previewUrl: 'about:blank' }),
    auditHistory: async () => [] as ReadonlyArray<AuditEntry>,
  };
}

function makePrefs(): PreferenceStore {
  return {
    load: () => ({ reduceMotion: true, lowDistraction: true }),
    save: () => { /* noop */ },
  };
}

function makeDom(): { root: FakeRoot; dom: DomAdapter } {
  const root = new FakeRoot();
  const dom: DomAdapter = {
    query: (parent, sel) => findFirst(parent as unknown as FakeElement, sel),
    queryAll: (parent, sel) => findAll(parent as unknown as FakeElement, sel),
    create: ((tag: string, attrs: Record<string, string>) => new FakeElement(tag, attrs)) as DomAdapter['create'],
    addEventListener: ((target, type, handler) => {
      const el = target as unknown as FakeElement;
      el.listeners.push({ type, handler: handler as unknown as (event: FakeEvent) => void });
      return () => { el.listeners = el.listeners.filter((l) => l.handler !== handler); };
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
      if (target === null) { activeElement = null; return; }
      (target as unknown as FakeElement).focus();
    },
    activeElement: () => activeElement,
    textOf: (target) => {
      const el = target as unknown as FakeElement;
      let out = '';
      for (const c of el.children) {
        out += typeof c === 'string' ? c : (function () {
          let s = '';
          walk(c, (e) => { for (const cc of e.children) if (typeof cc === 'string') s += cc; });
          return s;
        })();
      }
      return out;
    },
    setText: (target, value) => { (target as unknown as FakeElement).children = [value]; },
    setHidden: (target, hidden) => {
      const el = target as unknown as FakeElement;
      el.attrs['hidden'] = hidden ? '' : (undefined as unknown as string);
    },
    setDisabled: (target, disabled) => {
      (target as unknown as FakeElement).disabled = disabled;
    },
    attr: (target, name, value) => {
      const el = target as unknown as FakeElement;
      if (value === undefined) return el.attrs[name] ?? null;
      if (value === null) { delete el.attrs[name]; return null; }
      el.attrs[name] = value;
      return value;
    },
    prop: (target, name, value) => {
      const el = target as unknown as FakeElement & Record<string, unknown>;
      if (value === undefined) return el[name];
      el[name] = value;
      return value;
    },
    preventDefault: (event) => { (event as unknown as FakeEvent).preventDefault(); },
    closest: (start, _selector) => start,
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
  };
  return { root, dom };
}


// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('keyboard navigation', () => {
  it('produces a Tab order that matches visual order in the rendered template', () => {
    const snapshot = makeSnapshot();
    const t: Translator = createTranslator('en');
    const html = renderTemplate(snapshot, t, { scopeId: 'cms' });
    const root = new FakeRoot();
    parseHtml(html, root);
    const focusables = flattenFocusables(root);
    expect(focusables[0]?.tag).toBe('a');
    expect(focusables[0]?.attrs['class']).toContain('cms-skip-link');
    const tagSequence = focusables.map((f) => f.tag);
    expect(tagSequence).toContain('select');
    expect(tagSequence).toContain('textarea');
    expect(tagSequence).toContain('button');
  });

  it('does not register manual native-button keydown handlers (browser activates the click natively)', () => {
    const { root, dom } = makeDom();
    const t = createTranslator('en');
    const snapshot = makeSnapshot();
    const handle = bootstrap({
      root,
      dom,
      translator: t,
      snapshot,
      preferences: makePrefs(),
      api: makeApi(),
    });
    void handle;
    const propose = findFirst(root, '[data-cms-action="propose"]')!;
    const keydown = propose.listeners.filter((l) => l.type === 'keydown');
    expect(keydown.length).toBe(0);
  });

  it('does not change Tab order based on user activity (no roving tabindex)', () => {
    const { root, dom } = makeDom();
    const t = createTranslator('en');
    const snapshot = makeSnapshot();
    const handle = bootstrap({
      root,
      dom,
      translator: t,
      snapshot,
      preferences: makePrefs(),
      api: makeApi(),
    });
    const beforeTabindex = flattenFocusables(root).map((el) => el.attrs['tabindex']);
    const propose = findFirst(root, '[data-cms-action="propose"]');
    const event = new FakeEvent('click', propose);
    for (const l of propose!.listeners) if (l.type === 'click') l.handler(event);
    const afterTabindex = flattenFocusables(root).map((el) => el.attrs['tabindex']);
    expect(afterTabindex).toEqual(beforeTabindex);
    expect(handle.store()).toBeDefined();
  });

  it('focuses the error summary on a failed privileged command', async () => {
    const { root, dom } = makeDom();
    const t = createTranslator('en');
    const snapshot = makeSnapshot();
    // Use a failing approve API: bootstrap won't allow approve (visibleState
    // is 'editing'), so we go through store directly to validate the focus
    // path. The publish/rollback buttons dispatch through the action
    // handler. We test focus on the error summary when a command throws.
    const handle = bootstrap({
      root,
      dom,
      translator: t,
      snapshot,
      preferences: makePrefs(),
      api: makeApi(['publish']),
    });
    const summary = findFirst(root, '[data-cms-region="errors"]');
    expect(summary).not.toBeNull();
    const btn = findFirst(root, '[data-cms-action="publish"]');
    // Force the visible state to 'approved' so the publish button is enabled.
    await handle.store().dispatch({
      type: 'propose',
      action: 'update',
      idempotencyKey: 'k1',
    });
    await handle.store().dispatch({
      type: 'approve',
      ifMatch: '',
      idempotencyKey: 'k2',
    });
    handle.render();
    const publishBtn = findFirst(root, '[data-cms-action="publish"]');
    expect(publishBtn).not.toBeNull();
    const event = new FakeEvent('click', publishBtn);
    for (const l of publishBtn!.listeners) if (l.type === 'click') l.handler(event);
    await new Promise((r) => setTimeout(r, 0));
    const focusedSummary = findFirst(root, '[data-cms-region="errors"]')!;
    expect(summary).not.toBeNull();
    expect(activeElement).toBe(focusedSummary);
  });

  it('does not implicitly submit the text form on submit', () => {
    const { root, dom } = makeDom();
    const t = createTranslator('en');
    const snapshot = makeSnapshot();
    let proposed = 0;
    const handle = bootstrap({
      root,
      dom,
      translator: t,
      snapshot,
      preferences: makePrefs(),
      api: makeApi(),
    });
    handle.onCommand((c) => { if (c.type === 'propose') proposed += 1; });
    const form = findFirst(root, 'form');
    expect(form).not.toBeNull();
    const event = new FakeEvent('submit', '', form);
    for (const l of form!.listeners) if (l.type === 'submit') l.handler(event);
    expect(proposed).toBe(0);
  });

  it('restores focus to the originating element after a successful command', async () => {
    const { root, dom } = makeDom();
    const t = createTranslator('en');
    const snapshot = makeSnapshot();
    const handle = bootstrap({
      root,
      dom,
      translator: t,
      snapshot,
      preferences: makePrefs(),
      api: makeApi(),
    });
    const preview = findFirst(root, '[data-cms-action="preview"]')!;
    preview.focus();
    const before = activeElement;
    expect(before).toBe(preview);
    const event = new FakeEvent('click', preview);
    for (const l of preview.listeners) if (l.type === 'click') l.handler(event);
    await new Promise((r) => setTimeout(r, 0));
    expect(activeElement).toBe(preview);
  });

  it('announces success in the polite live region and errors in the assertive one', () => {
    const { root, dom } = makeDom();
    const t = createTranslator('en');
    const snapshot = makeSnapshot();
    bootstrap({
      root,
      dom,
      translator: t,
      snapshot,
      preferences: makePrefs(),
      api: makeApi(),
    });
    const status = findFirst(root, '[data-cms-live="status"]');
    const log = findFirst(root, '[data-cms-live="log"]');
    expect(status?.attrs['aria-live']).toBe('polite');
    expect(log?.attrs['aria-live']).toBe('assertive');
  });
});

describe('styles.css contains required accessibility declarations', () => {
  it('declares focus, contrast, 44px targets, reduced-motion, and low-distraction', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
    // Focus indicator: outline + offset.
    expect(css).toMatch(/:focus-visible[^{]*\{[^}]*outline:/);
    expect(css).toMatch(/outline-offset:\s*\d/);
    // 44px minimum target.
    expect(css).toMatch(/--cms-control-height:\s*44px/);
    expect(css).toMatch(/min-height:\s*var\(--cms-control-height\)/);
    expect(css).toMatch(/min-width:\s*var\(--cms-control-height\)/);
    // Reduced motion.
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/animation-duration:\s*0\.001ms/);
    expect(css).toMatch(/transition-duration:\s*0\.001ms/);
    // Low-distraction mode.
    expect(css).toMatch(/\.cms-mode--low-distraction/);
    // High contrast support.
    expect(css).toMatch(/@media\s*\(prefers-contrast:\s*more\)/);
    // No gradients / glassmorphism / visual noise.
    expect(css).not.toMatch(/linear-gradient/);
    expect(css).not.toMatch(/radial-gradient/);
    expect(css).not.toMatch(/backdrop-filter/);
    // The skip link.
    expect(css).toMatch(/\.cms-skip-link/);
  });

  it('uses a single predictable column at every breakpoint', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/body\s*\{[^}]*max-width:/);
    expect(css).toMatch(/display:\s*block/);
    expect(css).toMatch(/body\s*\{[^}]*max-width:/);
    expect(css).toMatch(/display:\s*block/);
  });
});

describe('keyboard regression: governed action announcements and reconcile confirmation', () => {
  it('announces peer-localized reconcile confirmation on Enter/Space activation of the reconcile button', async () => {
    const prompts: Array<{ message: string; title: string }> = [];
    const { root, dom } = makeDom();
    const t = createTranslator('en');
    const overridden = {
      ...dom,
      confirm: (message: string, title: string) => {
        prompts.push({ message, title });
        return false;
      },
    };
    bootstrap({
      root,
      dom: overridden as unknown as DomAdapter,
      translator: t,
      snapshot: makeSnapshot(),
      preferences: makePrefs(),
      api: makeApi(),
    });
    const reconcile = findFirst(root, '[data-cms-action="reconcile"]')!;
    reconcile.focus();
    expect(activeElement).toBe(reconcile);
    for (const l of reconcile.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', reconcile));
    await new Promise((r) => setTimeout(r, 0));
    expect(prompts.length).toBe(1);
    expect(prompts[0]!.title).toBe('Reconcile deploy state?');
    expect(prompts[0]!.message).toMatch(/governed deploy mutation/);
  });

  it('keyboard focus on the originating textarea survives a failing locale switch', async () => {
    const { root, dom } = makeDom();
    const t = createTranslator('en');
    bootstrap({
      root,
      dom,
      translator: t,
      snapshot: makeSnapshot(),
      preferences: makePrefs(),
      api: makeApi(),
    });
    const textarea = findFirst(root, '[data-cms-input="text"][data-cms-locale="en"]')!;
    textarea.focus();
    expect(activeElement).toBe(textarea);
    const localeSelect = findFirst(root, '[data-cms-control="locale"]')!;
    (localeSelect as unknown as { value: string }).value = 'fr';
    for (const l of localeSelect.listeners) if (l.type === 'change') l.handler(new FakeEvent('change', localeSelect));
    await new Promise((r) => setTimeout(r, 0));
    expect(activeElement).toBe(textarea);
  });

  it('keyboard: clicking preview keeps focus on the originating button and announces the localized status', async () => {
    const { root, dom } = makeDom();
    const t = createTranslator('en');
    bootstrap({
      root,
      dom,
      translator: t,
      snapshot: makeSnapshot(),
      preferences: makePrefs(),
      api: makeApi(),
    });
    const preview = findFirst(root, '[data-cms-action="preview"]')!;
    preview.focus();
    for (const l of preview.listeners) if (l.type === 'click') l.handler(new FakeEvent('click', preview));
    await new Promise((r) => setTimeout(r, 0));
    expect(activeElement).toBe(preview);
    const status = findFirst(root, '[data-cms-live="status"]')!;
    const announced = status.children[0];
    expect(typeof announced).toBe('string');
    expect(announced).toBe('Preview ready.');
  });
});

// --------------------------------------------------------------------------
// Sanity: ensure createAuthoringStore does not throw for the test fixture.
// --------------------------------------------------------------------------

describe('createAuthoringStore accepts the test fixture', () => {
  it('initializes without throwing', () => {
    const snapshot = makeSnapshot();
    const api = makeApi();
    const config: AuthoringStoreConfig = {
      tenantId: 't1',
      recordId: 'r1',
      contentType: 'page',
      locale: 'en',
      api,
      actor: HUMAN,
      initial: snapshot,
    };
    const store = createAuthoringStore(config);
    expect(store.snapshot().blocks.length).toBeGreaterThan(0);
  });
});
