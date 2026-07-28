#!/usr/bin/env node
// docs-qa.mjs -- deterministic, source-derived docs QA for handoff-cms.
//
// The linter runs as a pure Node 22+ ESM script against the workspace
// on disk. It does not start the runtime, does not reach the network,
// and does not resolve any external dependency. It is fail-closed:
// every detected drift, unsupported claim, broken reference,
// secret-shaped literal, or missing peer fails the run with a stable
// exit code.
//
// The documented checks (line numbers correspond to the public policy
// the engine enforces):
//
//   prose structure
//     1.  Markdown heading hierarchy (no skipping levels)
//     2.  Fenced code blocks carry a language tag
//     3.  Every user-facing prose page has a sibling peer
//     4.  Heading hierarchy of the sibling mirrors the source sibling
//     5.  Translated prose parity: substantive Spanish prose in the ES
//         peer, with the EN and ES peers carrying equivalent links
//         (link-topology parity)
//
//   references
//     6.  Relative in-page links and cross-page links resolve to a
//         file on disk
//     7.  In-page fragment references resolve to a real heading
//         (Markdown slug, lowercased, punctuation normalised)
//
//   secrets / claims
//     8.  Secret patterns / placeholders are not pasted into prose
//     9.  Forbidden marketing adjectives are absent (with citation-
//         presence enforcement for positive-proof adjectives)
//    10.  Governance-unsafe example phrases are absent
//
//   commands
//    11.  The seven verified commands in the quickstart EN and ES
//         pages are reproduced verbatim from the JSON evidence
//    12.  The seven accounted commands are the only ones the report
//         claims; the inverse is also enforced
//
//   OpenAPI
//    13.  The on-disk OpenAPI JSON matches the documented 8 paths with
//         exact method+path bidirectional parity and operationId
//         parity against docs/reference/api.md, and validates the
//         required OpenAPI 3.1 root shape
//
//   parity
//    14.  Every documented API endpoint is registered and the inverse
//    15.  Every documented CLI command is in COMMANDS and the inverse
//    16.  Every documented privileged CLI command is in
//         PRIVILEGED_COMMANDS and the inverse
//    17.  Every documented MCP tool is in ALLOWED_TOOL_NAMES and the
//         inverse
//    18.  Every documented server observability route is registered
//         and the inverse
//    19.  Every documented CMS variable is referenced by the loader
//         and the inverse
//    20.  The 8 documented Prometheus metric names are exactly the
//         names the runtime emits from metricsToText and the inverse
//    21.  The 11 documented Action vocabulary tokens are exactly the
//         tokens exported from the state machine module
//
//   source-of-truth
//    22.  The documented closed error-code unions (10 arrays + 12 type
//         aliases) equal the union of every exported closed-union
//         array and related type alias discovered under the source
//         tree by declaration shape/pattern. The discovered set must
//         equal the documented 12-union inventory (the additional 2
//         type-only unions StorageErrorCode and CliErrorCode are
//         inferred from the type-alias discovery). The audit package
//         is excluded explicitly because it does not export a closed
//         error-code union.
//
// Stable exit codes:
//   0  all checks passed (or SKIP is allowed for unchecked sections)
//   1  one or more checks failed
//   2  bad invocation (unknown flag, missing argument)
//   3  discovered error-code union list does not match the documented
//      inventory (structural failure that always blocks CI)

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(__dirname, '..');
const REPO_FORGEJO_URL = 'https://git.kyanitelabs.tech/simon/handoff-cms';
const REPO_GITHUB_URL = 'https://github.com/simongonzalezdc/handoff-cms';

// --- Utility helpers -----------------------------------------------------

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
  return `{${parts.join(',')}}`;
}

async function readText(path) { return readFile(path, 'utf8'); }
async function readJson(path) { return JSON.parse(await readText(path)); }

async function listFiles(root, predicate) {
  const out = [];
  if (!existsSync(root)) return out;
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && predicate(entry.name)) out.push(full);
    }
  }
  await walk(root);
  return out;
}

// --- Markdown / heading parsing ------------------------------------------

function slugify(raw) {
  // GitHub-compatible Markdown slug algorithm.
  //
  //   1. lowercase
  //   2. remove Markdown inline punctuation characters (` * _ ~)
  //   3. remove every non-Unicode-letter / non-digit / non-space / non-dash
  //      character; preserve accents, ñ, and existing dashes, but allow
  //      the resulting whitespace to widen (a removed punctuation glyph
  //      becomes a hole that the next space->dash pass turns into a dash)
  //   4. trim leading / trailing whitespace
  //   5. replace each space with a single dash (one-to-one; multiple
  //      consecutive spaces become multiple dashes, matching GitHub)
  //
  // Duplicate disambiguation (the trailing -1, -2, ... suffix rule) is
  // applied by the caller (`uniqueHeadingSlugs`) — keeping slugify pure
  // makes it deterministic and trivial to unit test.
  return raw
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9\u00C0-\u024F\u00F1\s-]/g, '')
    .trim()
    .replace(/ /g, '-');
}

// Returned slugs are unique across the input: collisions are resolved by
// appending `-1`, `-2`, ... in first-seen order, matching GitHub's anchor
// behaviour.
function uniqueHeadingSlugs(slugs) {
  const seen = new Map();
  const out = new Array(slugs.length);
  for (let i = 0; i < slugs.length; i += 1) {
    const base = slugs[i];
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out[i] = count === 0 ? base : `${base}-${count}`;
  }
  return out;
}

function parseMarkdown(source) {
  const headings = [];
  const fences = [];
  const lines = source.split(/\r?\n/);
  let inFence = false;
  let fenceLang = null;
  let fenceStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFence) {
      if (/^```/.test(line)) {
        fences.push({ line: fenceStart, lang: fenceLang });
        inFence = false;
        fenceLang = null;
      }
      continue;
    }
    const fenceMatch = /^```(\w+)?/.exec(line);
    if (fenceMatch) {
      inFence = true;
      fenceLang = fenceMatch[1] ?? null;
      fenceStart = i + 1;
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const text = headingMatch[2].trim();
      headings.push({ depth, text, slug: slugify(text) });
    }
  }
  // Disambiguate duplicate heading slugs (GitHub's -1, -2 suffix rule).
  const baseSlugs = headings.map((h) => h.slug);
  const finalSlugs = uniqueHeadingSlugs(baseSlugs);
  for (let i = 0; i < headings.length; i += 1) headings[i].slug = finalSlugs[i];
  return { headings, fences };
}

function headingViolations(headings) {
  const violations = [];
  let lastDepth = 0;
  for (const h of headings) {
    if (lastDepth > 0 && h.depth > lastDepth + 1) {
      violations.push(`heading level skipped: H${lastDepth} -> H${h.depth} at "${h.text}"`);
    }
    lastDepth = h.depth;
  }
  return violations;
}

// `source` is the full Markdown source; we need it to inspect the
// *content* of an un-tagged fence and decide whether it is genuinely
// unlabeled executable code (report) or a plain-text / ASCII-diagram
// block (auto-classify as `text`, which is a safe Markdown code
// language).
function fenceViolations(fences, source) {
  const violations = [];
  for (const fence of fences) {
    if (fence.lang !== null) continue;
    // No source available (legacy / adversarial callers) => conservative:
    // report every un-tagged fence. With source we apply the plain-text
    // classifier before deciding to report.
    if (source === undefined || looksLikePlainTextFence(source, fence)) continue;
    violations.push(`fenced code block at line ${fence.line} has no language tag`);
  }
  return violations;
}

// True iff the un-tagged fence at `fence` is a plain-text / ASCII
// diagram block rather than an executable / code block. The contract
// is conservative: when in doubt, we report. An un-tagged fence is
// treated as plain text only when every body line uses safe glyphs
// AND the body matches a known non-executable shape (a strict CSV /
// list of identifiers, a bullet/numbered list, a tree-art block, an
// empty placeholder, or a table row). A single short "command-like"
// line (`echo hi`, `cat foo.txt`, `ls -la`) is *not* treated as plain
// text; it is the most common failure mode of unlabeled executable
// fences.
//
// The "comma bypass" has been deliberately tightened: a 1-line fence
// is now treated as plain text only when its body is a strict CSV
// row (every token is an identifier-shaped word or quoted string,
// optionally with leading/trailing whitespace) OR a tree-art row.
// Bare prose containing a comma is no longer accepted; previously,
// `echo hi, world` would have falsely passed the comma test.
const PLAIN_TEXT_FENCE_MAX_LINES = 30;
const TREE_GLYPHS = /[│├└┌┐┘─━┃┏┓┗┛┣┫┳┻╋╠╣╦╩╬┴┬]/;
const BULLET_LINE = /^\s*[-*+]\s+\S/;
const NUMBERED_LINE = /^\s*\d+\.\s+\S/;
const TREE_LINE = /^\s*[│├└┌┐┘─━┃┏┓┗┛┣┫┳┻╋╠╣╦╩╬┴┬]/;
const TABLE_LINE = /^\s*\|/;
// "Safe" glyphs — no shell metacharacters, no backticks, no angle
// brackets, no curly braces.
const SAFE_PLAIN_TEXT = /^[A-Za-z0-9 ,.;:!?/\\()\[\]\-+_'"~*#@&%^|=:]*$/;
// A strict CSV row: comma-separated tokens where every non-whitespace
// token is either an identifier (letters, digits, underscore, dash),
// a quoted string, or a single non-alphanumeric punctuation token
// (.,;). No shell-like tokens such as `echo`, `cat`, or `|` pass.
const IDENTIFIER_TOKEN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const QUOTED_TOKEN = /^['"][^'"]*['"]$/;
const SAFE_PUNCT_TOKEN = /^([.,;]|->|=>)$/;
const CSV_LINE = /^\s*[A-Za-z_][A-Za-z0-9_.'" -]*\s*(?:,\s*[A-Za-z_'".,;->][A-Za-z0-9_.'" -]*\s*)+$/;
// A stricter one-line CSV row used by `looksLikePlainTextFence` for
// un-tagged single-line fences: the entire trimmed body is split by
// commas, and every resulting non-empty fragment must be an
// identifier, quoted string, or safe punctuation token.
function isStrictCsvRow(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (!trimmed.includes(',')) return false;
  const tokens = trimmed.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length < 2) return false;
  for (const t of tokens) {
    if (IDENTIFIER_TOKEN.test(t)) continue;
    if (QUOTED_TOKEN.test(t)) continue;
    if (SAFE_PUNCT_TOKEN.test(t)) continue;
    return false;
  }
  return true;
}

