/// <reference lib="dom" />
/**
 * @cms/web — Tastecheck unit tests.
 *
 * The Tastecheck gate is a pure DOM evaluator. Tests build synthetic
 * `Document`-shaped trees using a minimal HTML parser (no jsdom /
 * linkedom dependencies; see scope constraint of this assignment) and
 * call `evaluate` with deterministic inputs. Each fixture is paired
 * with a specific acceptance criterion.
 *
 * Determinism rule: the same `(locale, viewport, screenshotSha256,
 * document, nima?)` input must always produce a structurally identical
 * result. We assert deep equality across repeated calls.
 *
 * No network calls, no randomness, no `Date.now()`: anything time-
 * dependent would make a "deterministic" gate impossible.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluate,
  BLOCKING_CHECK_IDS,
  type TastecheckInput,
} from '../src/tastecheck.js';

// ---------------------------------------------------------------------------
// Minimal HTML parser + DOM shim
// ---------------------------------------------------------------------------

interface AttrMap {
  readonly [name: string]: string;
}

class Node {
  readonly nodeType: 1 | 3;
  readonly nodeName: string;
  readonly childNodes: Node[];
  readonly parentNode: Node | null;
  readonly attrs: Map<string, string>;
  textContent: string;
  constructor(opts: {
    nodeType: 1 | 3;
    nodeName: string;
    text?: string;
    parentNode: Node | null;
  }) {
    this.nodeType = opts.nodeType;
    this.nodeName = opts.nodeName;
    this.parentNode = opts.parentNode;
    this.childNodes = [];
    this.attrs = new Map();
    this.textContent = opts.text ?? '';
  }
}

/**
 * HTMLCollection-shaped list. Real DOM `getElementsByTagName` and
 * `querySelectorAll` return live collections with `.length` and
 * `.item(i)`. Iteration on `[Symbol.iterator]` is provided for
 * convenience; the evaluator only ever uses `.item(i)`.
 */
class ElementList {
  private readonly items: ElementNode[];
  constructor(items: ElementNode[]) {
    this.items = items;
  }
  get length(): number {
    return this.items.length;
  }
  item(index: number): ElementNode | null {
    return this.items[index] ?? null;
  }
  [Symbol.iterator](): Iterator<ElementNode> {
    return this.items[Symbol.iterator]();
  }
  toArray(): ElementNode[] {
    return [...this.items];
  }
}

