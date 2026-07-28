/// <reference lib="dom" />
/**
 * @cms/web — Accessibility test fixtures (en / es).
 *
 * English and Spanish are peer locales: there is no silent fallback.
 * These tests assert that the Tastecheck gate treats both locales
 * symmetrically: a clean document in either locale passes; a missing
 * `lang` or asymmetric peer marker fails on either side.
 *
 * The DOM shim and HTML parser are duplicated from tastecheck.test.ts
 * (kept self-contained per test file so each suite can be reasoned
 * about independently; production tastecheck.ts is the only module
 * the leader verifies end-to-end).
 */

import { describe, expect, it } from 'vitest';

import { evaluate } from '../src/tastecheck.js';

// ---------------------------------------------------------------------------
// Minimal DOM shim + HTML parser (subset of tastecheck.test.ts)
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
  querySelectorAll(selector: string): ElementList {
    return new ElementList(matchAll(this, selector));
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
  createElement(tagName: string): ElementNode {
    return new ElementNode(tagName.toUpperCase(), null);
  }
  createTextNode(text: string): TextNode {
    return new TextNode(text, null);
  }
}

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
  const alts = selector.split(',');
  for (const alt of alts) {
    if (matchesCompound(node, alt.trim())) return true;
  }
  return false;
}

function matchesCompound(node: ElementNode, compound: string): boolean {
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
  const eqIdx = attrSpec.search(/[=~|^$*]/);
  if (eqIdx < 0) return node.hasAttribute(attrSpec.trim());
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
  return op === '=' ? actual === value : actual === value;
}

