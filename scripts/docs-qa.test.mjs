// @ts-check
/**
 * docs-qa.test.mjs -- Adversarial node:test suite for the docs-QA
 * linter. The suite builds synthetic workspaces under the OS temp
 * dir, reads them via the linter's own helpers, and asserts the
 * linter produces the expected findings for each adversarial
 * fixture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const LINTER_URL = pathToFileURL(join(REPO_ROOT, 'scripts/docs-qa.mjs')).href;

test('heading hierarchy fails on a skip from H1 to H3', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-heading-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'), '# Title\n\n### Skipped level\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const all = [...docs.values()].flatMap((p) => linter.headingViolations(p.headings));
  assert.ok(all.some((v) => v.includes('level skipped')), 'expected a level-skipped violation');
  rmSync(root, { recursive: true });
});

test('fenced code block without a language is flagged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-fence-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'), '# T\n\n```\necho hi\n```\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const all = [...docs.values()].flatMap((p) => linter.fenceViolations(p.fences, p.source));
  assert.ok(all.length > 0, 'expected at least one fence violation');
  rmSync(root, { recursive: true });
});

test('heading sibling parity: missing ES peer is reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-peer-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'), '# T\n\n## A\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const findings = linter.peerFindings(docs, root);
  assert.ok(findings.some((f) => f.missing && f.missing.endsWith('.es.md')), 'expected missing ES peer');
  rmSync(root, { recursive: true });
});

test('heading sibling parity: mismatched headings are reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-peer-mismatch-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  // EN carries an extra ## section that the ES sibling does not. The
  // peer parity rule compares LEVEL SHAPES/order (depths only); a
  // different depth sequence is the adversarial case.
  writeFileSync(join(root, 'docs/page.md'), '# T\n\n## A\n\n## B\n');
  writeFileSync(join(root, 'docs/page.es.md'), '# T\n\n## A\n\n### B\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const findings = linter.peerFindings(docs, root);
  assert.ok(findings.some((f) => f.headingMismatch !== null), 'expected a heading-mismatch finding');
  rmSync(root, { recursive: true });
});

test('translated-prose: ES page that is identical English prose is reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-sentinel-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  // Adversarial: the ES peer is a verbatim English copy of the EN page
  // (no Spanish function words). The substantive-prose check must
  // report this as a translation-contract violation.
  const body = [
    '# T',
    '',
    'This is a moderately long English-only paragraph that intentionally',
    'contains more than thirty tokens of substantive prose. It uses no',
    'Spanish stopwords at all and is therefore flagged by the new',
    'proseFindings implementation as identical substantive prose.',
  ].join('\n');
  writeFileSync(join(root, 'docs/page.md'), body + '\n');
  writeFileSync(join(root, 'docs/page.es.md'), body + '\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const findings = linter.proseFindings(docs, root);
  assert.ok(findings.length > 0, 'expected a substantive-prose finding');
  rmSync(root, { recursive: true });
});

test('link integrity: broken fragment is reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-link-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'), '# T\n\n## Real section\n\nSee [missing](#nope).\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const findings = await linter.linkFindingsAsync(docs);
  assert.ok(findings.some((f) => f.detail.includes('fragment does not match')), 'expected a broken fragment finding');
  rmSync(root, { recursive: true });
});

test('link integrity: missing relative file is reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-link-rel-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'), '# T\n\n[no file here](missing.md)\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const findings = await linter.linkFindingsAsync(docs);
  assert.ok(findings.some((f) => f.detail.includes('target path does not exist')), 'expected a missing-file finding');
  rmSync(root, { recursive: true });
});

test('secrets: a real-shaped JWT is reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-secret-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'),
    '# T\n\nToken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const claim = linter.claimFindings(docs);
  assert.ok(claim.some((f) => f.category === 'secret'), 'expected a secret-shaped finding');
  rmSync(root, { recursive: true });
});

test('governance-unsafe example: force-approve is reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-force-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'),
    '# T\n\nTo force-approve the proposal, run the special operator command.\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const claim = linter.claimFindings(docs);
  assert.ok(claim.some((f) => f.category === 'forbidden-authority-example'), 'expected a forbidden-authority-example finding');
  rmSync(root, { recursive: true });
});

test('forbidden adjective: production-hardened is reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-adjective-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'),
    '# T\n\nThis is a production-hardened deployment with a fully validated release pipeline.\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const claim = linter.claimFindings(docs);
  assert.ok(claim.some((f) => f.category === 'forbidden-adjective'), 'expected a forbidden-adjective finding');
  rmSync(root, { recursive: true });
});

test('closed union discovery: documented unions exist in the real source', async () => {
  const linter = await import(LINTER_URL);
  const { discovered, typeAliases } = await linter.discoverClosedUnions();
  assert.ok(discovered instanceof Map);
  assert.ok(typeAliases instanceof Map);
  for (const name of [
    'ERROR_CODES', 'API_ERROR_CODES', 'STORE_ERROR_CODES',
    'SERVER_ERROR_CODES', 'SERVER_CONFIG_ERROR_CODES', 'SERVER_AUTH_ERROR_CODES',
    'BLOB_STORE_ERROR_CODES', 'MEDIA_PIPELINE_ERROR_CODES',
    'ADAPTER_REFUSAL_CODES', 'SYMLINK_REFUSAL_CODES',
  ]) {
    assert.ok(discovered.has(name), `expected discovered union ${name}`);
  }
  for (const name of [
    'ErrorCode', 'ApiErrorCode', 'StoreErrorCode',
    'ServerErrorCode', 'ServerConfigErrorCode', 'ServerAuthErrorCode',
    'BlobStoreErrorCode', 'MediaPipelineErrorCode',
    'AdapterRefusalCode', 'SymlinkRefusalCode',
    'StorageErrorCode', 'CliErrorCode',
  ]) {
    assert.ok(typeAliases.has(name), `expected type alias ${name}`);
  }
});

test('canonical JSON serialisation produces a stable byte stream', async () => {
  const linter = await import(LINTER_URL);
  const a = { b: 1, a: [1, 2, { c: 3 }] };
  const b = { a: [1, 2, { c: 3 }], b: 1 };
  assert.equal(linter.canonicalJson(a), linter.canonicalJson(b));
});

test('deep-equal handles arrays, objects, and primitives', async () => {
  const linter = await import(LINTER_URL);
  assert.equal(linter.deepEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), true);
  assert.equal(linter.deepEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }), false);
  assert.equal(linter.deepEqual([1, 2], [1, 2, 3]), false);
  assert.equal(linter.deepEqual(null, null), true);
  assert.equal(linter.deepEqual(null, undefined), false);
});
test('slugify preserves Unicode letters and accents, removes punctuation, and replaces each space with one dash', async () => {
  const linter = await import(LINTER_URL);
  // accents + ñ survive
  assert.equal(linter.slugify('Quién es'), 'quién-es');
  // punctuation removed; surrounding spaces collapse into one extra dash
  assert.equal(linter.slugify('Source / claim discipline'), 'source--claim-discipline');
  // em-dash produces a double dash
  assert.equal(linter.slugify('Who this is for — pick one path'), 'who-this-is-for--pick-one-path');
  // markdown inline punctuation is stripped
  assert.equal(linter.slugify('`code` and *emph*'), 'code-and-emph');
});

test('parseMarkdown disambiguates duplicate heading slugs with -1, -2 suffixes', async () => {
  const linter = await import(LINTER_URL);
  const parsed = linter.parseMarkdown('## Notes\n\n## Notes\n\n## Notes\n');
  assert.deepEqual(parsed.headings.map((h) => h.slug), ['notes', 'notes-1', 'notes-2']);
});

test('peer parity: EN/ES pages with distinct translated heading text but identical depth shape pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-peer-translated-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  // EN/ES pair with same depths but different translated headings — the
  // corrected peer parity check must NOT report a mismatch.
  writeFileSync(join(root, 'docs/page.md'),
    '# Source / claim discipline\n\n## What this is\n\n### Subsection\n');
  writeFileSync(join(root, 'docs/page.es.md'),
    '# Disciplina de fuente y afirmación\n\n## Qué es\n\n### Subsección\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const findings = linter.peerFindings(docs, root);
  assert.equal(findings.length, 0, 'expected zero peer findings on a translated pair with matching depth shape');
  rmSync(root, { recursive: true });
});

test('peer parity: docs/evidence/*.md is exempt from the EN/ES peer rule', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-evidence-'));
  mkdirSync(join(root, 'docs/evidence'), { recursive: true });
  writeFileSync(join(root, 'docs/evidence/limitations.md'),
    '# Limitations ledger\n\n## Three reported limitations\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const findings = linter.peerFindings(docs, root);
  assert.equal(findings.length, 0, 'expected docs/evidence/*.md to be excluded from the peer rule');
  rmSync(root, { recursive: true });
});

test('peer parity: missing-peer path uses foo.es.md, not foo.md.es.md', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-peer-missing-path-'));
  mkdirSync(join(root, 'docs/how-to'), { recursive: true });
  writeFileSync(join(root, 'docs/how-to/new-guide.md'), '# T\n\n## Body\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const findings = linter.peerFindings(docs, root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].missing, 'docs/how-to/new-guide.es.md');
  rmSync(root, { recursive: true });
});

test('translated-prose: genuine Spanish peer is accepted even without closed sentinels', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-translated-ok-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  // EN page lacks the legacy sentinel words but the ES page is a real
  // Spanish translation with abundant Spanish stopwords. No finding.
  writeFileSync(join(root, 'docs/page.md'),
    '# T\n\nThis page describes the workflow in plain English without any of the sentinel words the legacy rule used to look for.\n');
  writeFileSync(join(root, 'docs/page.es.md'),
    '# T\n\nEsta página describe el flujo de trabajo en español llano sin las palabras centinela que la regla heredada solía buscar.\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const findings = linter.proseFindings(docs, root);
  assert.equal(findings.length, 0, 'expected no translation findings on a genuine Spanish peer');
  rmSync(root, { recursive: true });
});

test('link integrity: source-code citation fragments like #L82-L102 are not heading fragments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-sourcecite-'));
  mkdirSync(join(root, 'packages/web/src'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  // The cited file must exist on disk (so the path check passes), but
  // its fragment `#L82-L102` is a source-code citation, not a heading
  // slug. The link-integrity check must NOT report it as a broken
  // fragment.
  writeFileSync(join(root, 'packages/web/src/app.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'docs/page.md'),
    '# T\n\nSee [app.ts](../packages/web/src/app.ts#L82-L102).\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const findings = await linter.linkFindingsAsync(docs);
  assert.equal(findings.length, 0, 'expected no link-integrity finding for a source-code citation');
  rmSync(root, { recursive: true });
});

test('secrets: the all-zero placeholder UUID is not reported as a secret', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-uuid-placeholder-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  // The nil-tenant placeholder UUID is documented in the policy and
  // appears verbatim in readiness-probe call sites; it must not be
  // flagged as a leaked credential.
  writeFileSync(join(root, 'docs/page.md'),
    '# T\n\nThe readiness probe uses tenant `00000000-0000-0000-0000-000000000000` for a round-trip SELECT.\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const claim = linter.claimFindings(docs);
  assert.ok(!claim.some((f) => f.category === 'secret'), 'placeholder nil UUID must not be reported as a secret');
  rmSync(root, { recursive: true });
});

test('secrets: a real non-zero UUID is still reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-uuid-real-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'),
    '# T\n\nTenant id `4f6b1d3a-7e9c-4f3b-9a8d-1b2c3d4e5f6a` is a real identifier and must be reported.\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const claim = linter.claimFindings(docs);
  assert.ok(claim.some((f) => f.category === 'secret'), 'real non-zero UUID must still be reported');
  rmSync(root, { recursive: true });
});

test('forbidden adjective: policy pages quoting the closed list as a negative example are exempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-adj-exempt-'));
  mkdirSync(join(root, 'docs/project'), { recursive: true });
  // The docs-QA policy page lists every forbidden adjective in code
  // spans as a negative example; it must NOT be reported.
  writeFileSync(join(root, 'docs/project/docs-qa.md'),
    '# DR4\n\n- `production-hardened`\n- `fully validated`\n- `enterprise-grade`\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const claim = linter.claimFindings(docs);
  assert.ok(!claim.some((f) => f.category === 'forbidden-adjective'), 'policy-page quote of the closed list must not be reported');
  rmSync(root, { recursive: true });
});

test('forbidden adjective: enterprise-grade documentation framing is permitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-eg-docs-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  // "enterprise-grade documentation" is a documentation-quality claim,
  // not a runtime capability claim; it must be allowed.
  writeFileSync(join(root, 'docs/page.md'),
    '# T\n\nThis repository ships enterprise-grade documentation and an enterprise-grade docs site.\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const claim = linter.claimFindings(docs);
  assert.ok(!claim.some((f) => f.category === 'forbidden-adjective'), 'enterprise-grade documentation framing must be allowed');
  rmSync(root, { recursive: true });
});

test('fenced code: a single-line CSV identifier list is classified as plain text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-fence-text-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  // Cerafica-style un-tagged fence with a CSV identifier list; the
  // corrected classifier must auto-classify it as plain text rather
  // than reporting it as unlabeled code.
  writeFileSync(join(root, 'docs/page.md'),
    '# T\n\nThe closed host keys are:\n\n```\nstripe_payment_link, price, available, coming_soon, one_of_one\n```\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const all = [...docs.values()].flatMap((p) => linter.fenceViolations(p.fences, p.source));
  assert.equal(all.length, 0, 'expected the plain-text CSV fence to be classified as text');
  rmSync(root, { recursive: true });
});

test('fenced code: an un-tagged fence with executable content (echo hi) is still reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-fence-code-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'),
    '# T\n\nRun this command:\n\n```\necho hi\n```\n');
  const linter = await import(LINTER_URL);
  const docs = await linter.readDocs(root);
  const all = [...docs.values()].flatMap((p) => linter.fenceViolations(p.fences, p.source));
  assert.ok(all.length > 0, 'un-tagged fence with shell-like content must still be reported');
  rmSync(root, { recursive: true });
});

test('parseArgs honours --json', async () => {
  const linter = await import(LINTER_URL);
  const opts = linter.parseArgs(['node', 'docs-qa.mjs', '--json']);
  assert.equal(opts.json, true);
});

test('parseArgs rejects unknown flags without leaking process globals', async () => {
  const linter = await import(LINTER_URL);
  const originalExit = process.exit;
  const originalStderrWrite = process.stderr.write;
  let captured = null;
  process.exit = (code) => {
    captured = code;
    return undefined;
  };
  try {
    process.stderr.write = () => true;
    linter.parseArgs(['node', 'docs-qa.mjs', '--unknown']);
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
  }
  assert.equal(captured, 2);
});

test('OpenAPI operation collection preserves method, path, and operationId', async () => {
  const linter = await import(LINTER_URL);
  const document = {
    openapi: '3.1.0',
    info: { title: 'x', version: '1' },
    paths: {
      '/v1/items/{id}': {
        get: { operationId: 'getItem', responses: { 200: { description: 'ok' } } },
        post: { operationId: 'createItem', responses: { 200: { description: 'ok' } } },
      },
    },
  };
  assert.equal(linter.validateOpenApiRoot(document).ok, true);
  const operations = linter.collectOpenApiOperations(document);
  assert.deepEqual([...operations.keys()], ['GET /v1/items/{id}', 'POST /v1/items/{id}']);
  assert.equal(operations.get('GET /v1/items/{id}').operationId, 'getItem');
  document.openapi = '3.0.3';
  assert.equal(linter.validateOpenApiRoot(document).ok, false);
});

test('same-PR locale gate reports skip, pass, and fail explicitly', async () => {
  const linter = await import(LINTER_URL);
  assert.equal((await linter.baseRefFindings({ baseRef: null, baseRefFiles: null })).status, 'skip');
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-base-'));
  const paired = join(root, 'paired.json');
  const unpaired = join(root, 'unpaired.json');
  writeFileSync(paired, JSON.stringify(['docs/x.md', 'docs/x.es.md']));
  writeFileSync(unpaired, JSON.stringify(['docs/x.md']));
  assert.equal((await linter.baseRefFindings({ baseRef: null, baseRefFiles: paired })).status, 'pass');
  assert.equal((await linter.baseRefFindings({ baseRef: null, baseRefFiles: unpaired })).status, 'fail');
  rmSync(root, { recursive: true });
});

test('link topology accepts locale peers and rejects a missing target', async () => {
  const linter = await import(LINTER_URL);
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-links-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/page.md'), '# Page\n\n[Target](target.md)\n');
  writeFileSync(join(root, 'docs/page.es.md'), '# Página\n\n[Destino](target.es.md)\n');
  writeFileSync(join(root, 'docs/target.md'), '# Target\n');
  writeFileSync(join(root, 'docs/target.es.md'), '# Destino\n');
  let docs = await linter.readDocs(root);
  assert.deepEqual(linter.linkTopologyFindings(docs, root), []);
  writeFileSync(join(root, 'docs/page.es.md'), '# Página\n');
  docs = await linter.readDocs(root);
  assert.equal(linter.linkTopologyFindings(docs, root).length, 1);
  rmSync(root, { recursive: true });
});

test('comma does not disguise executable content as plain text', async () => {
  const linter = await import(LINTER_URL);
  const source = '# T\n\n```\nrm -rf /,\n```\n';
  const parsed = linter.parseMarkdown(source);
  assert.equal(linter.looksLikePlainTextFence(source, parsed.fences[0]), false);
});

test('claim policy keeps authority checks active on secrets guidance', async () => {
  const linter = await import(LINTER_URL);
  const root = mkdtempSync(join(tmpdir(), 'docs-qa-claims-'));
  mkdirSync(join(root, 'docs/security'), { recursive: true });
  writeFileSync(join(root, 'docs/security/secrets-in-docs.md'), '# Policy\n\nNever force-approve a change.\n');
  const docs = await linter.readDocs(root);
  const findings = linter.claimFindings(docs);
  assert.ok(findings.some((finding) => finding.category === 'forbidden-authority-example'));
  rmSync(root, { recursive: true });
});

test('metrics and config extractors ignore comment-only names', async () => {
  const linter = await import(LINTER_URL);
  const metrics = `// cms_server_fake_total\nfunction metricsToText(): string {\n return \"cms_server_real_total 1\";\n}`;
  assert.deepEqual([...linter.extractMetricsToTextNames(metrics)], ['cms_server_real_total']);
  const config = `// CMS_FAKE\nfunction loadServerConfig(env: NodeJS.ProcessEnv): ServerConfig {\n const x = env.CMS_REAL;\n return {} as ServerConfig;\n}`;
  assert.deepEqual([...linter.extractConfigLoaderNames(config)], ['CMS_REAL']);
});

test('closed-union discovery returns only exported source declarations', async () => {
  const linter = await import(LINTER_URL);
  const { discovered, typeAliases, unionMembers } = await linter.discoverClosedUnions();
  assert.deepEqual([...discovered.keys()].sort(), [
    'ADAPTER_REFUSAL_CODES', 'API_ERROR_CODES', 'BLOB_STORE_ERROR_CODES',
    'ERROR_CODES', 'MEDIA_PIPELINE_ERROR_CODES', 'SERVER_AUTH_ERROR_CODES',
    'SERVER_CONFIG_ERROR_CODES', 'SERVER_ERROR_CODES', 'STORE_ERROR_CODES',
    'SYMLINK_REFUSAL_CODES',
  ].sort());
  assert.equal(typeAliases.size, 12);
  assert.ok(unionMembers.get('ERROR_CODES').includes('E_BAD_LOCALE'));
});

test('CLI parity findings carry one non-overlapping category', async () => {
  const linter = await import(LINTER_URL);
  const findings = await linter.cliFindings();
  assert.ok(findings.every((finding) => ['cli-commands', 'cli-privileged'].includes(finding.category)));
  assert.ok(findings.every((finding) => !(finding.category === 'cli-commands' && finding.detail.includes('PRIVILEGED_COMMANDS'))));
});

test('full report marks the absent base-ref check as skipped', async () => {
  const linter = await import(LINTER_URL);
  const findings = await linter.buildReport({ json: true, baseRef: null, baseRefFiles: null, colour: false }, REPO_ROOT);
  assert.equal(findings['base-ref-zero-lag'].status, 'skip');
  assert.deepEqual(findings['closed-unions'], []);
});

test('documented union parser exposes stale members for inverse parity', async () => {
  const linter = await import(LINTER_URL);
  const document = [
    '# Catalog',
    '',
    '## 1. Core — `ERROR_CODES` (2)',
    '',
    '| Code |',
    '| --- |',
    '| `E_REAL` |',
    '| `E_STALE` |',
    '',
    '## Next',
  ].join('\n');
  assert.deepEqual(
    [...linter.extractDocumentedUnionMembers(document, 'ERROR_CODES')],
    ['E_REAL', 'E_STALE'],
  );
});