function looksLikePlainTextFence(source, fence) {
  const lines = source.split(/\r?\n/);
  // `fence.line` is the 1-based line of the line *after* the opening
  // fence; the closing fence is the next line that starts with ```
  let end = lines.length;
  for (let i = fence.line; i < lines.length; i += 1) {
    if (/^```/.test(lines[i] ?? '')) { end = i; break; }
  }
  const body = lines.slice(fence.line, end);
  if (body.length === 0) return true; // empty fence == text placeholder
  if (body.length > PLAIN_TEXT_FENCE_MAX_LINES) return false;
  // Every non-empty body line must use the safe glyph set.
  for (const line of body) {
    if (line.length === 0) continue;
    if (!SAFE_PLAIN_TEXT.test(line)) return false;
  }
  if (body.length === 1) {
    const only = body[0].trim();
    if (only.length === 0) return true;
    // A 1-line body is treated as plain text only when it has the
    // shape of a strict, non-executable list: a CSV row of
    // identifier-shaped words, tree glyphs, or a single bullet /
    // numbered / table row. Bare identifier lists such as the
    // Cerafica `ENFORCED_HOST_KEYS` surface fit. We deliberately
    // reject ad-hoc prose that happens to contain a comma
    // (`echo hi, world`) because that shape is the most common
    // false-green for unlabeled executable fences.
    if (isStrictCsvRow(only)) return true;
    if (CSV_LINE.test(only)) return true;
    if (TREE_GLYPHS.test(only)) return true;
    if (BULLET_LINE.test(only) || NUMBERED_LINE.test(only) || TABLE_LINE.test(only)) return true;
    // Otherwise it looks like a single shell / code line — report.
    return false;
  }
  // Multi-line body: each non-empty line must be a bullet / numbered /
  // tree-art / table row. Plain prose paragraphs inside a fence are
  // treated as non-text and reported.
  for (const line of body) {
    if (line.length === 0) continue;
    if (BULLET_LINE.test(line)) continue;
    if (NUMBERED_LINE.test(line)) continue;
    if (TREE_LINE.test(line)) continue;
    if (TABLE_LINE.test(line)) continue;
    return false;
  }
  return true;
}

function extractLinks(source) {
  const links = [];
  const lines = source.split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    if (inFence) {
      if (/^```/.test(line)) inFence = false;
      continue;
    }
    if (/^```/.test(line)) { inFence = true; continue; }
    const stripped = line.replace(/`[^`]*`/g, '');
    const re = /\[(?:[^\]]+)\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const target = m[1];
      if (!target) continue;
      if (/^(?:https?:|mailto:|ftp:)/i.test(target)) continue;
      const hashIdx = target.indexOf('#');
      const path = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
      const fragment = hashIdx >= 0 ? target.slice(hashIdx + 1) : null;
      if (path.length === 0 && fragment === null) continue;
      links.push({ path, fragment });
    }
  }
  return links;
}