class ElementNode extends Node {
  declare readonly nodeType: 1;
  constructor(nodeName: string, parentNode: Node | null) {
    super({ nodeType: 1, nodeName, parentNode });
  }
  get tagName(): string {
    return this.nodeName;
  }
  get children(): ElementNode[] {
    return this.childNodes.filter((n): n is ElementNode => n.nodeType === 1);
  }
  getAttribute(name: string): string | null {
    const v = this.attrs.get(name);
    return v === undefined ? null : v;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  getElementsByTagName(name: string): ElementList {
    const want = name.toUpperCase();
    const out: ElementNode[] = [];
    const walk = (n: Node): void => {
      for (const c of n.childNodes) {
        if (c instanceof ElementNode) {
          if (c.tagName === want) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return new ElementList(out);
  }
  contains(other: Node | null): boolean {
    if (other === null) return false;
    let cur: Node | null = other;
    while (cur !== null) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  querySelectorAll(selector: string): ElementList {
    return new ElementList(matchAll(this, selector));
  }
  get parentElement(): ElementNode | null {
    return this.parentNode instanceof ElementNode ? this.parentNode : null;
  }
}

class TextNode extends Node {
  declare readonly nodeType: 3;
  constructor(text: string, parentNode: Node | null) {
    super({ nodeType: 3, nodeName: '#text', text, parentNode });
  }
}

class FakeDocument {
  readonly nodeType: 9;
  readonly nodeName: string;
  private readonly root: ElementNode;
  constructor(root: ElementNode) {
    this.nodeType = 9;
    this.nodeName = '#document';
    this.root = root;
  }
  get documentElement(): ElementNode {
    return this.root;
  }
  get body(): ElementNode | null {
    return this.root.getElementsByTagName('body').item(0);
  }
  getElementsByTagName(name: string): ElementList {
    const want = name.toUpperCase();
    const out: ElementNode[] = [];
    if (this.root.tagName === want) out.push(this.root);
    const walk = (n: Node): void => {
      for (const c of n.childNodes) {
        if (c instanceof ElementNode) {
          if (c.tagName === want) out.push(c);
          walk(c);
        }
      }
    };
    walk(this.root);
    return new ElementList(out);
  }
  querySelectorAll(selector: string): ElementList {
    return new ElementList(matchAll(this.root, selector));
  }
  querySelector(selector: string): ElementNode | null {
    return matchAll(this.root, selector)[0] ?? null;
  }
  getElementById(id: string): ElementNode | null {
    return queryAllByPredicate(this.root, (n) => n.attrs.get('id') === id)[0] ?? null;
  }
  createElement(tagName: string): ElementNode {
    return new ElementNode(tagName.toUpperCase(), null);
  }
  createTextNode(text: string): TextNode {
    return new TextNode(text, null);
  }
}

function queryAllByPredicate(
  root: ElementNode,
  predicate: (n: ElementNode) => boolean,
): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (n: ElementNode): void => {
    if (predicate(n)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// CSS selector subset — covers exactly the selectors used by tastecheck
// ---------------------------------------------------------------------------

function matchAll(root: ElementNode, selector: string): ElementNode[] {
  const selectors = selector.trim();
  const out: ElementNode[] = [];
  const walk = (n: ElementNode): void => {
    if (matches(n, selectors)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function matches(node: ElementNode, selector: string): boolean {
  // Comma-separated alternatives: any one matches ⇒ match.
  const alts = splitTopLevel(',', selector);
  for (const alt of alts) {
    if (matchesCompound(node, alt.trim())) return true;
  }
  return false;
}

function splitTopLevel(sep: string, s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function matchesCompound(node: ElementNode, compound: string): boolean {
  // Split into parts: tag, #id, .class, [attr=...]
  let i = 0;
  let tagOk = true;
  while (i < compound.length) {
    if (compound[i] === ' ') {
      i += 1;
      continue;
    }
    if (compound[i] === '[') {
      const closeIdx = compound.indexOf(']', i);
      if (closeIdx < 0) return false;
      const attrSpec = compound.slice(i + 1, closeIdx);
      i = closeIdx + 1;
      if (!matchAttr(node, attrSpec)) return false;
      continue;
    }
    if (compound[i] === '#') {
      const end = scanIdentEnd(compound, i + 1);
      const id = compound.slice(i + 1, end);
      i = end;
      if (node.getAttribute('id') !== id) return false;
      continue;
    }
    if (compound[i] === '.') {
      const end = scanIdentEnd(compound, i + 1);
      const cls = compound.slice(i + 1, end);
      i = end;
      const clsAttr = node.getAttribute('class') ?? '';
      if (!clsAttr.split(/\s+/).includes(cls)) return false;
      continue;
    }
    // Tag prefix (until first space, [, #, .)
    const end = scanIdentEnd(compound, i);
    const tag = compound.slice(i, end);
    i = end;
    if (tag.length > 0) {
      tagOk = node.tagName === tag.toUpperCase();
    }
    if (!tagOk) return false;
  }
  return tagOk;
}

function scanIdentEnd(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '[' || ch === '#' || ch === '.' || ch === ',') break;
    i += 1;
  }
  return i;
}

function matchAttr(node: ElementNode, attrSpec: string): boolean {
  // Supports: name, name="value", name='value', name=value (bare)
  const eqIdx = attrSpec.search(/[=~|^$*]/);
  if (eqIdx < 0) {
    return node.hasAttribute(attrSpec.trim());
  }
  const op = attrSpec[eqIdx];
  const name = attrSpec.slice(0, eqIdx).trim();
  let value = attrSpec.slice(eqIdx + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  const actual = node.getAttribute(name);
  if (actual === null) return false;
  switch (op) {
    case '=': {
      // For `[role="banner"]` style we need exact match. We also treat
      // any other `=` as exact match (the selectors we accept).
      return actual === value;
    }
    case '~': {
      return actual.split(/\s+/).includes(value);
    }
    default: {
      return actual === value;
    }
  }
}

// ---------------------------------------------------------------------------
// HTML parser → FakeDocument
// ---------------------------------------------------------------------------

interface ParsedToken {
  readonly kind: 'open' | 'close' | 'selfclose' | 'text' | 'comment' | 'doctype';
  readonly tag?: string;
  readonly attrs?: AttrMap;
  readonly text?: string;
}

function tokenize(html: string): ParsedToken[] {
  const out: ParsedToken[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      // Doctype
      if (html.slice(i, i + 9).toLowerCase() === '<!doctype') {
        const endIdx = html.indexOf('>', i);
        if (endIdx < 0) throw new Error('unterminated doctype');
        i = endIdx + 1;
        continue;
      }
      // Comment
      if (html.slice(i, i + 4) === '<!--') {
        const endIdx = html.indexOf('-->', i);
        if (endIdx < 0) throw new Error('unterminated comment');
        i = endIdx + 3;
        continue;
      }
      // Closing tag
      if (html[i + 1] === '/') {
        const endIdx = html.indexOf('>', i);
        if (endIdx < 0) throw new Error('unterminated closing tag');
        const tag = html.slice(i + 2, endIdx).trim();
        out.push({ kind: 'close', tag: tag.toLowerCase() });
        i = endIdx + 1;
        continue;
      }
      // Open tag or self-closing
      const endIdx = html.indexOf('>', i);
      if (endIdx < 0) throw new Error('unterminated tag');
      const inner = html.slice(i + 1, endIdx).trim();
      const selfClosing = inner.endsWith('/');
      const inner2 = selfClosing ? inner.slice(0, -1).trim() : inner;
      const sp = inner2.search(/\s/);
      const tagPart = sp < 0 ? inner2 : inner2.slice(0, sp);
      const attrPart = sp < 0 ? '' : inner2.slice(sp + 1);
      const tag = tagPart.toLowerCase();
      const attrs = parseAttrs(attrPart);
      if (selfClosing || VOID_TAGS.has(tag)) {
        out.push({ kind: 'selfclose', tag, attrs });
      } else {
        out.push({ kind: 'open', tag, attrs });
      }
      i = endIdx + 1;
      continue;
    }
    const next = html.indexOf('<', i);
    const text = next < 0 ? html.slice(i) : html.slice(i, next);
    if (text.length > 0) out.push({ kind: 'text', text });
    i = next < 0 ? html.length : next;
  }
  return out;
}

const VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function parseAttrs(input: string): AttrMap {
  const out: AttrMap = {};
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i] ?? '')) i += 1;
    if (i >= input.length) break;
    let nameStart = i;
    while (i < input.length && !/[\s=]/.test(input[i] ?? '')) i += 1;
    const name = input.slice(nameStart, i);
    if (name.length === 0) break;
    while (i < input.length && /\s/.test(input[i] ?? '')) i += 1;
    let value = '';
    if (input[i] === '=') {
      i += 1;
      while (i < input.length && /\s/.test(input[i] ?? '')) i += 1;
      const q = input[i];
      if (q === '"' || q === "'") {
        i += 1;
        const start = i;
        while (i < input.length && input[i] !== q) i += 1;
        value = input.slice(start, i);
        if (i < input.length) i += 1;
      } else {
        const start = i;
        while (i < input.length && !/[\s>]/.test(input[i] ?? '')) i += 1;
        value = input.slice(start, i);
      }
    }
    out[name] = value;
  }
  return out;
}

function parseDocument(html: string): FakeDocument {
  const tokens = tokenize(html);
  const htmlNode = new ElementNode('HTML', null);
  const stack: ElementNode[] = [htmlNode];
  for (const tok of tokens) {
    if (tok.kind === 'open' && tok.tag !== undefined && tok.attrs !== undefined) {
      if (tok.tag.toLowerCase() === 'html' && stack.length === 1) {
        for (const [key, value] of Object.entries(tok.attrs)) htmlNode.attrs.set(key, value);
        continue;
      }
      const parent = stack[stack.length - 1] ?? htmlNode;
      const el = new ElementNode(tok.tag.toUpperCase(), parent);
      for (const [k, v] of Object.entries(tok.attrs)) el.attrs.set(k, v);
      el.parentNode.childNodes.push(el);
      stack.push(el);
      continue;
    }
    if (tok.kind === 'selfclose' && tok.tag !== undefined && tok.attrs !== undefined) {
      const parent = stack[stack.length - 1] ?? htmlNode;
      const el = new ElementNode(tok.tag.toUpperCase(), parent);
      for (const [k, v] of Object.entries(tok.attrs)) el.attrs.set(k, v);
      el.parentNode.childNodes.push(el);
      continue;
    }
    if (tok.kind === 'close' && tok.tag !== undefined) {
      const want = tok.tag.toUpperCase();
      for (let s = stack.length - 1; s > 0; s -= 1) {
        const top = stack[s];
        if (top !== undefined && top.tagName === want) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    if (tok.kind === 'text' && tok.text !== undefined) {
      const parent = stack[stack.length - 1] ?? htmlNode;
      const textNode = new TextNode(tok.text, parent);
      parent.childNodes.push(textNode);
    }
  }
  // Compute textContent for each element by concatenating descendant
  // text nodes (used by the `<style>` text extractor in the evaluator).
  propagateTextContent(htmlNode);
  return new FakeDocument(htmlNode);
}

function propagateTextContent(root: ElementNode): void {
  const walk = (n: Node): string => {
    if (n.nodeType === 3) {
      return (n as TextNode).textContent;
    }
    let acc = '';
    for (const c of n.childNodes) acc += walk(c);
    (n as ElementNode).textContent = acc;
    return acc;
  };
  walk(root);
}

// ---------------------------------------------------------------------------
// Fixture / factory helpers
// ---------------------------------------------------------------------------

const SCREENSHOT_SHA = 'a'.repeat(64);

function inputFromHtml(html: string, opts?: {
  locale?: 'en' | 'es';
  nima?: TastecheckInput['nima'];
}): TastecheckInput {
  const document = parseDocument(html);
  return {
    locale: opts?.locale ?? 'en',
    viewport: { width: 1280, height: 720 },
    screenshotSha256: SCREENSHOT_SHA,
    document: document as unknown as Document,
    nima: opts?.nima,
  };
}

/**
 * A "clean" fixture that satisfies all ten blocking checks: lang set,
 * one h1, main/header/footer, no form controls, no images, focus hooks,
 * min-target hooks, status region, no positive tabindex, no destructive
 * buttons. Used to assert the CLEAN baseline.
 */
function cleanDocument(locale: 'en' | 'es' = 'en'): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
  <style>
    :focus-visible { outline: 2px solid #06f; }
    button { min-width: 32px; min-height: 32px; }
  </style>
</head>
<body>
  <header><nav>nav</nav></header>
  <main>
    <h1>Title</h1>
    <div role="status" aria-live="polite">status</div>
  </main>
  <footer>footer</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BLOCKING_CHECK_IDS', () => {
  it('is exactly ten ids in a stable order', () => {
    expect(BLOCKING_CHECK_IDS.length).toBe(10);
    expect(BLOCKING_CHECK_IDS[0]).toBe('document.lang');
    expect(BLOCKING_CHECK_IDS[1]).toBe('headings.single-h1');
    expect(BLOCKING_CHECK_IDS[9]).toBe('targets.min-size-hooks');
  });
});

describe('evaluate — determinism', () => {
  it('returns byte-identical output for the same input', () => {
    const input = inputFromHtml(cleanDocument(), { nima: undefined });
    const a = evaluate(input);
    const b = evaluate(input);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('emits fails in deterministic, evaluation order', () => {
    const html = `<!doctype html><html><body>
      <span>no lang</span>
      <span>no h1</span>
    </body></html>`;
    const input = inputFromHtml(html, { locale: 'en', nima: undefined });
    const result = evaluate(input);
    const failIds = result.gate.fails.map((f) => f.id);
    // First fail must be document.lang (it is checked first), even though
    // every other check also fails — order is stable.
    expect(failIds[0]).toBe('document.lang');
    expect(result.gate.verdict).toBe('FAIL');
  });
});

describe('evaluate — CLEAN baseline', () => {
  it('passes an en clean fixture with no NIMA', () => {
    const result = evaluate(inputFromHtml(cleanDocument('en')));
    expect(result.gate.verdict).toBe('CLEAN');
    expect(result.gate.fails).toHaveLength(0);
    expect(result.gate.warns).toHaveLength(0);
    expect(result.aesthetic.verdict).toBe('n/a');
    expect(result.aesthetic.score).toBe(null);
    expect(result.aesthetic.histogram).toBe(null);
  });

  it('passes an es clean fixture with no NIMA', () => {
    const result = evaluate(inputFromHtml(cleanDocument('es'), { locale: 'es' }));
    expect(result.gate.verdict).toBe('CLEAN');
    expect(result.evidence.locale).toBe('es');
  });
});

describe('evaluate — each blocking check fails independently', () => {
  it('fails document.lang when lang is unsupported or missing', () => {
    const html = `<!doctype html><html lang="fr"><body>
      <header></header><main><h1>x</h1><div role="status"></div></main><footer></footer>
    </body></html>`;
    const result = evaluate(inputFromHtml(html, { locale: 'en' }));
    expect(result.gate.verdict).toBe('FAIL');
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).toContain('document.lang');
  });

  it('fails headings.single-h1 when no h1', () => {
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main><p>no h1</p><div role="status"></div></main><footer></footer>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).toContain('headings.single-h1');
  });

  it('fails headings.single-h1 when more than one h1', () => {
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main>
        <h1>first</h1><h1>second</h1>
        <div role="status"></div>
      </main><footer></footer>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const failing = result.gate.fails.find((f) => f.id === 'headings.single-h1');
    expect(failing).toBeDefined();
    expect(failing!.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('fails landmarks.required when no main/header/footer', () => {
    const html = `<!doctype html><html lang="en"><body>
      <h1>title</h1>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).toContain('landmarks.required');
  });

  it('fails forms.labeled-controls for unlabelled inputs', () => {
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main>
        <h1>title</h1>
        <input type="text" />
        <div role="status"></div>
      </main><footer></footer>
      <style>:focus-visible{outline:2px solid #06f} button,input{min-width:32px;min-height:32px}</style>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).toContain('forms.labeled-controls');
  });

  it('fails images.alt-policy when an image has no alt', () => {
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main>
        <h1>title</h1>
        <img src="/x.png" />
        <div role="status"></div>
      </main><footer></footer>
      <style>:focus-visible{outline:2px solid #06f} button,img{min-width:32px;min-height:32px}</style>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).toContain('images.alt-policy');
  });

  it('fails interactive.focus-style-hooks when no focus rule in stylesheet', () => {
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main>
        <h1>title</h1>
        <div role="status"></div>
      </main><footer></footer>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).toContain('interactive.focus-style-hooks');
  });

  it('fails tabindex.no-positive when tabindex=1 is present', () => {
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main>
        <h1>title</h1>
        <button tabindex="1">x</button>
        <div role="status"></div>
      </main><footer></footer>
      <style>:focus-visible{outline:2px solid #06f} button{min-width:32px;min-height:32px}</style>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).toContain('tabindex.no-positive');
  });

  it('fails live.status when no status or aria-live region', () => {
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main>
        <h1>title</h1>
      </main><footer></footer>
      <style>:focus-visible{outline:2px solid #06f} button{min-width:32px;min-height:32px}</style>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).toContain('live.status');
  });

  it('fails destructive.confirmation-marker when destructive button has no data-confirm', () => {
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main>
        <h1>title</h1>
        <button data-destructive="true">delete</button>
        <div role="status"></div>
      </main><footer></footer>
      <style>:focus-visible{outline:2px solid #06f} button{min-width:32px;min-height:32px}</style>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).toContain('destructive.confirmation-marker');
  });

  it('accepts a minimum target size supplied through a resolved CSS token', () => {
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main>
        <h1>title</h1>
        <button>save</button>
        <div role="status"></div>
      </main><footer></footer>
      <style>:root{--control-size:44px}button{min-height:var(--control-size)}:focus-visible{outline:2px solid #06f}</style>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).not.toContain('targets.min-size-hooks');
  });
  it('fails targets.min-size-hooks when no min-size rule in stylesheet', () => {
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main>
        <h1>title</h1>
        <div role="status"></div>
      </main><footer></footer>
      <style>button{padding:4px}:focus-visible{outline:2px solid #06f}</style>
    </body></html>`;
    const result = evaluate(inputFromHtml(html));
    const ids = result.gate.fails.map((f) => f.id);
    expect(ids).toContain('targets.min-size-hooks');
  });
});

describe('evaluate — warnings and NIMA', () => {
  it('aggregates NIMA warning into REVIEW WARNS without failing the gate', () => {
    const nima = {
      present: true as const,
      score: 4.2,
      histogram: [0.1, 0.2, 0.3, 0.2, 0.1, 0.05, 0.05, 0, 0, 0],
    };
    const result = evaluate(
      inputFromHtml(cleanDocument('en'), { nima }),
    );
    expect(result.gate.verdict).toBe('REVIEW WARNS');
    expect(result.aesthetic.verdict).toBe('warn');
    expect(result.aesthetic.score).toBe(4.2);
    expect(result.aesthetic.histogram?.length).toBe(10);
    expect(result.gate.warns.map((w) => w.id)).toContain('aesthetic.nima');
  });

  it('marks aesthetic as n/a when NIMA is absent', () => {
    const result = evaluate(inputFromHtml(cleanDocument('en'), { nima: undefined }));
    expect(result.aesthetic.verdict).toBe('n/a');
    expect(result.aesthetic.score).toBe(null);
    expect(result.gate.verdict).toBe('CLEAN');
  });

  it('marks aesthetic as n/a when NIMA receipt is marked absent', () => {
    const nima = { present: false as const };
    const result = evaluate(inputFromHtml(cleanDocument('en'), { nima }));
    expect(result.aesthetic.verdict).toBe('n/a');
    expect(result.gate.verdict).toBe('CLEAN');
    expect(result.gate.warns).toHaveLength(0);
  });

  it('never lets NIMA turn the gate into FAIL (even with score=0)', () => {
    const nima = {
      present: true as const,
      score: 0,
      histogram: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    const result = evaluate(inputFromHtml(cleanDocument('en'), { nima }));
    expect(result.gate.verdict).not.toBe('FAIL');
    // Even with score=0 the gate is at most REVIEW WARNS.
    expect(result.gate.verdict).toBe('REVIEW WARNS');
  });

  it('still FAILs the gate when both NIMA warn and a blocking check fail', () => {
    const nima = {
      present: true as const,
      score: 1.5,
      histogram: [0.4, 0.3, 0.2, 0.05, 0.05, 0, 0, 0, 0, 0],
    };
    const html = `<!doctype html><html lang="en"><body>
      <header></header><main>
        <h1>x</h1>
        <div role="status"></div>
      </main><footer></footer>
    </body></html>`;
    const result = evaluate(inputFromHtml(html, { nima }));
    expect(result.gate.verdict).toBe('FAIL');
    expect(result.gate.warns.length).toBeGreaterThan(0);
  });
});

describe('evaluate — evidence passthrough', () => {
  it('forwards locale, viewport, screenshotSha256', () => {
    const result = evaluate(
      inputFromHtml(cleanDocument('es'), {
        locale: 'es',
        nima: undefined,
      }),
    );
    expect(result.evidence.locale).toBe('es');
    expect(result.evidence.viewport).toEqual({ width: 1280, height: 720 });
    expect(result.evidence.screenshotSha256).toBe(SCREENSHOT_SHA);
  });
});
