/// <reference lib="dom" />
/**
 * @cms/web — Tastecheck gate.
 *
 * Deterministic, self-hostable DOM evaluator. Framework-free.
 * Computes 10 named blocking front-end craft + accessibility checks plus
 * one WARN-only aesthetic receipt (NIMA) until calibration. No network
 * calls, no randomness, no timestamps: same input → byte-identical
 * structured output. The UI is a thin projection; this gate is the
 * authority on whether an authoring draft clears publishing.
 *
 * Stable check ids (deterministic ordering):
 *   1.  document.lang
 *   2.  headings.single-h1
 *   3.  landmarks.required
 *   4.  forms.labeled-controls
 *   5.  images.alt-policy
 *   6.  interactive.focus-style-hooks
 *   7.  tabindex.no-positive
 *   8.  live.status
 *   9.  destructive.confirmation-marker
 *   10. targets.min-size-hooks
 *
 * Plus check #11 `aesthetic.nima` is WARN-only and never turns the gate
 * to FAIL. Missing NIMA → `aesthetic.verdict: 'n/a'`.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inputs to the evaluator. Everything is treated as read-only; the
 * evaluator never mutates the document. The host is responsible for
 * computing the screenshot SHA-256 off the produced render before
 * handing it in; the gate does no hashing.
 */
export interface TastecheckInput {
  readonly locale: 'en' | 'es';
  readonly viewport: ViewportSize;
  readonly screenshotSha256: string;
  readonly document: Document;
  readonly nima?: NimaReceipt | undefined;
}

/** Render viewport. Width and height in CSS pixels. */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Optional NIMA aesthetic receipt. Service-down or absent ⇒ n/a.
 * `histogram` is required when `score` is present: any score is
 * WARN-only and never flips the gate to FAIL.
 */
export interface NimaReceipt {
  readonly score: number;
  readonly histogram: ReadonlyArray<number>;
  readonly present: true;
}

/** NIMA not available — service down, calibration pending, etc. */
export interface NimaMissing {
  readonly present: false;
}

export interface CheckFailure {
  readonly id: CheckId;
  readonly message: string;
  readonly nodes: ReadonlyArray<readonly [tag: string, selectorPath: string]>;
}

export interface CheckWarning {
  readonly id: CheckWarningId;
  readonly message: string;
}

export interface Gate {
  readonly verdict: GateVerdict;
  readonly fails: ReadonlyArray<CheckFailure>;
  readonly warns: ReadonlyArray<CheckWarning>;
  readonly notes: ReadonlyArray<string>;
}

export interface Aesthetic {
  readonly score: number | null;
  readonly verdict: 'warn' | 'n/a';
  readonly histogram: ReadonlyArray<number> | null;
}

export interface Evidence {
  readonly locale: 'en' | 'es';
  readonly viewport: ViewportSize;
  readonly screenshotSha256: string;
}

export interface TastecheckResult {
  readonly gate: Gate;
  readonly aesthetic: Aesthetic;
  readonly evidence: Evidence;
}

export type GateVerdict = 'CLEAN' | 'REVIEW WARNS' | 'FAIL';

export type CheckId =
  | 'document.lang'
  | 'headings.single-h1'
  | 'landmarks.required'
  | 'forms.labeled-controls'
  | 'images.alt-policy'
  | 'interactive.focus-style-hooks'
  | 'tabindex.no-positive'
  | 'live.status'
  | 'destructive.confirmation-marker'
  | 'targets.min-size-hooks';

export type CheckWarningId = 'aesthetic.nima';

/** Stable, immutable tuple of the ten blocking check ids in evaluator order. */
export const BLOCKING_CHECK_IDS: ReadonlyArray<CheckId> = [
  'document.lang',
  'headings.single-h1',
  'landmarks.required',
  'forms.labeled-controls',
  'images.alt-policy',
  'interactive.focus-style-hooks',
  'tabindex.no-positive',
  'live.status',
  'destructive.confirmation-marker',
  'targets.min-size-hooks',
] as const;

// ---------------------------------------------------------------------------
// Pure helpers — no side effects, no globals, no I/O
// ---------------------------------------------------------------------------

/** Locale whitelist used by the document.lang check. */
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(['en', 'es']);

/** Interactive HTML form controls that must carry a label. */
const FORM_CONTROL_TAGS: ReadonlySet<string> = new Set([
  'INPUT',
  'TEXTAREA',
  'SELECT',
]);