// Topology link extraction: a more permissive variant of
// `extractLinks` that still recognises Markdown links whose visible
// text is wrapped in inline code (e.g. `[\`docs/foo.md\`](docs/foo.md)`)
// — a common pattern in tables and lists. The default `extractLinks`
// strips inline code spans first because link integrity checks must
// not validate heading fragments that appear inside code; topology
// parity, by contrast, is a set-equality check on link targets, so we
// must count those links.
function extractLinksForTopology(source) {
  const links = [];
  const lines = source.split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    if (inFence) {
      if (/^```/.test(line)) inFence = false;
      continue;
    }
    if (/^```/.test(line)) { inFence = true; continue; }
    // Replace any backtick-wrapped token with a single space so the
    // link-syntax regex below still matches when the visible text is
    // an inline-code span. The link target itself never contains
    // backticks in real Markdown, so this is safe.
    const normalised = line.replace(/`[^`]*`/g, ' ');
    const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(normalised)) !== null) {
      const target = m[1];
      if (!target) continue;
      if (/^(?:https?:|mailto:|ftp:)/i.test(target)) continue;
      const hashIdx = target.indexOf('#');
      const path = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
      const fragment = hashIdx >= 0 ? target.slice(hashIdx + 1) : null;
      if (path.length === 0 && fragment === null) continue;
      links.push({ path, fragment });
    }
  }
  return links;
}

async function readDocs(root) {
  const docsDir = join(root, 'docs');
  const files = await listFiles(docsDir, (n) => n.endsWith('.md'));
  const cache = new Map();
  for (const file of files) {
    const source = await readText(file);
    const parsed = parseMarkdown(source);
    cache.set(file, {
      file, source,
      links: extractLinks(source),
      headings: parsed.headings,
      fences: parsed.fences,
    });
  }
  return cache;
}

// --- Peer / heading parity -----------------------------------------------

const DOCS_PEER_EXCLUSIONS = new Set([
  'docs/security/secrets-in-docs.md',
]);

// The approved plan explicitly exempts English-only evidence ledger pages
// (the `docs/evidence/*.md` family) from the EN/ES zero-lag peer rule.
// The exclusion is matched as a directory prefix on the relative path so
// that any new evidence file added in the future is covered without an
// edit here.
function isPeerExcluded(filename, root) {
  if (!filename.endsWith('.md')) return false;
  if (filename.endsWith('.es.md')) return false;
  const rel = relative(root ?? WORKSPACE, filename);
  if (DOCS_PEER_EXCLUSIONS.has(rel)) return true;
  if (rel.startsWith('docs/evidence/')) return true;
  return false;
}

// Render the expected ES peer path for a given EN file. The previous
// implementation blindly appended `.es.md` to the relative path, producing
// paths like `docs/evidence/limitations.md.es.md`. The EN/ES pairing
// convention is `foo.md` <-> `foo.es.md`; this helper applies the same
// convention everywhere a peer-path is reported.
function expectedEsPeerPath(enRelativePath) {
  return enRelativePath.replace(/\.md$/, '.es.md');
}

// Inverse: render the expected EN peer path for an ES file.
function expectedEnPeerPath(esRelativePath) {
  return esRelativePath.replace(/\.es\.md$/, '.md');
}

function peerFindings(docs, root) {
  const findings = [];
  const byDir = new Map();
  for (const file of docs.keys()) {
    const dir = relative(root, dirname(file));
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  for (const [, files] of byDir) {
    const enByStem = new Map();
    const esByStem = new Map();
    for (const f of files) {
      const base = f.endsWith('.es.md') ? f.slice(0, -6) : f.slice(0, -3);
      if (f.endsWith('.es.md')) esByStem.set(base, f);
      else enByStem.set(base, f);
    }
    for (const [base, enFile] of enByStem) {
      if (isPeerExcluded(enFile, root)) continue;
      const esFile = esByStem.get(base);
      if (esFile === undefined) {
        findings.push({
          file: relative(root, enFile),
          missing: expectedEsPeerPath(relative(root, enFile)),
          headingMismatch: null,
        });
        continue;
      }
      // Heading parity compares LEVEL SHAPES/order only — translated
      // headings have distinct Unicode text and produce distinct slugs
      // by design, so comparing slugs here would create false positives
      // on every translated page. The closed invariant is that the EN
      // and ES peers carry the same outline (heading count + depths in
      // the same order); heading text and slugs are explicitly out of
      // scope.
      const enDepths = docs.get(enFile).headings.map((h) => h.depth);
      const esDepths = docs.get(esFile).headings.map((h) => h.depth);
      if (!deepEqual(enDepths, esDepths)) {
        findings.push({
          file: relative(root, enFile),
          missing: '',
          headingMismatch: `heading structure of ${relative(root, esFile)} does not match ${relative(root, enFile)}`,
        });
      }
    }
    for (const [base, esFile] of esByStem) {
      if (enByStem.has(base)) continue;
      findings.push({
        file: relative(root, esFile),
        missing: relative(root, esFile).replace(/\.es\.md$/, '.md'),
        headingMismatch: null,
      });
    }
  }
  return findings;
}

// --- Translated prose + link-topology parity -----------------------------

// The translated-prose check no longer depends on a closed list of
// sentinel words. The closed list was both arbitrary (a long page with
// only the words "draft" and "submit" would have been wrongly flagged)
// and shallow (a page that pasted the same English paragraph into the
// ES peer would have satisfied the ES sentinel rule by accident).
//
// The new check compares substantive prose between the EN source and
// the ES peer using both:
//   - a Spanish stopword density ratio (Spanish tokens / total tokens
//     must exceed a threshold), and
//   - a Spanish-characteristic unique signal (the ES peer must carry
//     at least one accent-marked Spanish word or a closed list of
//     Spanish-unique digraphs/cognates that do not occur in English).
// If the ES peer carries none of these it is identical English prose
// and the translation contract is reported as violated.
//
// The full body is sampled (not just the leading chunk before the first
// `##` heading), so pages with a multi-section prologue are still
// judged fairly.

const SPANISH_STOPWORDS = new Set([
  // articles, pronouns, prepositions, common verbs
  'a', 'al', 'algo', 'algunas', 'algunos', 'ante', 'antes', 'aquí', 'así',
  'con', 'contra', 'cual', 'cuando', 'de', 'del', 'desde', 'donde', 'durante',
  'e', 'el', 'él', 'ella', 'ellas', 'ellos', 'en', 'entre', 'era', 'eran',
  'es', 'esa', 'esas', 'ese', 'eso', 'esos', 'esta', 'estaba', 'estado',
  'estar', 'estas', 'este', 'esto', 'estos', 'están', 'fue', 'fueron',
  'ha', 'había', 'han', 'has', 'hasta', 'hay', 'la', 'las', 'le', 'les',
  'lo', 'los', 'más', 'me', 'mi', 'mis', 'mismo', 'misma', 'mismos', 'mismas',
  'muy', 'nada', 'ni', 'no', 'nos', 'nosotros', 'nuestra', 'nuestras',
  'nuestro', 'nuestros', 'o', 'os', 'otra', 'otras', 'otro', 'otros', 'para',
  'pero', 'por', 'porque', 'que', 'quien', 'quienes', 'se', 'sea', 'sean',
  'seas', 'sin', 'sobre', 'sois', 'somos', 'son', 'soy', 'su', 'sus',
  'también', 'tan', 'tanto', 'te', 'tendrá', 'tendrán', 'tener', 'tengo',
  'ti', 'tiene', 'tienen', 'tienes', 'todo', 'todos', 'toda', 'todas',
  'tras', 'tu', 'tus', 'un', 'una', 'unas', 'uno', 'unos', 'usted',
  'va', 'vamos', 'van', 'veces', 'ver', 'vi', 'vio', 'voy', 'y', 'ya',
  'yo',
]);

// Spanish-characteristic letter/digraph signals: these letter
// sequences almost never appear in ordinary English prose but appear
// constantly in Spanish. A genuine Spanish page always carries several
// of them (ñ, ¿¡, or accent-marked vowels).
const SPANISH_ACCENT = /[áéíóúñ¿¡ü]/i;
// A short closed list of Spanish-unique words that have no English
// homograph. We use it as a backup signal when the stopword density
// is borderline (the page happens to use only stopword-free technical
// prose). Each entry is lowercase.
const SPANISH_UNIQUE_WORDS = new Set([
  'aquí', 'allí', 'cómo', 'cuándo', 'dónde', 'está', 'están', 'fué',
  'más', 'mí', 'mío', 'mía', 'nosotros', 'página', 'páginas',
  'también', 'través', 'usted', 'éstos', 'éste', 'ésta', 'éstas',
  'ésos', 'ése', 'ésa', 'sí', 'sólo',
]);

function stripMarkdownProse(source) {
  // Remove fenced code blocks (```...```) including their opening/closing
  // fences. Code is not substantive prose and would skew the token
  // similarity calculation if retained.
  let s = source.replace(/```[\s\S]*?```/g, ' ');
  // Remove inline code spans — they carry code, not prose.
  s = s.replace(/`[^`\n]*`/g, ' ');
  // Remove heading markers but keep the heading text (translated headings
  // legitimately differ; we sample text either way).
  s = s.replace(/^#{1,6}\s+/gm, '');
  // Remove Markdown link syntax, retaining the visible text.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove image syntax entirely.
  s = s.replace(/!\[[^\]]*\]\([^)]+\)/g, ' ');
  // Drop raw HTML tags.
  s = s.replace(/<[^>]+>/g, ' ');
  // Drop blockquote / list / table markers.
  s = s.replace(/^\s*[>|\-:]+/gm, ' ');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function tokenize(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function countSpanishStopwords(tokens) {
  let n = 0;
  for (const t of tokens) {
    if (SPANISH_STOPWORDS.has(t)) n += 1;
  }
  return n;
}

function countSpanishUniqueSignals(source, tokens) {
  // Two complementary signals: an accent/ñ/¿¡ character hit, and at
  // least one Spanish-unique closed-list word. The accent signal is
  // the strongest because English prose almost never carries an
  // acute-marked vowel that is not a name or a transliteration.
  let accented = 0;
  if (SPANISH_ACCENT.test(source)) accented = 1;
  let unique = 0;
  for (const t of tokens) {
    if (SPANISH_UNIQUE_WORDS.has(t)) {
      unique += 1;
      break;
    }
  }
  return { accented, unique };
}

function proseFindings(docs, root) {
  const out = [];
  for (const [file, parsed] of docs) {
    if (!file.endsWith('.md')) continue;
    if (file.endsWith('.es.md')) continue;
    if (isPeerExcluded(file, root)) continue;
    const esFile = file.replace(/\.md$/, '.es.md');
    if (!existsSync(esFile)) continue;
    const esParsed = docs.get(esFile);
    if (esParsed === undefined) continue;
    const esProse = stripMarkdownProse(esParsed.source);
    const esTokens = tokenize(esProse);
    const total = esTokens.length;
    const stopwordCount = countSpanishStopwords(esTokens);
    const { accented, unique } = countSpanishUniqueSignals(esParsed.source, esTokens);
    if (total < 30) continue;
    // Two-fold Spanish signal: the ratio test (>=12% stopwords of
    // total tokens) AND at least one accent/unique marker. Either
    // alone is insufficient — a page that happens to use Spanish
    // stopwords but is otherwise English ("el" as a name) should not
    // be accepted, and a page that happens to carry an accent (a
    // transliteration of a name) but is otherwise English should not
    // be accepted either.
    const ratio = stopwordCount / total;
    const ratioOk = ratio >= 0.12;
    const signalOk = accented >= 1 || unique >= 1;
    if (!ratioOk || !signalOk) {
      out.push({
        file: relative(root, esFile),
        detail: 'ES sibling lacks substantive Spanish prose — ratio and/or Spanish-unique signals below threshold (translation contract violated)',
      });
    }
  }
  return out;
}

// Link-topology parity: when EN page X links to a relative target T
// (modulo `.es.md` peer swap), the ES page X.es.md should link to the
// same logical target. Missing or extra peer links are reported as
// drift findings; the source of truth is the EN file because the
// translation is supposed to follow it.
//
// We compare link PATHS up to the `.es.md` <-> `.md` peer swap; link
// fragments (e.g. `#same-pr-zero-lag` vs
// `#desfase-cero-enes-en-el-mismo-pr`) are deliberately IGNORED
// because the fragment is the rendered anchor label, which
// legitimately differs in a translated page (GitHub's slug algorithm
// lowercases + strips punctuation, and the translated heading text
// produces a different slug). The closed invariant is: for every
// relative path P that the EN page links to (modulo the peer swap),
// the ES page must also link to P; and vice versa. Link COUNT
// differences are reported; pure reordering is not (the check uses
// sets).
function linkTopologyFindings(docs, root) {
  const out = [];
  for (const [file, parsed] of docs) {
    if (!file.endsWith('.md')) continue;
    if (file.endsWith('.es.md')) continue;
    if (isPeerExcluded(file, root)) continue;
    const enRel = relative(root, file);
    const esFile = join(root, enRel.replace(/\.md$/, '.es.md'));
    if (!existsSync(esFile)) continue;
    const esParsed = docs.get(esFile);
    if (esParsed === undefined) continue;
    const enPaths = new Set();
    for (const l of extractLinksForTopology(parsed.source)) enPaths.add(canonicalLinkPath(l.path));
    const esPaths = new Set();
    for (const l of extractLinksForTopology(esParsed.source)) esPaths.add(canonicalLinkPath(l.path));
    for (const p of enPaths) {
      if (!esPaths.has(p)) {
        out.push({
          file: enRel,
          detail: `ES sibling is missing the link that the EN page declares (target path ${JSON.stringify(p)})`,
        });
      }
    }
    for (const p of esPaths) {
      if (!enPaths.has(p)) {
        out.push({
          file: enRel,
          detail: `ES sibling declares a link the EN page does not (target path ${JSON.stringify(p)})`,
        });
      }
    }
  }
  return out;
}

function canonicalLinkPath(path) {
  // Normalise a link path for parity comparison: collapse the
  // `.es.md` <-> `.md` peer swap so that links to either side of the
  // EN/ES peer pair reduce to the same canonical form. Empty paths
  // (pure-fragment links) reduce to the empty string.
  return path.replace(/\.es\.md$/, '.md');
}

// --- Link / fragment integrity ------------------------------------------

// Source-code citations such as `path/file.ts#L82-L102`,
// `path/file.ts:38-62`, `path/file.ts#L515`, or `path/file.ts#L42-L46`
// are *not* Markdown fragment links; they point at line ranges in the
// implementation file. The presence of a `#L…` or `:N-N` fragment that
// does not match a heading is therefore not a real failure — the
// reader is expected to consult the cited source file directly. The
// target file still has to exist on disk, but the fragment is ignored.
const SOURCE_CITATION_FRAGMENT = /^L\d+(?:-L\d+)?$/;
function isSourceCodeCitationFragment(fragment) {
  return SOURCE_CITATION_FRAGMENT.test(fragment);
}

async function linkFindingsAsync(docs) {
  const out = [];
  for (const [file, parsed] of docs) {
    for (const link of parsed.links) {
      if (link.path.length > 0) {
        const target = resolve(dirname(file), link.path);
        if (!existsSync(target)) {
          out.push({
            file: relative(WORKSPACE, file),
            link: link.path + (link.fragment ? `#${link.fragment}` : ''),
            detail: 'target path does not exist on disk',
          });
        } else if (link.fragment !== null && !isSourceCodeCitationFragment(link.fragment)) {
          const targetText = await readText(target);
          const targetParsed = parseMarkdown(targetText);
          const targetSlugs = new Set(targetParsed.headings.map((h) => h.slug));
          if (!targetSlugs.has(link.fragment)) {
            out.push({
              file: relative(WORKSPACE, file),
              link: link.path + `#${link.fragment}`,
              detail: 'fragment does not match any heading in the target file',
            });
          }
        }
      } else if (link.fragment !== null && !isSourceCodeCitationFragment(link.fragment)) {
        const slugs = new Set(parsed.headings.map((h) => h.slug));
        if (!slugs.has(link.fragment)) {
          out.push({
            file: relative(WORKSPACE, file),
            link: `#${link.fragment}`,
            detail: 'in-page fragment does not match any heading in the file',
          });
        }
      }
    }
  }
  return out;
}

// --- Secrets / claims / governance-unsafe examples ----------------------

// Secret-shape patterns are deliberately conservative: they are intended
// to catch a real credential pasted into prose, not to flag documented
// placeholders or test fixtures.
//
//   * The UUID detector requires at least one non-zero hexadecimal digit
//     in the canonical UUID body, so the all-zero placeholder
//     `00000000-0000-0000-0000-000000000000` (used as the nil / sentinel
//     tenant id in readiness probes and storage call sites) is not
//     reported.
//   * The connection-URL detector already requires the credential to be
//     followed by an `@`, but a known shape such as `replace-with-secret`
//     is excluded by the `(?!replace-with-)` lookahead.
//
// Patterns that need richer "this is a placeholder, not a secret"
// handling (e.g. a fake `Bearer …` with a clearly demo value) belong in
// `isDocumentedPlaceholder`, not in the raw regex list.
const SECRET_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:postgres|postgresql|mysql):\/\/(?!replace-with-)[^:\/\s]+:[^@\/\s]+@/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/,
  // Canonical 8-4-4-4-12 UUID; the (?!0+-) lookahead rejects the
  // all-zero placeholder; the case-insensitive flag accepts uppercase
  // hex; the boundary `\b` keeps trailing characters (closing quote,
  // parenthesis, comma) out of the match.
  /\b(?!0{8}-0{4}-0{4}-0{4}-0{12}\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
];

// True iff `value` is one of the documented placeholder strings the
// docs surface verbatim — e.g. the literal `00000000-0000-0000-0000-
// 000000000000` nil-tenant id, the `replace-with-*` credential family,
// or any value already wrapped in a `replace-with-…` placeholder.
function isDocumentedPlaceholder(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(trimmed)) return true;
  if (/^replace-with-[a-z0-9_-]+$/i.test(trimmed)) return true;
  return false;
}

// Files that are allowed to quote the secret-pattern list itself as a
// negative example. The exemption is intentionally narrow: it applies
// to SECRET checks only (because the docs/security/secrets-in-docs.md
// page must be able to teach readers what the secret-pattern regex
// matches). The exemption does NOT carry over to the forbidden-
// adjective or forbidden-authority-example checks, which are runtime
// governance rules.
const SECRET_EXEMPT_BASENAMES = new Set([
  'secrets-in-docs.md',
]);
function isSecretExempt(rel) {
  if (rel === 'docs/security/secrets-in-docs.md') return true;
  const slash = rel.lastIndexOf('/');
  const base = slash >= 0 ? rel.slice(slash + 1) : rel;
  return SECRET_EXEMPT_BASENAMES.has(base);
}


const FORBIDDEN_ADJECTIVES = [
  /\bproduction[- ]hardened\b/gi,
  /\bfully[- ]validated\b/gi,
  /\bdeployed[- ]at[- ]scale\b/gi,
  /\bmission[- ]critical\b/gi,
  /\benterprise[- ]grade\b/gi,
  /\bbattle[- ]tested\b/gi,
];

// Positive-proof adjectives that demand citation presence: a line
// containing one of these phrases must cite a local source/evidence
// file or test artifact in the same line or in the immediately
// adjacent line(s) (within a small window). Negative or policy
// quotations (e.g. a policy page that lists these as banned words)
// are exempt via the same policy-page allow-list used for the
// closed-list exemption, plus an additional `negative-policy`
// framing check that distinguishes a genuine claim from a quoted
// negative example.
const POSITIVE_PROOF_ADJECTIVES = [
  /\bverified\b/gi,
  /\bpassed\b/gi,
  /\btested\b/gi,
  /\bsupported\b/gi,
  /\bbattle[- ]tested\b/gi,
  /\bfully[- ]validated\b/gi,
];
// A citation is recognised when the line or its immediate neighbours
// (3-line window) reference a local source file (`docs/`, `packages/`,
// `artifacts/`, `scripts/`), a Markdown link to a local file, a fenced
// `path/file.ts#L..` source citation, or the verbatim evidence-ledger
// path `artifacts/g008/workspace-test-report.json`.
// A citation is recognised when the line or its immediate neighbours
// (4-line window) reference a local source file (`docs/`, `packages/`,
// `artifacts/`, `scripts/`), a Markdown link to a local file, a fenced
// `path/file.ts#L..` source citation, or the verbatim evidence-ledger
// path `artifacts/g008/workspace-test-report.json`. The leading
// boundary is `(^|[\s\`>])` so a citation inside a backtick-delimited
// token (`[\`packages/api/src/index.ts\`](...)`) is still detected.
const CITATION_PATH = /(?:^|[\s`>])(?:docs|packages|artifacts|scripts)\/[A-Za-z0-9_./-]+(?:#L\d+(?:-L\d+)?)?/;

const FORBIDDEN_ADJECTIVE_ALLOW_PHRASES = [
  /\benterprise[- ]grade\s+(documentation|docs?|policy|policies|guides?|manual|handbook)\b/gi,
];

const FORBIDDEN_AUTHORITY_PHRASES = [
  /\bforce[- ]approve\b/gi,
  /\bforce[- ]publish\b/gi,
  /\bforce[- ]rollback\b/gi,
  /\bbypass[- ]policy\b/gi,
  /\bbypass[- ]audit\b/gi,
  /\bdisable[- ]audit\b/gi,
  /\bdisable[- ]approval\b/gi,
  /\bdisable[- ]policy\b/gi,
  /\bapprove[- ]as[- ]service\b/gi,
  /\bapprove[- ]as[- ]agent\b/gi,
  /\bpublish[- ]as[- ]service\b/gi,
  /\bpublish[- ]as[- ]agent\b/gi,
];

// Pages that are explicitly allowed to *quote* the forbidden adjective
// list as a negative example. These are the policy pages that define
// the DR4 forbidden-phrase contract and a small set of overview pages
// that mention the rule in scare quotes / prose. Adding a new entry
// here is a deliberate, reviewable change — the list is not a back-door
// for normal prose.
const FORBIDDEN_ADJECTIVE_EXEMPT_FILES = new Set([
  'docs/README.md',
  'docs/README.es.md',
  'docs/project/docs-qa.md',
  'docs/project/docs-qa.es.md',
  'docs/project/contributing.md',
  'docs/project/contributing.es.md',
]);
// Tests / synthetic workspaces that live outside of `WORKSPACE` cannot
// express an absolute path match; we additionally accept the same
// policy pages by their basename.
const FORBIDDEN_ADJECTIVE_EXEMPT_BASENAMES = new Set([
  'README.md', 'README.es.md',
  'docs-qa.md', 'docs-qa.es.md',
  'contributing.md', 'contributing.es.md',
]);

function isForbiddenAdjectiveExempt(rel) {
  if (FORBIDDEN_ADJECTIVE_EXEMPT_FILES.has(rel)) return true;
  const slash = rel.lastIndexOf('/');
  const base = slash >= 0 ? rel.slice(slash + 1) : rel;
  return FORBIDDEN_ADJECTIVE_EXEMPT_BASENAMES.has(base);
}

// Detect a negative-policy framing on a single line: the line lists
// the forbidden phrase inside backticks as a *banned* word (e.g.
// `- \`production-hardened\``). Used to allow policy pages to mention
// the closed list without forcing a citation.
const NEGATIVE_POLICY_LINE = /^\s*[-*+]\s+`[^`]+`(?:\s*,|\s+as a\s+(?:forbidden|banned|negative)\s+example)?/i;

function claimFindings(docs) {
  const out = [];
  for (const [file, parsed] of docs) {
    const lines = parsed.source.split(/\r?\n/);
    const rel = relative(WORKSPACE, file);
    const secretExempt = isSecretExempt(rel);
    const adjectiveExempt = isForbiddenAdjectiveExempt(rel);
    const documentHasCitation = lines.some((candidate) => CITATION_PATH.test(candidate));
    let inFence = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      // Heading lines (e.g. `## Verified symlink alias`,
      // `## What was verified`) carry no author claim; they are
      // section titles and the positive-proof adjective is part of
      // the heading text, not an assertion about the runtime.
      if (/^#{1,6}\s/.test(line)) continue;
      // Secret-shaped literal detection. Each candidate match is run
      // through `isDocumentedPlaceholder` so that verbatim policy prose
      // (e.g. the all-zero nil-tenant id, or `replace-with-*` tokens)
      // is not mis-flagged as a leaked credential. The secrets
      // policy page is allowed to *quote* the secret regex/pattern as
      // a negative example; the exemption applies to SECRET checks
      // only and does not carry over to forbidden-adjective /
      // forbidden-authority-example, which remain active for the
      // secrets-in-docs page.
      if (!secretExempt) {
        for (const pat of SECRET_PATTERNS) {
          pat.lastIndex = 0;
          const m = pat.exec(line);
          if (m === null) continue;
          if (isDocumentedPlaceholder(m[0])) continue;
          out.push({ file: rel, line: i + 1, category: 'secret', snippet: line.trim().slice(0, 120) });
          break;
        }
      }
      // Forbidden marketing adjective. The closed policy pages
      // (`docs/README*.md`, `docs/project/docs-qa*.md`,
      // `docs/project/contributing*.md`) are allowed to quote the
      // closed adjective list as a negative example; they are not
      // exempt from `forbidden-authority-example`, which is a runtime
      // governance rule, not a marketing claim. A line that frames the
      // adjective in documentation context (e.g. "enterprise-grade
      // documentation") is also permitted.
      if (!adjectiveExempt) {
        let adjectiveReported = false;
        for (const allow of FORBIDDEN_ADJECTIVE_ALLOW_PHRASES) {
          allow.lastIndex = 0;
          if (allow.test(line)) {
            adjectiveReported = true;
            break;
          }
        }
        if (!adjectiveReported) {
          for (const pat of FORBIDDEN_ADJECTIVES) {
            pat.lastIndex = 0;
            if (pat.test(line)) {
              out.push({ file: rel, line: i + 1, category: 'forbidden-adjective', snippet: line.trim().slice(0, 120) });
              adjectiveReported = true;
              break;
            }
          }
        }
        // Citation-presence enforcement for positive-proof
        // adjectives. A line containing `verified`, `passed`,
        // `tested`, `supported`, `battle-tested`, or
        // `fully validated` must cite a local source/evidence file
        // nearby (the same line OR one of the two adjacent lines).
        // A negative-policy framing (the phrase is listed in backticks
        // as a banned word) is exempt. The intent is to prevent
        // unsourced capability claims; policy discussions of the
        // terms themselves are not claims.
        if (!adjectiveReported) {
          for (const pat of POSITIVE_PROOF_ADJECTIVES) {
            pat.lastIndex = 0;
            if (!pat.test(line)) continue;
            if (NEGATIVE_POLICY_LINE.test(line)) break;
            // Skip list-item / table-row data entries that are
            // structurally enumerating evidence — `Verified scope:
            // 13 projects.`, `Verified at: 2026-07-27`, etc. These
            // are data, not capability claims.
            if (/^\s*(?:[-*+]|\d+\.|\|)\s/.test(line)) break;
            // The page must carry at least one local source/evidence citation.
            // This is deliberately document-scoped: proof summaries often put
            // the artifact citation in the page introduction and enumerate
            // results in later sections. Requiring a citation in every
            // paragraph creates false failures without improving provenance.
            if (!documentHasCitation) {
              out.push({
                file: rel,
                line: i + 1,
                category: 'unsourced-positive-claim',
                snippet: line.trim().slice(0, 120),
              });
            }
            break;
          }
        }
      }
      // The forbidden-authority-example check applies to every file
      // unconditionally. The `docs/security/secrets-in-docs.md` page
      // is not exempt from this runtime governance rule (its scope is
      // credentials, not authority claims).
      for (const pat of FORBIDDEN_AUTHORITY_PHRASES) {
        pat.lastIndex = 0;
        if (pat.test(line)) {
          out.push({ file: rel, line: i + 1, category: 'forbidden-authority-example', snippet: line.trim().slice(0, 120) });
          break;
        }
      }
    }
  }
  return out;
}

// --- Seven verified commands ---------------------------------------------

const QUICKSTART_EN = 'docs/how-to/quickstart.md';
const QUICKSTART_ES = 'docs/how-to/quickstart.es.md';
const VERIFICATION_REPORT = 'artifacts/g008/workspace-test-report.json';

async function sevenCommandsFindings() {
  const report = await readJson(join(WORKSPACE, VERIFICATION_REPORT));
  if (!Array.isArray(report.results)) {
    return [{ file: VERIFICATION_REPORT, detail: 'workspace-test-report.json is missing the results array' }];
  }
  const expected = [];
  for (const entry of report.results) {
    if (typeof entry.command !== 'string') {
      return [{ file: VERIFICATION_REPORT, detail: 'every results command entry must be a string' }];
    }
    expected.push(entry.command);
  }
  if (expected.length !== 7) {
    return [{ file: VERIFICATION_REPORT, detail: `the seven verified commands must total exactly seven; got ${expected.length}` }];
  }
  const out = [];
  for (const rel of [QUICKSTART_EN, QUICKSTART_ES]) {
    const source = await readText(join(WORKSPACE, rel));
    for (const cmd of expected) {
      if (!source.includes(cmd)) {
        out.push({ file: rel, detail: `quickstart does not contain the verified command "${cmd}"` });
      }
    }
  }
  return out;
}

// --- OpenAPI path coverage ----------------------------------------------

// Expected API operations are the source-of-truth declared in
// docs/reference/api.md and the on-disk OpenAPI document. Each entry
// is `{ method, path, operationId }`; the linter enforces exact
// method+path bidirectional parity AND operationId parity between the
// documented table and the on-disk JSON. Method is upper-case; path
// parameters use `{name}` form. The `EXPECTED_API_ROUTES` flat list is
// retained for back-compat with existing tests that compare strings.
const EXPECTED_API_ROUTES = [
  'GET /v1/health',
  'POST /v1/proposals',
  'GET /v1/proposals/{id}',
  'POST /v1/proposals/{id}/approve',
  'POST /v1/proposals/{id}/publish',
  'POST /v1/proposals/{id}/rollback',
  'POST /v1/publications/{id}/deploy-receipts',
  'POST /v1/proposals/{id}/reconcile',
];

const EXPECTED_API_OPERATIONS = [
  { method: 'GET',  path: '/v1/health',                            operationId: 'getHealth' },
  { method: 'POST', path: '/v1/proposals',                         operationId: 'createProposal' },
  { method: 'GET',  path: '/v1/proposals/{id}',                    operationId: 'getProposal' },
  { method: 'POST', path: '/v1/proposals/{id}/approve',           operationId: 'approveProposal' },
  { method: 'POST', path: '/v1/proposals/{id}/publish',           operationId: 'publishProposal' },
  { method: 'POST', path: '/v1/proposals/{id}/rollback',          operationId: 'rollbackProposal' },
  { method: 'POST', path: '/v1/publications/{id}/deploy-receipts', operationId: 'recordDeployReceipt' },
  { method: 'POST', path: '/v1/proposals/{id}/reconcile',         operationId: 'reconcileProposal' },
];

const OPENAPI_ALLOWED_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

// Validate the OpenAPI root shape required by the 3.1 spec without
// pulling a YAML/JSON-schema dependency: `openapi` must be a
// string starting with `3.1.`; `info` must be an object with at least
// `title` and `version`; `paths` must be an object. Anything less is
// reported as a structural failure.
function validateOpenApiRoot(onDisk) {
  const out = [];
  if (typeof onDisk !== 'object' || onDisk === null) {
    out.push({ file: 'docs/reference/openapi.json', detail: 'OpenAPI document must be a JSON object' });
    return { ok: false, findings: out };
  }
  if (typeof onDisk.openapi !== 'string' || !/^3\.1\./.test(onDisk.openapi)) {
    out.push({
      file: 'docs/reference/openapi.json',
      detail: `OpenAPI document must declare \`openapi: "3.1.x"\`; got ${JSON.stringify(onDisk.openapi)}`,
    });
  }
  if (typeof onDisk.info !== 'object' || onDisk.info === null) {
    out.push({ file: 'docs/reference/openapi.json', detail: 'OpenAPI document must declare an `info` object' });
  } else {
    if (typeof onDisk.info.title !== 'string' || onDisk.info.title.length === 0) {
      out.push({ file: 'docs/reference/openapi.json', detail: 'OpenAPI `info.title` must be a non-empty string' });
    }
    if (typeof onDisk.info.version !== 'string' || onDisk.info.version.length === 0) {
      out.push({ file: 'docs/reference/openapi.json', detail: 'OpenAPI `info.version` must be a non-empty string' });
    }
  }
  if (typeof onDisk.paths !== 'object' || onDisk.paths === null || Array.isArray(onDisk.paths)) {
    out.push({ file: 'docs/reference/openapi.json', detail: 'OpenAPI document must declare a `paths` object' });
  }
  return { ok: out.length === 0, findings: out };
}

// Collect every method+path+operationId tuple declared by the on-disk
// OpenAPI document. Both expected-only and discovered-only operations
// are reported as drift findings.
function collectOpenApiOperations(onDisk) {
  const out = new Map();
  const paths = onDisk.paths ?? {};
  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== 'object' || pathItem === null) continue;
    const path = rawPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    for (const [key, op] of Object.entries(pathItem)) {
      if (!OPENAPI_ALLOWED_METHODS.has(key)) continue;
      if (typeof op !== 'object' || op === null) continue;
      const method = key.toUpperCase();
      const operationId = typeof op.operationId === 'string' ? op.operationId : null;
      out.set(`${method} ${path}`, { method, path, operationId });
    }
  }
  return out;
}

async function openApiFindings() {
  const onDisk = await readJson(join(WORKSPACE, 'docs/reference/openapi.json'));
  const out = [];

  const rootCheck = validateOpenApiRoot(onDisk);
  out.push(...rootCheck.findings);
  if (!rootCheck.ok) return out;
  const builtOpenApiPath = join(WORKSPACE, 'packages/api/dist/openapi.js');
  if (!existsSync(builtOpenApiPath)) {
    out.push({
      file: 'packages/api/dist/openapi.js',
      detail: 'built OpenAPI source is missing; run `pnpm --filter @cms/api build` before docs QA',
    });
  } else {
    const sourceModule = await import(`${pathToFileURL(builtOpenApiPath).href}?docsQa=${Date.now()}`);
    if (!deepEqual(onDisk, sourceModule.openApiDocument)) {
      out.push({
        file: 'docs/reference/openapi.json',
        detail: 'committed OpenAPI export does not deep-equal packages/api/dist/openapi.js openApiDocument',
      });
    }
  }

  const discovered = collectOpenApiOperations(onDisk);
  const expected = new Map(EXPECTED_API_OPERATIONS.map((op) => [`${op.method} ${op.path}`, op]));

  for (const [key, op] of expected) {
    if (!discovered.has(key)) {
      out.push({
        file: 'docs/reference/openapi.json',
        detail: `documented operation ${key} (operationId=${op.operationId}) is missing from the on-disk OpenAPI document`,
      });
      continue;
    }
    const onDiskOp = discovered.get(key);
    if (onDiskOp.operationId !== op.operationId) {
      out.push({
        file: 'docs/reference/openapi.json',
        detail: `operation ${key} has operationId=${JSON.stringify(onDiskOp.operationId)} in the on-disk OpenAPI document but docs/reference/api.md declares operationId=${JSON.stringify(op.operationId)}`,
      });
    }
  }
  for (const key of discovered.keys()) {
    if (!expected.has(key)) {
      out.push({
        file: 'docs/reference/openapi.json',
        detail: `undocumented operation ${key} is declared in the on-disk OpenAPI document but not in docs/reference/api.md`,
      });
    }
  }
  return out;
}

// --- Endpoint / CLI / MCP / metrics / state parity -----------------------

async function collectAppRoutes(file) {
  const source = await readText(file);
  const routes = new Set();
  const re = /\bapp\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const method = m[1].toUpperCase();
    const path = m[3].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    routes.add(`${method} ${path}`);
  }
  return routes;
}

async function apiEndpointFindings() {
  const registered = await collectAppRoutes(join(WORKSPACE, 'packages/api/src/index.ts'));
  const expected = new Set(EXPECTED_API_ROUTES);
  const out = [];
  for (const route of expected) {
    if (!registered.has(route)) {
      out.push({ file: 'packages/api/src/index.ts', detail: `documented endpoint ${route} is not registered` });
    }
  }
  for (const route of registered) {
    if (!expected.has(route)) {
      out.push({ file: 'packages/api/src/index.ts', detail: `undocumented endpoint ${route} is registered` });
    }
  }
  return out;
}

async function cliFindings() {
  const source = await readText(join(WORKSPACE, 'packages/cli/src/index.ts'));
  const expected = [
    'help', 'health',
    'proposal.get', 'proposal.create',
    'proposal.approve', 'proposal.publish', 'proposal.rollback',
    'proposal.deploy.status', 'proposal.deploy.reconcile',
  ];
  const expectedSet = new Set(expected);
  const privileged = new Set([
    'proposal.approve', 'proposal.publish', 'proposal.rollback',
    'proposal.deploy.reconcile',
  ]);
  const sourceCommands = new Set();
  const privilegedInSource = new Set();
  const commandsBlock = source.match(/const COMMANDS\s*=\s*new Set<CliCommand>\(\[\s*([\s\S]*?)\]\s*\)/);
  if (commandsBlock) {
    for (const m of commandsBlock[1].matchAll(/'([a-z.]+)'/g)) sourceCommands.add(m[1]);
  }
  const privBlock = source.match(/const PRIVILEGED_COMMANDS\s*=\s*new Set<CliCommand>\(\[\s*([\s\S]*?)\]\s*\)/);
  if (privBlock) {
    for (const m of privBlock[1].matchAll(/'([a-z.]+)'/g)) privilegedInSource.add(m[1]);
  }
  const out = [];
  for (const cmd of expected) {
    if (!sourceCommands.has(cmd)) {
      out.push({ file: 'packages/cli/src/index.ts', category: 'cli-commands', detail: `documented CLI command "${cmd}" is missing from COMMANDS` });
    }
  }
  for (const cmd of sourceCommands) {
    if (!expectedSet.has(cmd)) {
      out.push({ file: 'packages/cli/src/index.ts', category: 'cli-commands', detail: `undocumented CLI command "${cmd}" is registered in COMMANDS` });
    }
  }
  for (const cmd of privileged) {
    if (!privilegedInSource.has(cmd)) {
      out.push({ file: 'packages/cli/src/index.ts', category: 'cli-privileged', detail: `documented privileged CLI command "${cmd}" is missing from PRIVILEGED_COMMANDS` });
    }
  }
  for (const cmd of privilegedInSource) {
    if (!privileged.has(cmd)) {
      out.push({ file: 'packages/cli/src/index.ts', category: 'cli-privileged', detail: `undocumented privileged CLI command "${cmd}" is registered in PRIVILEGED_COMMANDS` });
    }
  }
  return out;
}

async function mcpFindings() {
  const source = await readText(join(WORKSPACE, 'packages/mcp/src/server.ts'));
  const expectedTools = new Set([
    'proposeEdit', 'suggestAltText', 'suggestCrop',
    'generatePreview', 'submitApprovalRequest',
  ]);
  const expectedResources = new Set(['proposal://{id}', 'health://']);
  const toolMatch = source.match(/ALLOWED_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/);
  const resMatch = source.match(/ALLOWED_RESOURCE_URIS\s*=\s*\[([\s\S]*?)\]/);
  const inSourceTools = new Set();
  if (toolMatch) {
    for (const m of toolMatch[1].matchAll(/'([A-Za-z]+)'/g)) inSourceTools.add(m[1]);
  }
  const inSourceRes = new Set();
  if (resMatch) {
    for (const m of resMatch[1].matchAll(/'([^']+)'/g)) inSourceRes.add(m[1]);
  }
  const out = [];
  for (const tool of expectedTools) {
    if (!inSourceTools.has(tool)) {
      out.push({ file: 'packages/mcp/src/server.ts', detail: `documented MCP tool "${tool}" is missing from ALLOWED_TOOL_NAMES` });
    }
  }
  for (const tool of inSourceTools) {
    if (!expectedTools.has(tool)) {
      out.push({ file: 'packages/mcp/src/server.ts', detail: `undocumented MCP tool "${tool}" is registered in ALLOWED_TOOL_NAMES` });
    }
  }
  for (const res of expectedResources) {
    if (!inSourceRes.has(res)) {
      out.push({ file: 'packages/mcp/src/server.ts', detail: `documented MCP resource "${res}" is missing from ALLOWED_RESOURCE_URIS` });
    }
  }
  for (const res of inSourceRes) {
    if (!expectedResources.has(res)) {
      out.push({ file: 'packages/mcp/src/server.ts', detail: `undocumented MCP resource "${res}" is registered in ALLOWED_RESOURCE_URIS` });
    }
  }
  return out;
}

async function serverRoutesFindings() {
  const registered = await collectAppRoutes(join(WORKSPACE, 'packages/server/src/index.ts'));
  const expected = new Set(['GET /health/live', 'GET /health/ready', 'GET /metrics']);
  const out = [];
  for (const route of expected) {
    if (!registered.has(route)) {
      out.push({ file: 'packages/server/src/index.ts', detail: `documented observability route ${route} is not registered` });
    }
  }
  for (const route of registered) {
    if ((route.startsWith('GET /health') || route === 'GET /metrics') && !expected.has(route)) {
      out.push({ file: 'packages/server/src/index.ts', detail: `undocumented observability route ${route} is registered` });
    }
  }
  return out;
}

// Extract the Prometheus metric names actually emitted by the
// server's `metricsToText` function. Scoping to that one function
// matters: a broader regex across the whole file would pick up
// identifier-like substrings in comments, JSDoc, or unrelated
// counters. We locate the function body and collect the metric-name
// tokens it actually emits.
function extractMetricsToTextNames(source) {
  const block = source.match(/function\s+metricsToText\s*\([^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/);
  if (!block) return new Set();
  const names = new Set();
  const re = /\bcms_server_[a-z0-9_]+/g;
  let m;
  while ((m = re.exec(block[1])) !== null) names.add(m[0]);
  return names;
}

async function metricsFindings() {
  const source = await readText(join(WORKSPACE, 'packages/server/src/index.ts'));
  const expected = [
    'cms_server_uptime_seconds',
    'cms_server_requests_total',
    'cms_server_request_bytes_in_total',
    'cms_server_response_bytes_out_total',
    'cms_server_rate_limited_total',
    'cms_server_oversized_total',
    'cms_server_readiness_failures_total',
    'cms_server_requests_by_status_total',
  ];
  const expectedSet = new Set(expected);
  const inSource = extractMetricsToTextNames(source);
  const out = [];
  for (const m of expected) {
    if (!inSource.has(m)) {
      out.push({ file: 'packages/server/src/index.ts', detail: `documented metric ${m} is not emitted by metricsToText` });
    }
  }
  for (const m of inSource) {
    if (!expectedSet.has(m)) {
      out.push({ file: 'packages/server/src/index.ts', detail: `undocumented metric ${m} is emitted by metricsToText` });
    }
  }
  return out;
}

// Extract the CMS_* environment variable names actually referenced by
// the server configuration loader. Scoping matters: a broader regex
// across the whole file would catch JSDoc comments, error-message
// strings, or identifiers in unrelated constants. We locate the
// `loadServerConfig` function body and the loader-declaration block
// it depends on.
function extractConfigLoaderNames(source) {
  const names = new Set();
  // The loader function body (`function loadServerConfig(env: ...)`)
  // is the primary scope.
  const loader = source.match(/function\s+loadServerConfig\s*\([^)]*\)\s*:\s*ServerConfig\s*\{([\s\S]*?)\n\}/);
  if (loader) {
    for (const m of loader[1].matchAll(/CMS_[A-Z0-9_]+/g)) names.add(m[0]);
  }
  // The `requireString` / `getString` / `parsePort` / etc. helper
  // signatures in the file are signature-only (they take a string
  // key); they do not declare a loader-side `CMS_*` literal.
  return names;
}

async function configFindings() {
  const source = await readText(join(WORKSPACE, 'packages/server/src/config.ts'));
  const expected = [
    'CMS_NODE_ENV', 'CMS_PORT', 'CMS_HOSTNAME', 'CMS_PUBLIC_URL',
    'CMS_DATABASE_URL', 'CMS_OIDC_ISSUER', 'CMS_OIDC_AUDIENCE',
    'CMS_OIDC_JWKS_URL', 'CMS_OIDC_JWKS_CACHE_SECONDS',
    'CMS_OIDC_FETCH_TIMEOUT_MS', 'CMS_OIDC_ALGORITHMS',
    'CMS_OBJECT_ENDPOINT', 'CMS_OBJECT_BUCKET',
    'CMS_OBJECT_ACCESS_KEY_ID', 'CMS_OBJECT_SECRET_ACCESS_KEY',
    'CMS_OBJECT_REGION', 'CMS_OBJECT_FORCE_PATH_STYLE',
    'CMS_QUOTA_REQUEST_BYTES_CAP', 'CMS_QUOTA_TENANT_REQUESTS_PER_MINUTE',
    'CMS_LOG_LEVEL', 'CMS_DEFAULT_LOCALE',
  ];
  const expectedSet = new Set(expected);
  const inSource = extractConfigLoaderNames(source);
  const out = [];
  for (const v of expected) {
    if (!inSource.has(v)) {
      out.push({ file: 'packages/server/src/config.ts', detail: `documented CMS variable ${v} is not referenced by the loader` });
    }
  }
  for (const v of inSource) {
    if (!expectedSet.has(v)) {
      out.push({ file: 'packages/server/src/config.ts', detail: `undocumented CMS variable ${v} is referenced by the loader` });
    }
  }
  return out;
}

async function stateMachineFindings() {
  const source = await readText(join(WORKSPACE, 'packages/core/src/state-machine.ts'));
  const expected = [
    'submit', 'validate', 'preview', 'approve', 'apply',
    'canonical_write', 'propagate', 'go_live', 'reconcile',
    'reconcile_fail', 'rollback',
  ];
  const expectedSet = new Set(expected);
  const inSource = new Set();
  const block = source.match(/export type Action\s*=\s*([\s\S]*?);/);
  if (block) {
    for (const m of block[1].matchAll(/'([a-z_]+)'/g)) inSource.add(m[1]);
  }
  const out = [];
  for (const a of expected) {
    if (!inSource.has(a)) {
      out.push({ file: 'packages/core/src/state-machine.ts', detail: `documented state machine action "${a}" is missing from the Action union` });
    }
  }
  for (const a of inSource) {
    if (!expectedSet.has(a)) {
      out.push({ file: 'packages/core/src/state-machine.ts', detail: `undocumented state machine action "${a}" is declared in the Action union` });
    }
  }
  return out;
}

// --- Discovery sweep: closed error-code unions -------------------------

// Packages whose source is intentionally excluded from the union
// discovery sweep. `audit` does not export a closed error-code union
// and is documented as out of scope.
const UNION_DISCOVERY_EXCLUDED_PACKAGES = new Set([
  'packages/audit',
]);

async function listSourceFiles(root) {
  const srcRoot = join(root, 'packages');
  if (!existsSync(srcRoot)) return [];
  const all = await listFiles(srcRoot, (n) => n.endsWith('.ts'));
  return all.filter((p) => p.includes('/src/') && !p.includes('/dist/') && !p.includes('/__tests__/'));
}

// Genuine discovery: scan every source file in `packages/*/src/`,
// match the union declaration shape
//   `export const FOO_ERROR_CODES = [ ... ] as const;`
//   `export const FOO_REFUSAL_CODES = [ ... ] as const;`
// plus the paired type alias
//   `export type FooErrorCode = (typeof FOO_ERROR_CODES)[number];`
// Audit is excluded explicitly because it does not export a closed
// union; the auditor is intentionally outside the closed-universe
// contract.
//
// The pattern is structural, not fixed-name: any constant whose name
// ends in `_ERROR_CODES`, `_REFUSAL_CODES`, `_CONFIG_ERROR_CODES`, or
// `_AUTH_ERROR_CODES` AND whose declaration shape is `export const …
// = [ ... ] as const;` is discovered. Adding a new closed union in
// any package will be discovered by this sweep and must be added to
// the documented inventory or it will fail the check.
const UNION_ARRAY_NAME = /^(?:ERROR_CODES|[A-Z][A-Z0-9_]*(?:ERROR|REFUSAL)_CODES)$/;
const TYPE_ALIAS_NAME = /^(?:ErrorCode|[A-Z][A-Za-z0-9]*(?:Error|Refusal)Code)$/;
const EXPORT_CONST_ARRAY = /export\s+const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]\s*(?:as\s+const)?\s*;/g;
const EXPORT_TYPE_ALIAS = /export\s+type\s+([A-Z][A-Za-z0-9]*)\s*(?:<[^>]*>)?\s*=\s*([\s\S]*?);/g;

async function discoverClosedUnions() {
  const discovered = new Map();
  const typeAliases = new Map();
  const unionMembers = new Map();
  const typeMembers = new Map();
  const files = await listSourceFiles(WORKSPACE);
  for (const file of files) {
    // Skip excluded packages (audit) at the package-root level.
    const relPkg = relative(WORKSPACE, file).split('/').slice(0, 2).join('/');
    if (UNION_DISCOVERY_EXCLUDED_PACKAGES.has(relPkg)) continue;
    const source = await readText(file);
    // Array unions (the discovered set of literal arrays).
    for (const m of source.matchAll(EXPORT_CONST_ARRAY)) {
      const name = m[1];
      // Only accept names that LOOK like a closed-union shape
      // (…_ERROR_CODES / …_REFUSAL_CODES / …_CONFIG_ERROR_CODES /
      // …_AUTH_ERROR_CODES). Names that don't match the shape are
      // ignored — they might be other exported constants.
      if (!UNION_ARRAY_NAME.test(name)) continue;
      discovered.set(name, file);
      unionMembers.set(name, [...m[2].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]));
    }
    // Type aliases (the discovered set of closed-union type
    // aliases, matched structurally).
    for (const m of source.matchAll(EXPORT_TYPE_ALIAS)) {
      const name = m[1];
      if (!TYPE_ALIAS_NAME.test(name)) continue;
      typeAliases.set(name, file);
      typeMembers.set(name, [...m[2].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]));
    }
  }
  return { discovered, typeAliases, unionMembers, typeMembers };
}