interface ParsedToken {
  readonly kind: 'open' | 'close' | 'selfclose' | 'text' | 'comment' | 'doctype';
  readonly tag?: string;
  readonly attrs?: AttrMap;
  readonly text?: string;
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

function tokenize(html: string): ParsedToken[] {
  const out: ParsedToken[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      if (html.slice(i, i + 9).toLowerCase() === '<!doctype') {
        const endIdx = html.indexOf('>', i);
        if (endIdx < 0) throw new Error('unterminated doctype');
        i = endIdx + 1;
        continue;
      }
      if (html.slice(i, i + 4) === '<!--') {
        const endIdx = html.indexOf('-->', i);
        if (endIdx < 0) throw new Error('unterminated comment');
        i = endIdx + 3;
        continue;
      }
      if (html[i + 1] === '/') {
        const endIdx = html.indexOf('>', i);
        if (endIdx < 0) throw new Error('unterminated closing tag');
        const tag = html.slice(i + 2, endIdx).trim();
        out.push({ kind: 'close', tag: tag.toLowerCase() });
        i = endIdx + 1;
        continue;
      }
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
  propagateTextContent(htmlNode);
  return new FakeDocument(htmlNode);
}

function propagateTextContent(root: ElementNode): void {
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return (n as TextNode).textContent;
    let acc = '';
    for (const c of n.childNodes) acc += walk(c);
    (n as ElementNode).textContent = acc;
    return acc;
  };
  walk(root);
}

// ---------------------------------------------------------------------------
// Fixtures — mirror bilingual authoring in real CMS drafts
// ---------------------------------------------------------------------------

const SCREENSHOT_SHA = 'b'.repeat(64);

const STYLE_BLOCKS = `
  :focus-visible { outline: 2px solid #06f; }
  button, input, select, textarea { min-width: 32px; min-height: 32px; }
`;

function cleanEnFixture(): string {
  return `<!doctype html>
<html lang="en">
<head><style>${STYLE_BLOCKS}</style></head>
<body>
  <header><nav>navigation</nav></header>
  <main>
    <h1>Welcome</h1>
    <p>This is the English welcome page.</p>
    <div role="status" aria-live="polite">Status updates here.</div>
  </main>
  <footer>&copy; 2026</footer>
</body>
</html>`;
}

function cleanEsFixture(): string {
  return `<!doctype html>
<html lang="es">
<head><style>${STYLE_BLOCKS}</style></head>
<body>
  <header><nav>navegación</nav></header>
  <main>
    <h1>Bienvenido</h1>
    <p>Esta es la página de bienvenida en español.</p>
    <div role="status" aria-live="polite">Las actualizaciones de estado aparecen aquí.</div>
  </main>
  <footer>&copy; 2026</footer>
</body>
</html>`;
}

function brokenEnMissingLang(): string {
  // English draft with no `lang` attribute and a single h1.
  return `<!doctype html>
<html>
<head><style>${STYLE_BLOCKS}</style></head>
<body>
  <header></header>
  <main><h1>Welcome</h1></main>
  <footer></footer>
</body>
</html>`;
}

function brokenEsMissingAltWithPeer(): string {
  // Spanish content image inside `[lang="es"]` lacking the required
  // en peer marker — fails images.alt-policy in either locale.
  return `<!doctype html>
<html lang="es">
<head><style>${STYLE_BLOCKS}</style></head>
<body>
  <header></header>
  <main>
    <h1>Bienvenido</h1>
    <span lang="es">
      <img src="/hero.png" alt="Imagen principal" />
    </span>
    <div role="status" aria-live="polite">status</div>
  </main>
  <footer></footer>
</body>
</html>`;
}

function cleanEsLocalisedWithPeerMarker(): string {
  // Same as brokenEs but with `data-i18n-peer="en"` on the image:
  // the alt policy must recognise peer parity is satisfied.
  return `<!doctype html>
<html lang="es">
<head><style>${STYLE_BLOCKS}</style></head>
<body>
  <header></header>
  <main>
    <h1>Bienvenido</h1>
    <span lang="es">
      <img src="/hero.png" alt="Imagen principal" data-i18n-peer="en" />
    </span>
    <div role="status" aria-live="polite">status</div>
  </main>
  <footer></footer>
</body>
</html>`;
}

function brokenBothMissingH1(): string {
  return `<!doctype html>
<html lang="en">
<head><style>${STYLE_BLOCKS}</style></head>
<body>
  <header></header>
  <main>
    <p>no heading</p>
    <div role="status" aria-live="polite">status</div>
  </main>
  <footer></footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function evaluateAs(html: string, locale: 'en' | 'es') {
  return evaluate({
    locale,
    viewport: { width: 1280, height: 720 },
    screenshotSha256: SCREENSHOT_SHA,
    document: parseDocument(html) as unknown as Document,
  });
}

describe('bilingual accessibility — CLEAN baselines', () => {
  it('cleans an en draft that meets every blocking check', () => {
    const result = evaluateAs(cleanEnFixture(), 'en');
    expect(result.gate.verdict).toBe('CLEAN');
    expect(result.gate.fails).toHaveLength(0);
  });

  it('cleans an es draft that meets every blocking check', () => {
    const result = evaluateAs(cleanEsFixture(), 'es');
    expect(result.gate.verdict).toBe('CLEAN');
    expect(result.gate.fails).toHaveLength(0);
    expect(result.evidence.locale).toBe('es');
  });
});

describe('bilingual accessibility — symmetric failures', () => {
  it('fails an en draft with no html lang', () => {
    const result = evaluateAs(brokenEnMissingLang(), 'en');
    expect(result.gate.verdict).toBe('FAIL');
    const failIds = result.gate.fails.map((f) => f.id);
    expect(failIds).toContain('document.lang');
  });

  it('fails an es draft with no html lang', () => {
    // Same fixture but evaluated as es — document.lang check fires on
    // either locale and never silently falls back.
    const result = evaluateAs(brokenEnMissingLang(), 'es');
    expect(result.gate.verdict).toBe('FAIL');
    const failIds = result.gate.fails.map((f) => f.id);
    expect(failIds).toContain('document.lang');
  });

  it('fails images.alt-policy when a localised image lacks en peer marker', () => {
    const result = evaluateAs(brokenEsMissingAltWithPeer(), 'es');
    expect(result.gate.verdict).toBe('FAIL');
    const failIds = result.gate.fails.map((f) => f.id);
    expect(failIds).toContain('images.alt-policy');
  });

  it('passes images.alt-policy once the localised image declares an en peer', () => {
    const result = evaluateAs(cleanEsLocalisedWithPeerMarker(), 'es');
    // Other checks should still satisfy; only the image check matters.
    const failIds = result.gate.fails.map((f) => f.id);
    expect(failIds).not.toContain('images.alt-policy');
  });

  it('treats the same locale failure as a fail whether input locale is en or es', () => {
    const resultEn = evaluateAs(brokenBothMissingH1(), 'en');
    const resultEs = evaluateAs(brokenBothMissingH1(), 'es');
    expect(resultEn.gate.verdict).toBe('FAIL');
    expect(resultEs.gate.verdict).toBe('FAIL');
    expect(resultEn.gate.fails.map((f) => f.id)).toContain('headings.single-h1');
    expect(resultEs.gate.fails.map((f) => f.id)).toContain('headings.single-h1');
  });
});