/** HTML tags that imply landmark semantics even without ARIA. */
const LANDMARK_HTML_TAGS: ReadonlySet<string> = new Set([
  'HEADER',
  'MAIN',
  'NAV',
  'ASIDE',
  'FOOTER',
]);

/** ARIA role values that constitute landmark semantics. */
const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  'banner',
  'main',
  'navigation',
  'contentinfo',
  'complementary',
  'search',
]);

/** Locales that document trees can carry at sub-tree level. */
function isSupportedLocale(value: string): boolean {
  return SUPPORTED_LOCALES.has(value.toLowerCase().split(/[-_]/)[0] ?? '');
}

/**
 * Compute a stable selector path for diagnostic reporting. The path is
 * tag-only to keep outputs deterministic across re-parses (no ids that
 * the author might rename). Position counter differentiates siblings.
 */
function selectorPath(node: Element, root: Element): string {
  const segments: string[] = [];
  let current: Element | null = node;
  while (current !== null && current !== root.parentElement && current !== root) {
    const parent: Element | null = current.parentElement;
    if (parent === null) {
      segments.push(current.tagName.toLowerCase());
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (sibling) => sibling.tagName === current!.tagName,
    );
    const index = siblings.indexOf(current) + 1;
    segments.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
    current = parent;
  }
  if (segments.length === 0) segments.push(node.tagName.toLowerCase());
  return segments.join('>');
}

/** Concatenate author <style> blocks into a single string for CSS hooks. */
function collectStylesheetText(document: Document): string {
  const collected: string[] = [];
  const styles = document.getElementsByTagName('style');
  for (let i = 0; i < styles.length; i += 1) {
    const node = styles.item(i);
    if (node !== null) collected.push(node.textContent ?? '');
  }
  return collected.join('\n');
}

/**
 * Decide whether the author stylesheet declares a focus-visible/focus
 * hook that styles interactive elements when focused.
 */