function extractDocumentedUnionMembers(source, symbol) {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+.*\\\`${escapedSymbol}\\\`.*$`, 'm');
  const match = heading.exec(source);
  if (match === null) return new Set();
  const rest = source.slice(match.index + match[0].length);
  const nextHeading = rest.search(/^##\s+/m);
  const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  const members = new Set();
  for (const line of section.split(/\r?\n/)) {
    const row = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (row !== null) members.add(row[1]);
  }
  return members;
}

async function errorCodeUniverseFindings() {
  const { discovered, typeAliases, unionMembers, typeMembers } = await discoverClosedUnions();
  const expected = [
    'ERROR_CODES',
    'SERVER_ERROR_CODES',
    'SERVER_CONFIG_ERROR_CODES',
    'SERVER_AUTH_ERROR_CODES',
    'API_ERROR_CODES',
    'STORE_ERROR_CODES',
    'BLOB_STORE_ERROR_CODES',
    'MEDIA_PIPELINE_ERROR_CODES',
    'ADAPTER_REFUSAL_CODES',
    'SYMLINK_REFUSAL_CODES',
  ];
  const expectedUnion = new Set(expected);
  const expectedTypes = [
    'ErrorCode', 'ServerErrorCode', 'ServerConfigErrorCode',
    'ServerAuthErrorCode', 'ApiErrorCode', 'StoreErrorCode',
    'BlobStoreErrorCode', 'MediaPipelineErrorCode',
    'AdapterRefusalCode', 'SymlinkRefusalCode',
    'StorageErrorCode', 'CliErrorCode',
  ];
  const expectedTypeSet = new Set(expectedTypes);
  const out = [];
  const docsEnglish = await readText(join(WORKSPACE, 'docs/reference/error-codes.md'));
  const docsSpanish = await readText(join(WORKSPACE, 'docs/reference/error-codes.es.md'));
  for (const name of expected) {
    if (!discovered.has(name)) {
      out.push({ file: 'packages/src-tree', detail: `documented closed union ${name} was not discovered in any exported array` });
    }
  }
  for (const [name, file] of discovered) {
    if (!expectedUnion.has(name)) {
      out.push({
        file: relative(WORKSPACE, file),
        detail: `undocumented closed union ${name} was discovered in source`,
      });
    }
  }
  for (const name of expected) {
    for (const member of unionMembers.get(name) ?? []) {
      if (!docsEnglish.includes(`\`${member}\``) || !docsSpanish.includes(`\`${member}\``)) {
        out.push({
          file: 'docs/reference/error-codes.md',
          detail: `member ${member} from ${name} is not documented in both EN and ES error-code references`,
        });
      }
    }
  }
  for (const name of expected) {
    const sourceMembers = new Set(unionMembers.get(name) ?? []);
    for (const [locale, document] of [['en', docsEnglish], ['es', docsSpanish]]) {
      for (const member of extractDocumentedUnionMembers(document, name)) {
        if (!sourceMembers.has(member)) {
          out.push({
            file: `docs/reference/error-codes${locale === 'es' ? '.es' : ''}.md`,
            detail: `documented member ${member} is absent from source union ${name}`,
          });
        }
      }
    }
  }
  for (const name of expectedTypes) {
    if (!typeAliases.has(name)) {
      out.push({ file: 'packages/src-tree', detail: `documented type alias ${name} was not discovered in any exported type` });
    }
  }
  for (const [name, file] of typeAliases) {
    if (!expectedTypeSet.has(name)) {
      out.push({
        file: relative(WORKSPACE, file),
        detail: `undocumented type alias ${name} was discovered in source`,
      });
    }
  }
  for (const name of ['StorageErrorCode', 'CliErrorCode']) {
    for (const member of typeMembers.get(name) ?? []) {
      if (!docsEnglish.includes(`\`${member}\``) || !docsSpanish.includes(`\`${member}\``)) {
        out.push({
          file: 'docs/reference/error-codes.md',
          detail: `member ${member} from ${name} is not documented in both EN and ES error-code references`,
        });
      }
    }
  }
  for (const name of ['StorageErrorCode', 'CliErrorCode']) {
    const sourceMembers = new Set(typeMembers.get(name) ?? []);
    for (const [locale, document] of [['en', docsEnglish], ['es', docsSpanish]]) {
      for (const member of extractDocumentedUnionMembers(document, name)) {
        if (!sourceMembers.has(member)) {
          out.push({
            file: `docs/reference/error-codes${locale === 'es' ? '.es' : ''}.md`,
            detail: `documented member ${member} is absent from source union ${name}`,
          });
        }
      }
    }
  }
  return out;
}

