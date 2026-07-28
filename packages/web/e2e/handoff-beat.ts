import '../src/styles.css';
import { createTranslator } from '@cms/i18n';
import { bootstrap, createBrowserDomAdapter } from '../src/app.js';
import type { AuthoringApi, AuthoringSnapshot, DeployStatus } from '../src/model.js';
import { evaluate as evaluateTastecheck } from '../src/tastecheck.js';

const ISO = '2026-07-27T12:00:00.000Z' as never;
const human = Object.freeze({ kind: 'actor', id: 'operator-1', displayName: 'Cerafica Operator', capabilities: [] }) as never;
const initial: AuthoringSnapshot = {
  tenantId: 'cerafica', recordId: 'home', contentType: 'page', locale: 'en',
  blocks: [
    { id: 'hero', kind: 'text', hidden: false, focusKey: 'hero-en', value: { en: 'Handmade ceramics', es: 'Cerámica artesanal' } },
    { id: 'story', kind: 'structured_record', hidden: false, focusKey: 'story-name', fields: [{ key: 'name', value: { en: 'Our story', es: 'Nuestra historia' } }] },
    { id: 'product', kind: 'product_safe_content', hidden: false, focusKey: 'product-title', title: { en: 'Moon Vessel', es: 'Vasija Lunar' }, summary: { en: 'One of one.', es: 'Pieza única.' }, price: { amountMinor: 24000, currency: 'USD' } },
    { id: 'image', kind: 'image', hidden: false, focusKey: 'image-alt-en', assetId: 'asset-before', alt: { en: 'Moon vessel', es: 'Vasija lunar' }, crop: { x: 0, y: 0, width: 1, height: 1, focalX: 0.5, focalY: 0.5 } },
  ],
  visibleState: 'editing', proposalId: null, revisionId: null,
  deployStatus: { kind: 'idle' }, deployedRevisionId: null, pendingEdits: [], lastError: null,
  preference: { lowDistraction: false, reduceMotion: false, locale: 'en' },
};

const calls: Array<{ method: string; payload?: unknown }> = [];
let reconcileCount = 0;
const api: AuthoringApi = {
  async loadRecord() { return initial; },
  async previewFromSnapshot({ snapshot }) {
    calls.push({ method: 'preview', payload: snapshot });
    return { previewUrl: '/preview/rev-1', revisionId: 'rev-1', previewAt: ISO };
  },
  async propose() {
    calls.push({ method: 'propose' });
    return {
      proposal: { id: 'proposal-1', action: 'update', tenantId: 'cerafica', recordId: 'home', createdBy: human, createdAt: ISO, environment: 'production', revisionId: 'rev-1', idempotencyKey: 'proposal-key' } as never,
      revision: { id: 'rev-1', recordId: 'home', parentRevisionId: 'rev-0', contentHash: 'a'.repeat(64), snapshot: initial, createdAt: ISO } as never,
    };
  },
  async approve() {
    calls.push({ method: 'approve' });
    return { approval: { id: 'approval-1', proposalId: 'proposal-1', revisionId: 'rev-1', approvedBy: human, approvedAt: ISO } as never };
  },
  async publish() {
    calls.push({ method: 'publish' });
    return {
      publication: { id: 'publication-1', proposalId: 'proposal-1', revisionId: 'rev-1', publishedBy: human, publishedAt: ISO } as never,
      deployStatus: { kind: 'succeeded', completedAt: ISO, deployReceiptId: 'deploy-1' } as never,
    };
  },
  async rollback() {
    calls.push({ method: 'rollback' });
    return { rolledBackTo: 'rev-0', deployStatus: { kind: 'rolled_back', rolledBackAt: ISO, previousDeployReceiptId: 'deploy-1' } as never };
  },
  async reconcile() {
    reconcileCount += 1;
    calls.push({ method: 'reconcile', payload: reconcileCount });
    const deployStatus: DeployStatus = reconcileCount === 1
      ? ({ kind: 'in_flight', startedAt: ISO } as never)
      : ({ kind: 'succeeded', completedAt: ISO, deployReceiptId: 'deploy-rollback' } as never);
    return { deployStatus, deployedRevisionId: 'rev-0' };
  },
  async uploadAsset(input) {
    calls.push({ method: 'upload', payload: { bytes: input.bytes.length, mimeType: input.mimeType } });
    return { assetId: 'asset-uploaded', contentHash: 'b'.repeat(64) as never, previewUrl: '/asset-uploaded' };
  },
  async replaceAsset(input) {
    calls.push({ method: 'replace', payload: { bytes: input.bytes.length, mimeType: input.mimeType, alt: input.alt, crop: input.crop } });
    return { assetId: 'asset-replaced', contentHash: 'c'.repeat(64) as never, previewUrl: '/asset-replaced' };
  },
  async auditHistory() { return []; },
};

const root = document.querySelector('#app');
if (!(root instanceof HTMLElement)) throw new Error('missing app root');
const handle = bootstrap({ root, api, translator: createTranslator('en'), snapshot: initial, dom: createBrowserDomAdapter(document), scopeId: 'cms' });
Object.assign(window, {
  __beat: {
    snapshot: () => handle.store().snapshot(),
    calls: () => [...calls],
    tastecheck: (screenshotSha256: string) => evaluateTastecheck({
      locale: handle.store().snapshot().preference.locale,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      screenshotSha256,
      document,
      nima: { present: false },
    }),
  },
});