function stylesheetDeclaresFocusHook(cssText: string): boolean {
  if (cssText.length === 0) return false;
  // Match `:focus`, `:focus-visible`, or `:focus-within` inside a rule
  // (selector + `{...}`). Anchoring on `\s*{` keeps the pseudo-class
  // tied to actual rule scope rather than free text inside a value.
  return /:focus(?:-visible|-within)?\s*\{/.test(cssText);
}

/**
 * Decide whether the author stylesheet declares a minimum-target size
 * rule on interactive elements (min-width / min-height >= 24px).
 */
function stylesheetDeclaresMinTarget(cssText: string): boolean {
  if (cssText.length === 0) return false;
  const interactiveRule =
    /(?:\b(?:a|button|input|select|textarea|summary)|\[role=["']?button["']?\])[^{]*\{[^}]*min-(?:width|height)\s*:\s*(?:24|2[5-9]|[3-9]\d|\d{3,})\s*px/i;
  if (interactiveRule.test(cssText)) return true;

  const tokenUse =
    /(?:\b(?:a|button|input|select|textarea|summary)|\[role=["']?button["']?\])[^{]*\{[^}]*min-(?:width|height)\s*:\s*var\(\s*(--[A-Za-z0-9_-]+)\s*\)/i.exec(cssText);
  if (tokenUse?.[1] === undefined) return false;

  const tokenDefinition = new RegExp(`${tokenUse[1]}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*px`, 'i').exec(cssText);
  return tokenDefinition?.[1] !== undefined && Number.parseFloat(tokenDefinition[1]) >= 24;
}

/**
 * Returns the effective `[lang]` attribute of `node`, walking ancestors.
 * Falls back to `null` when no ancestor carries one.
 */
function effectiveLang(node: Element, rootLang: string): string {
  let current: Element | null = node;
  while (current !== null) {
    const value = current.getAttribute('lang');
    if (value !== null && value.length > 0) return value;
    current = current.parentElement;
  }
  return rootLang;
}

/** True when `node` is a form control that participates in labelling. */
function isFormControl(node: Element): boolean {
  if (!FORM_CONTROL_TAGS.has(node.tagName)) return false;
  if (node.tagName === 'INPUT') {
    const type = (node.getAttribute('type') ?? 'text').toLowerCase();
    // Buttons and submit-style inputs are not in scope of label
    // requirement; input type=hidden is invisible to AT.
    return type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'reset' && type !== 'image';
  }
  return true;
}

/** True when `node` is labelled (label/aria-labelledby/aria-label/title). */
function isLabelled(node: Element): boolean {
  if (node.hasAttribute('aria-label') && node.getAttribute('aria-label')!.length > 0) return true;
  if (node.hasAttribute('aria-labelledby') && node.getAttribute('aria-labelledby')!.length > 0) return true;
  if (node.hasAttribute('title') && node.getAttribute('title')!.length > 0) return true;
  if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') {
    const id = node.getAttribute('id');
    if (id !== null && id.length > 0) {
      const ownerDocument = node.ownerDocument;
      if (ownerDocument !== null) {
        const labels = ownerDocument.querySelectorAll('label[for="' + cssEscape(id) + '"]');
        if (labels.length > 0) return true;
        const wrapping = ownerDocument.querySelectorAll('label');
        for (let i = 0; i < wrapping.length; i += 1) {
          const lbl = wrapping.item(i);
          if (lbl !== null && lbl.contains(node)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Minimal CSS attribute-selector escape. Only handles characters that
 * matter for a deterministic label-for query: quotes, backslashes.
 */
function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** True when `node` is a landmark by HTML semantics or ARIA role. */
function isLandmark(node: Element): boolean {
  if (LANDMARK_HTML_TAGS.has(node.tagName)) return true;
  const role = (node.getAttribute('role') ?? '').toLowerCase().trim();
  return LANDMARK_ROLES.has(role);
}

// ---------------------------------------------------------------------------
// Check implementations — return only what is wrong (empty = pass).
// Each builder populates `fails` directly. Order is fixed by CALL order.
// ---------------------------------------------------------------------------

interface CheckContext {
  readonly document: Document;
  readonly root: Element;
  readonly rootLang: string;
  readonly stylesheetText: string;
}

type CheckBuilder = (ctx: CheckContext) => ReadonlyArray<CheckFailure>;

function describeNode(node: Element, ctx: CheckContext): readonly [string, string] {
  return [node.tagName.toLowerCase(), selectorPath(node, ctx.root)];
}

const checkDocumentLang: CheckBuilder = (ctx) => {
  const lang = (ctx.root.getAttribute('lang') ?? '').toLowerCase().trim();
  const fails: CheckFailure[] = [];
  if (lang.length === 0) {
    fails.push({
      id: 'document.lang',
      message: 'document root has no lang attribute',
      nodes: [[ctx.root.tagName.toLowerCase(), 'html']],
    });
  } else if (!isSupportedLocale(lang)) {
    fails.push({
      id: 'document.lang',
      message: 'document root lang must be one of en or es, got "' + lang + '"',
      nodes: [[ctx.root.tagName.toLowerCase(), 'html']],
    });
  }
  return fails;
};

const checkSingleH1: CheckBuilder = (ctx) => {
  const root = ctx.document.body ?? ctx.root;
  const heads = root.querySelectorAll('h1');
  const fails: CheckFailure[] = [];
  if (heads.length === 0) {
    fails.push({
      id: 'headings.single-h1',
      message: 'document must contain exactly one h1',
      nodes: [],
    });
  } else if (heads.length > 1) {
    const nodes: Array<readonly [string, string]> = [];
    for (let i = 0; i < heads.length; i += 1) {
      const h = heads.item(i);
      if (h !== null) nodes.push(describeNode(h, ctx));
    }
    fails.push({
      id: 'headings.single-h1',
      message: 'document must contain exactly one h1, found ' + heads.length,
      nodes,
    });
  }
  return fails;
};

const checkLandmarks: CheckBuilder = (ctx) => {
  const root = ctx.document.body ?? ctx.root;
  const candidates = root.querySelectorAll(
    'main, header, footer, nav, aside, [role="banner"], [role="main"], [role="navigation"], [role="contentinfo"], [role="complementary"], [role="search"]',
  );
  const seen = new Set<string>();
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates.item(i);
    if (candidate === null) continue;
    if (!isLandmark(candidate)) continue;
    const roleOrTag = candidate.getAttribute('role') ?? candidate.tagName.toLowerCase();
    seen.add(roleOrTag.toLowerCase());
  }
  const fails: CheckFailure[] = [];
  if (!seen.has('main')) {
    fails.push({
      id: 'landmarks.required',
      message: 'document must declare a main landmark',
      nodes: [],
    });
  }
  if (!seen.has('header') && !seen.has('banner')) {
    fails.push({
      id: 'landmarks.required',
      message: 'document must declare a header/banner landmark',
      nodes: [],
    });
  }
  if (!seen.has('footer') && !seen.has('contentinfo')) {
    fails.push({
      id: 'landmarks.required',
      message: 'document must declare a footer/contentinfo landmark',
      nodes: [],
    });
  }
  return fails;
};

const checkLabeledControls: CheckBuilder = (ctx) => {
  const root = ctx.document.body ?? ctx.root;
  const candidates = root.querySelectorAll('input, textarea, select');
  const fails: CheckFailure[] = [];
  const nodes: Array<readonly [string, string]> = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const ctrl = candidates.item(i);
    if (ctrl === null || !isFormControl(ctrl)) continue;
    if (!isLabelled(ctrl)) nodes.push(describeNode(ctrl, ctx));
  }
  if (nodes.length > 0) {
    fails.push({
      id: 'forms.labeled-controls',
      message: 'every form control must be labelled',
      nodes,
    });
  }
  return fails;
};

const checkImageAltPolicy: CheckBuilder = (ctx) => {
  const root = ctx.document.body ?? ctx.root;
  const imgs = root.querySelectorAll('img');
  const fails: CheckFailure[] = [];
  const nodes: Array<readonly [string, string]> = [];
  let localizedWithoutPeer = 0;
  for (let i = 0; i < imgs.length; i += 1) {
    const img = imgs.item(i);
    if (img === null) continue;
    if (!img.hasAttribute('alt')) {
      nodes.push(describeNode(img, ctx));
      continue;
    }
    // A locale boundary below the document root requires an explicit
    // peer marker, even when it matches the active root locale.
    const lang = img.getAttribute('lang');
    const effective = effectiveLang(img, ctx.rootLang);
    let parent = img.parentElement;
    let hasLocaleBoundary = false;
    while (parent !== null && parent !== ctx.root) {
      if (parent.hasAttribute('lang')) hasLocaleBoundary = true;
      parent = parent.parentElement;
    }
    if (
      hasLocaleBoundary ||
      effective !== ctx.rootLang ||
      (lang !== null && lang.length > 0)
    ) {
      const peer = img.getAttribute('data-i18n-peer') ?? img.getAttribute('data-locale-peer');
      if (peer === null || peer.length === 0) {
        localizedWithoutPeer += 1;
        nodes.push(describeNode(img, ctx));
      }
    }
  }
  if (nodes.length > 0) {
    const reason = localizedWithoutPeer > 0
      ? 'each image must carry alt and images inside locale subtrees must declare an en/es peer marker'
      : 'every image must carry an alt attribute';
    fails.push({
      id: 'images.alt-policy',
      message: reason,
      nodes,
    });
  }
  return fails;
};

const checkFocusStyleHooks: CheckBuilder = (ctx) => {
  if (stylesheetDeclaresFocusHook(ctx.stylesheetText)) return [];
  return [
    {
      id: 'interactive.focus-style-hooks',
      message:
        'author stylesheet must declare a :focus-visible/:focus rule on interactive elements',
      nodes: [],
    },
  ];
};

const checkNoPositiveTabindex: CheckBuilder = (ctx) => {
  const root = ctx.document.body ?? ctx.root;
  const candidates = root.querySelectorAll('[tabindex]');
  const nodes: Array<readonly [string, string]> = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const el = candidates.item(i);
    if (el === null) continue;
    const raw = el.getAttribute('tabindex');
    if (raw === null) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) nodes.push(describeNode(el, ctx));
  }
  if (nodes.length === 0) return [];
  return [
    {
      id: 'tabindex.no-positive',
      message: 'positive tabindex disrupts natural reading order; use tabindex=0 only when necessary',
      nodes,
    },
  ];
};

const checkStatusLiveRegion: CheckBuilder = (ctx) => {
  const root = ctx.document.body ?? ctx.root;
  const status = root.querySelectorAll('[role="status"], [aria-live="polite"], [aria-live="assertive"]');
  if (status.length > 0) return [];
  return [
    {
      id: 'live.status',
      message: 'document must declare at least one status or aria-live region',
      nodes: [],
    },
  ];
};

const checkDestructiveConfirmation: CheckBuilder = (ctx) => {
  const root = ctx.document.body ?? ctx.root;
  const destructive = root.querySelectorAll(
    'button[data-destructive], button[data-destructiveness], [role="button"][data-destructive], [role="button"][data-destructiveness]',
  );
  const nodes: Array<readonly [string, string]> = [];
  for (let i = 0; i < destructive.length; i += 1) {
    const btn = destructive.item(i);
    if (btn === null) continue;
    const confirm = btn.getAttribute('data-confirm') ?? btn.getAttribute('data-confirms');
    if (confirm === null || confirm.length === 0) nodes.push(describeNode(btn, ctx));
  }
  if (nodes.length === 0) return [];
  return [
    {
      id: 'destructive.confirmation-marker',
      message:
        'every destructive action must declare a confirmation marker (data-confirm="<text-or-token>")',
      nodes,
    },
  ];
};

const checkMinTargetStyleHooks: CheckBuilder = (ctx) => {
  if (stylesheetDeclaresMinTarget(ctx.stylesheetText)) return [];
  return [
    {
      id: 'targets.min-size-hooks',
      message:
        'author stylesheet must declare a min-width/min-height >= 24px rule on interactive elements',
      nodes: [],
    },
  ];
};

// Stable order — tuple freeze so no caller can mutate.
const CHECK_BUILDERS: ReadonlyArray<CheckBuilder> = [
  checkDocumentLang,
  checkSingleH1,
  checkLandmarks,
  checkLabeledControls,
  checkImageAltPolicy,
  checkFocusStyleHooks,
  checkNoPositiveTabindex,
  checkStatusLiveRegion,
  checkDestructiveConfirmation,
  checkMinTargetStyleHooks,
] as const;

// ---------------------------------------------------------------------------
// Verdict derivation
// ---------------------------------------------------------------------------

function deriveVerdict(failsCount: number, warnsCount: number): GateVerdict {
  if (failsCount > 0) return 'FAIL';
  if (warnsCount > 0) return 'REVIEW WARNS';
  return 'CLEAN';
}

function deriveAesthetic(
  nima: NimaReceipt | NimaMissing | undefined,
): Aesthetic {
  if (nima === undefined || !nima.present) {
    return { score: null, verdict: 'n/a', histogram: null };
  }
  // NIMA receipt never escalates to FAIL — gate verdict is computed
  // independently. Histogram and score are surfaced verbatim.
  return { score: nima.score, verdict: 'warn', histogram: nima.histogram };
}

function deriveNimaWarning(
  nima: NimaReceipt | NimaMissing | undefined,
): CheckWarning[] {
  if (nima === undefined || !nima.present) return [];
  return [
    {
      id: 'aesthetic.nima',
      message:
        'aesthetic score ' +
        nima.score.toFixed(2) +
        ' is WARN-only pending calibration; not eligible to gate publish',
    },
  ];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate a draft against the Tastecheck gate.
 *
 * Determinism: the returned object is a fresh deep-freeze of ordered
 * arrays; structural equality holds across calls with byte-identical
 * inputs (including NIMA receipt).
 */
export function evaluate(input: TastecheckInput): TastecheckResult {
  const { locale, viewport, screenshotSha256, document, nima } = input;
  const root = document.documentElement;
  const rootLang = (root.getAttribute('lang') ?? locale).toLowerCase();
  const stylesheetText = collectStylesheetText(document);
  const ctx: CheckContext = { document, root, rootLang, stylesheetText };

  const fails: CheckFailure[] = [];
  for (const check of CHECK_BUILDERS) {
    const produced = check(ctx);
    if (produced.length > 0) fails.push(...produced);
  }
  const warns = deriveNimaWarning(nima);
  const aesthetic = deriveAesthetic(nima);
  const verdict = deriveVerdict(fails.length, warns.length);

  const notes: string[] = [];
  if (rootLang !== locale) {
    notes.push(
      'document root lang (' +
        rootLang +
        ') differs from evaluator locale (' +
        locale +
        ')',
    );
  }

  const result: TastecheckResult = {
    gate: {
      verdict,
      fails: deepFreezeArray(fails),
      warns: deepFreezeArray(warns),
      notes: deepFreezeArray(notes),
    },
    aesthetic,
    evidence: {
      locale,
      viewport: { width: viewport.width, height: viewport.height },
      screenshotSha256,
    },
  };
  return result;
}

// Deep-freeze of arrays (the values they contain are plain objects —
// spread copies guard against caller mutation between the time the
// result is constructed and the time the caller observes it).
function deepFreezeArray<T>(input: ReadonlyArray<T>): ReadonlyArray<T> {
  return Object.freeze([...input]);
}