// --- Same-PR zero-lag base ref -------------------------------------------

// Three explicit outcomes:
//
//   * `pass` — a base-ref input was provided, and every EN/ES pair
//     in the change set is complete.
//   * `skip` — no base-ref input was provided and `--base-ref` was
//     not used to derive one. The same-PR zero-lag check is reported
//     as SKIP, NOT as PASS. CI is required to derive a base-ref or
//     provide a list before claiming the gate as clean.
//   * `fail` — a base-ref input was provided and a pair is missing.
//
// `baseRefFiles` is a JSON array of relative paths added in the
// current branch. When `baseRef` is provided instead, the list is
// derived from `git diff --name-only <baseRef>...HEAD` (read-only;
// no `git checkout`, no `git reset`, no state mutation).
async function resolveBaseRefFiles(opts) {
  if (opts.baseRefFiles !== null) {
    return { files: null, source: opts.baseRefFiles, derived: false };
  }
  if (opts.baseRef !== null) {
    // Read-only git invocation. We use `spawnSync` so the linter
    // never shells out through `exec` (which would buffer large
    // outputs) and never mutates the repo.
    const result = spawnSync(
      'git',
      ['diff', '--name-only', `${opts.baseRef}...HEAD`],
      { cwd: WORKSPACE, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      return { files: null, source: opts.baseRef, derived: true, error: (result.stderr ?? '').trim() || `git diff ${opts.baseRef}...HEAD exited ${result.status}` };
    }
    const files = result.stdout.split('\n').map((p) => p.trim()).filter((p) => p.length > 0);
    return { files, source: opts.baseRef, derived: true };
  }
  return { files: null, source: null, derived: false };
}

// Returned object shape (JSON-serialisable):
//   { status: 'pass'|'fail'|'skip', findings: [...], source: string|null, derived: boolean }
async function baseRefFindings(opts) {
  const resolved = await resolveBaseRefFiles(opts);
  if (!resolved.derived && resolved.files === null && resolved.source === null) {
    return {
      status: 'skip',
      findings: [],
      source: null,
      derived: false,
      detail: 'no --base-ref or --base-ref-files provided; same-PR zero-lag check is SKIP (CI must supply an input)',
    };
  }
  if (resolved.derived && resolved.error !== undefined) {
    return {
      status: 'fail',
      findings: [{
        file: '<base-ref>',
        detail: `unable to derive added-file list from --base-ref ${resolved.source}: ${resolved.error}`,
      }],
      source: resolved.source,
      derived: true,
      detail: 'base-ref derivation failed',
    };
  }
  let added;
  if (resolved.derived) {
    added = resolved.files;
  } else {
    added = await readJson(resolved.source);
  }
  if (!Array.isArray(added)) {
    return {
      status: 'fail',
      findings: [{ file: '<base-ref-files>', detail: 'base-ref file list must be a JSON array of paths' }],
      source: resolved.source,
      derived: resolved.derived,
    };
  }
  const out = [];
  const addedSet = new Set(added.map((p) => String(p)));
  for (const rel of addedSet) {
    if (!rel.endsWith('.md')) continue;
    if (!rel.startsWith('docs/')) continue;
    if (isPeerExcluded(join(WORKSPACE, rel), WORKSPACE)) continue;
    if (rel.endsWith('.es.md')) {
      const enPeer = expectedEnPeerPath(rel);
      if (!addedSet.has(enPeer)) {
        out.push({ file: rel, detail: 'ES sibling added without its EN sibling in the same change (zero-lag violated)' });
      }
    } else {
      const esPeer = expectedEsPeerPath(rel);
      if (!addedSet.has(esPeer)) {
        out.push({ file: rel, detail: 'EN file added without its ES sibling in the same change (zero-lag violated)' });
      }
    }
  }
  return {
    status: out.length === 0 ? 'pass' : 'fail',
    findings: out,
    source: resolved.source,
    derived: resolved.derived,
  };
}

// --- Reporter -----------------------------------------------------------

const COLOURS = {
  reset: '\u001B[0m', red: '\u001B[31m', green: '\u001B[32m',
  yellow: '\u001B[33m', cyan: '\u001B[36m', bold: '\u001B[1m', dim: '\u001B[2m',
};

// Render a single section. A section is either a list of findings
// (`findings`) or a structured SKIP record (`{ status: 'skip', … }`).
function renderSection(C, key, label, section) {
  const findings = Array.isArray(section) ? section : (section.findings ?? []);
  const status = Array.isArray(section) ? (findings.length === 0 ? 'pass' : 'fail') : section.status;
  let tag;
  if (status === 'skip') tag = `${C.yellow}SKIP${C.reset}`;
  else if (status === 'fail') tag = `${C.red}FAIL${C.reset}`;
  else tag = `${C.green}PASS${C.reset}`;
  const lines = [`${tag}  ${label} (${findings.length})`];
  if (status === 'skip' && section.detail !== undefined) {
    lines.push(`     ${C.dim}${section.detail}${C.reset}`);
  }
  for (const f of findings) {
    const where = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
    const cat = f.category ?? f.detail ?? 'finding';
    lines.push(`     ${C.yellow}${where}${C.reset}  ${C.dim}${cat}${C.reset}`);
  }
  return lines;
}

function renderHuman(report, useColour) {
  const C = useColour ? COLOURS : { reset: '', red: '', green: '', yellow: '', cyan: '', bold: '', dim: '' };
  const lines = [`${C.bold}handoff-cms docs QA${C.reset}`, `${C.dim}workspace: ${report.workspace}${C.reset}`, ''];
  const sections = [
    ['heading-hierarchy', 'Heading hierarchy'],
    ['fenced-code-languages', 'Fenced code languages'],
    ['peer-siblings', 'EN / ES peer siblings'],
    ['translated-prose', 'Translated prose sentinels'],
    ['link-topology', 'EN / ES link topology parity'],
    ['link-integrity', 'Relative link / fragment integrity'],
    ['secret-shaped', 'Secret-shaped literals'],
    ['forbidden-adjective', 'Forbidden marketing adjectives'],
    ['unsourced-positive-claim', 'Unsourced positive-proof claims'],
    ['forbidden-authority-example', 'Governance-unsafe examples'],
    ['seven-commands', 'Seven verified commands'],
    ['openapi-equality', 'OpenAPI equality (paths + operationIds + root)'],
    ['api-endpoints', 'API endpoint parity'],
    ['cli-commands', 'CLI command parity'],
    ['cli-privileged', 'CLI privileged parity'],
    ['mcp-tools', 'MCP tool inventory'],
    ['server-routes', 'Server observability routes'],
    ['cms-variables', 'CMS_* configuration parity'],
    ['metric-names', 'Prometheus metric names (metricsToText)'],
    ['state-machine', 'State machine action vocabulary'],
    ['closed-unions', 'Closed error-code union discovery'],
    ['base-ref-zero-lag', 'Same-PR EN/ES zero-lag'],
  ];
  let pass = 0, fail = 0, skip = 0;
  for (const [key, label] of sections) {
    const section = report.findings[key] ?? [];
    const status = Array.isArray(section) ? (section.length === 0 ? 'pass' : 'fail') : section.status;
    if (status === 'pass') pass += 1;
    else if (status === 'fail') fail += 1;
    else skip += 1;
    lines.push(...renderSection(C, key, label, section));
  }
  lines.push('');
  lines.push(fail === 0
    ? `${C.green}${C.bold}OK${C.reset}  docs-qa passed (${pass} pass / ${skip} skip)`
    : `${C.red}${C.bold}FAIL${C.reset}  docs-qa found ${fail} failing section(s) (${pass} pass / ${skip} skip)`);
  return lines.join('\n');
}

function renderJson(report) { return JSON.stringify(report, null, 2); }

// --- CLI dispatch -------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, baseRef: null, baseRefFiles: null, colour: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--no-colour' || arg === '--no-color') opts.colour = false;
    else if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
    else if (arg === '--version') { process.stdout.write('docs-qa 1.0.0\n'); process.exit(0); }
    else if (arg === '--base-ref') { const next = argv[++i]; if (next === undefined) { process.stderr.write('docs-qa: --base-ref requires a value\n'); process.exit(2); } opts.baseRef = next; }
    else if (arg === '--base-ref-files') { const next = argv[++i]; if (next === undefined) { process.stderr.write('docs-qa: --base-ref-files requires a value\n'); process.exit(2); } opts.baseRefFiles = next; }
    else if (arg.startsWith('--')) { process.stderr.write(`docs-qa: unknown flag ${arg}\n`); process.exit(2); }
  }
  return opts;
}

function printUsage() {
  process.stdout.write(
    'docs-qa -- deterministic, source-derived docs QA for handoff-cms\n\n' +
      'Usage: node scripts/docs-qa.mjs [options]\n\n' +
      'Options:\n' +
      '  --json                 emit JSON to stdout\n' +
      '  --base-ref <ref>       derive the changed-file list with read-only `git diff --name-only <ref>...HEAD`\n' +
      '  --base-ref-files <p>   JSON file listing files added in the current branch\n' +
      '  --no-colour            disable ANSI colour in human mode\n' +
      '  --help, -h             show this help and exit\n' +
      '  --version              print the linter version and exit\n',
  );
}

async function buildReport(opts, root) {
  const docs = await readDocs(root);
  const findings = {};
  const headingFindings = [];
  for (const [file, parsed] of docs) {
    const rel = relative(root, file);
    for (const v of headingViolations(parsed.headings)) {
      headingFindings.push({ file: rel, detail: v });
    }
  }
  findings['heading-hierarchy'] = headingFindings;
  const fenceFindings = [];
  for (const [file, parsed] of docs) {
    const rel = relative(root, file);
    for (const v of fenceViolations(parsed.fences, parsed.source)) {
      fenceFindings.push({ file: rel, detail: v });
    }
  }
  findings['fenced-code-languages'] = fenceFindings;
  findings['peer-siblings'] = peerFindings(docs, root).map((f) => ({
    file: f.file,
    detail: f.headingMismatch ?? `missing peer ${f.missing}`,
  }));
  findings['translated-prose'] = proseFindings(docs, root);
  findings['link-topology'] = linkTopologyFindings(docs, root);
  findings['link-integrity'] = await linkFindingsAsync(docs);
  const claim = claimFindings(docs);
  findings['secret-shaped'] = claim.filter((f) => f.category === 'secret');
  findings['forbidden-adjective'] = claim.filter((f) => f.category === 'forbidden-adjective');
  findings['unsourced-positive-claim'] = claim.filter((f) => f.category === 'unsourced-positive-claim');
  findings['forbidden-authority-example'] = claim.filter((f) => f.category === 'forbidden-authority-example');
  findings['seven-commands'] = await sevenCommandsFindings();
  findings['openapi-equality'] = await openApiFindings();
  findings['api-endpoints'] = await apiEndpointFindings();
  // CLI findings are emitted with a per-finding `category` field; we
  // group them by category rather than by `detail.includes(...)`,
  // which would mis-categorise every `PRIVILEGED_COMMANDS` finding
  // as a `COMMANDS` finding.
  const cli = await cliFindings();
  findings['cli-commands'] = cli.filter((f) => f.category === 'cli-commands');
  findings['cli-privileged'] = cli.filter((f) => f.category === 'cli-privileged');
  findings['mcp-tools'] = await mcpFindings();
  findings['server-routes'] = await serverRoutesFindings();
  findings['cms-variables'] = await configFindings();
  findings['metric-names'] = await metricsFindings();
  findings['state-machine'] = await stateMachineFindings();
  findings['closed-unions'] = await errorCodeUniverseFindings();
  findings['base-ref-zero-lag'] = await baseRefFindings(opts);
  return findings;
}

function computeStatus(findings) {
  let pass = 0, fail = 0, skip = 0;
  for (const [, section] of Object.entries(findings)) {
    const status = Array.isArray(section) ? (section.length === 0 ? 'pass' : 'fail') : section.status;
    if (status === 'pass') pass += 1;
    else if (status === 'fail') fail += 1;
    else if (status === 'skip') skip += 1;
  }
  return { pass, fail, skip, passed: fail === 0 };
}

async function main() {
  const opts = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const startedAtPerformance = performance.now();
  const findings = await buildReport(opts, WORKSPACE);
  const { pass, fail, skip } = computeStatus(findings);
  const report = {
    schema: 'docs-qa.report/v1',
    workspace: WORKSPACE,
    startedAt,
    durationMs: Math.round(performance.now() - startedAtPerformance),
    repository: { forgejo: REPO_FORGEJO_URL, github: REPO_GITHUB_URL },
    baseRef: opts.baseRef,
    findings,
    summary: { totalFindings: fail, passed: fail === 0, pass, fail, skip },
  };
  process.stdout.write(opts.json
    ? `${renderJson(report)}\n`
    : `${renderHuman(report, opts.colour)}\n`);
  if (findings['closed-unions'].length > 0) process.exit(3);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

// --- Public exports -----------------------------------------------------
export {
  deepEqual,
  canonicalJson,
  readText,
  readJson,
  listFiles,
  slugify,
  parseMarkdown,
  headingViolations,
  fenceViolations,
  looksLikePlainTextFence,
  isStrictCsvRow,
  extractLinks,
  extractLinksForTopology,
  readDocs,
  isPeerExcluded,
  expectedEsPeerPath,
  expectedEnPeerPath,
  peerFindings,
  proseFindings,
  linkTopologyFindings,
  linkFindingsAsync,
  claimFindings,
  isForbiddenAdjectiveExempt,
  isSecretExempt,
  isDocumentedPlaceholder,
  sevenCommandsFindings,
  openApiFindings,
  validateOpenApiRoot,
  collectOpenApiOperations,
  apiEndpointFindings,
  cliFindings,
  mcpFindings,
  serverRoutesFindings,
  metricsFindings,
  configFindings,
  extractMetricsToTextNames,
  extractConfigLoaderNames,
  stateMachineFindings,
  discoverClosedUnions,
  extractDocumentedUnionMembers,
  errorCodeUniverseFindings,
  resolveBaseRefFiles,
  baseRefFindings,
  parseArgs,
  renderHuman,
  renderJson,
  computeStatus,
  WORKSPACE,
  REPO_FORGEJO_URL,
  REPO_GITHUB_URL,
  SECRET_PATTERNS,
  FORBIDDEN_ADJECTIVES,
  POSITIVE_PROOF_ADJECTIVES,
  FORBIDDEN_AUTHORITY_PHRASES,
  DOCS_PEER_EXCLUSIONS,
  QUICKSTART_EN,
  QUICKSTART_ES,
  VERIFICATION_REPORT,
  EXPECTED_API_ROUTES,
  EXPECTED_API_OPERATIONS,
  buildReport,
};

export async function run() {
  const opts = parseArgs(process.argv);
  const findings = await buildReport(opts, WORKSPACE);
  const { pass, fail, skip } = computeStatus(findings);
  return {
    schema: 'docs-qa.report/v1',
    workspace: WORKSPACE,
    repository: { forgejo: REPO_FORGEJO_URL, github: REPO_GITHUB_URL },
    baseRef: opts.baseRef,
    findings,
    summary: { totalFindings: fail, passed: fail === 0, pass, fail, skip },
  };
}

// --- Auto-runner --------------------------------------------------------

const isMain = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false;
  try { return resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`docs-qa crashed: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(2);
  });
}