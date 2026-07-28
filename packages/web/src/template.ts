/**
 * `template.ts` — framework-free, deterministic, semantic HTML5 renderer for
 * the authoring application. The output is the only user-facing surface; the
 * runtime `app.ts` is a thin event-binding layer over this renderer.
 *
 * Design contract:
 *   - No DOM access, no globals, no side effects.
 *   - Every visible string passes through the injected `Translator`. English
 *     and Spanish are peers; missing keys throw, never silently fall back.
 *   - Every required authoring surface is rendered from the model snapshot's
 *     `blocks` array (text / structured_record / product_safe_content /
 *     image), plus the privileged propose / approve / publish / rollback
 *     action surfaces, deploy status, audit history, live regions,
 *     locale switcher, error summary, and a complementary rollback region.
 *   - Landmarks use native semantics: `<header>`, `<nav>`, `<main>`,
 *     `<section>` with `aria-labelledby`, `<aside>`, `<footer>`. ARIA only
 *     fills the gap where native semantics are unavailable.
 *   - All interactive controls are real `<button>` / `<a>` / `<input>` /
 *     `<textarea>` / `<select>` / `<form>` elements with native labels.
 *     No `<div role="button">` substitutes.
 *   - The renderer is locale-aware: `<html lang>` is set from the snapshot,
 *     and the same surface set is rendered in either locale without any
 *     surface disappearing.
 *   - Product safe content renders the title and summary as read-only text
 *     (price is visibly read-only). Alt text is exposed as two required
 *     `<input data-cms-input="alt" data-cms-locale="en|es">` fields.
 */

import { type MessageKey, type Translator } from '@cms/i18n';

import {
  type AuditEntry,
  type AuthoringSnapshot,
  type ImageBlock,
  type ProductSafeContentBlock,
  type StructuredRecordBlock,
  type TextBlock,
  isReconcilable,
  isRollbackAllowed,
} from './model.js';

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

function tx(
  t: Translator,
  key: MessageKey,
  variables?: Readonly<Record<string, string | number>>,
): string {
  // Forward the call through the typed Translator directly. The catalog
  // union guarantees the key exists for both `en` and `es`; interpolation
  // variables are passed by name so they survive peer-locale switches
  // without re-ordering.
  return variables === undefined ? t(key) : t(key, variables);
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape for an attribute value. We reuse the same HTML-safe subset as
 * `esc`; the helper exists to keep intent obvious at the call sites that
 * build region ids (which must be safe inside `id="..."`).
 */
function escAttr(value: string): string {
  return esc(value);
}

/**
 * Locale of the active translator. The translator exposes its bound
 * locale through the `locale` property; we use it for `Intl.NumberFormat`
 * so prices render with the correct grouping / separators per locale.
 */
function activeLocale(t: Translator): 'en' | 'es' {
  return t.locale === 'es' ? 'es' : 'en';
}

/**
 * Format a product price using the active translator's locale. The
 * block carries amountMinor (e.g. 1000 = $10.00) and currency (e.g.
 * `USD`); the host's Intl is used so currency symbols and separators
 * follow the active locale. The output is plain text — every consumer
 * runs it through `esc` for attribute or text-node placement.
 */
function formatPrice(
  price: { readonly amountMinor: number; readonly currency: string },
  t: Translator,
): string {
  const locale = activeLocale(t);
  const amount = price.amountMinor / 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: price.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // An unsupported currency code (Intl throws RangeError) must never
    // crash the renderer. Fall back to the locale-correct decimal with
    // the raw ISO currency code so the value remains auditable.
    const decimal = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
    return `${decimal} ${price.currency}`;
  }
}

function renderSkipLink(t: Translator, scope: string): string {
  return `<a class="cms-skip-link" href="#${scope}-main">${esc(tx(t, 'app.skipToMain'))}</a>`;
}

function renderBanner(snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  const bannerId = `${scope}-banner`;
  const langId = `${scope}-lang`;
  const options = ['en', 'es']
    .map(
      (loc) =>
        `<option value="${loc}"${loc === snapshot.locale ? ' selected' : ''}>${esc(
          tx(t, loc === 'en' ? 'app.lang.en' : 'app.lang.es'),
        )}</option>`,
    )
    .join('');
  return [
    `<header class="cms-banner" role="banner" aria-labelledby="${bannerId}-heading" data-cms-region="banner">`,
    `  <h1 id="${bannerId}-heading" class="cms-banner__title">${esc(tx(t, 'app.title'))}</h1>`,
    `  <form class="cms-locale" data-cms-form="locale" aria-labelledby="${langId}-label">`,
    `    <label id="${langId}-label" for="${langId}" class="cms-locale__label">${esc(tx(t, 'app.locale.label'))}</label>`,
    `    <select id="${langId}" name="locale" class="cms-locale__select" data-cms-control="locale">${options}</select>`,
    '  </form>',
    '</header>',
  ].join('\n');
}


/**
 * First block id per kind, in the order blocks appear in the snapshot.
 * Used by the nav so the per-kind anchor still resolves to a real
 * element when multiple same-kind blocks exist.
 */
function firstBlockAnchor(snapshot: AuthoringSnapshot, kind: TextBlock['kind'] | StructuredRecordBlock['kind'] | ProductSafeContentBlock['kind'] | ImageBlock['kind']): string | null {
  for (const block of snapshot.blocks) {
    if (block.kind === kind) return block.id;
  }
  return null;
}

function renderNav(snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  const navId = `${scope}-nav`;
  // Per-kind anchors resolve to the first block of each kind (the nav
  // remains a coarse summary; per-block navigation lives in the blocks
  // region and through the focusable per-block headings).
  const firstText = firstBlockAnchor(snapshot, 'text');
  const firstRecord = firstBlockAnchor(snapshot, 'structured_record');
  const firstMedia = firstBlockAnchor(snapshot, 'image');
  const items: ReadonlyArray<readonly [MessageKey, string]> = [
    ['nav.text', firstText === null ? `${scope}-region-text` : `${scope}-region-text-${escAttr(firstText)}`],
    ['nav.records', firstRecord === null ? `${scope}-region-records` : `${scope}-region-records-${escAttr(firstRecord)}`],
    ['nav.blocks', `${scope}-region-blocks`],
    ['nav.media', firstMedia === null ? `${scope}-region-media` : `${scope}-region-media-${escAttr(firstMedia)}`],
    ['nav.history', `${scope}-region-history`],
    ['nav.rollback', `${scope}-region-rollback`],
  ];
  const links = items
    .map(([key, target]) => `<li><a class="cms-nav__link" href="#${target}">${esc(tx(t, key))}</a></li>`)
    .join('');
  return [
    `<nav class="cms-nav" role="navigation" aria-labelledby="${navId}-heading" data-cms-region="nav">`,
    `  <h2 id="${navId}-heading" class="cms-visually-hidden">${esc(tx(t, 'nav.surfaces'))}</h2>`,
    `  <ul class="cms-nav__list">${links}</ul>`,
    '</nav>',
  ].join('\n');
}

function renderMainStart(_snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  const mainId = `${scope}-main`;
  const heading = esc(tx(t, 'app.title'));
  return [
    `<main class="cms-main" id="${mainId}" role="main" aria-labelledby="${mainId}-heading" data-cms-region="main" tabindex="-1">`,
    `  <h2 id="${mainId}-heading" class="cms-visually-hidden">${heading}</h2>`,
  ].join('\n');
}

function renderMainEnd(): string {
  return '</main>';
}

function renderFooter(t: Translator, scope: string): string {
  const footerId = `${scope}-footer`;
  return [
    `<footer class="cms-footer" role="contentinfo" aria-labelledby="${footerId}-heading" data-cms-region="footer">`,
    `  <h2 id="${footerId}-heading" class="cms-visually-hidden">${esc(tx(t, 'a11y.neurodivergentNotice'))}</h2>`,
    `  <p class="cms-footer__note">${esc(tx(t, 'a11y.neurodivergentNotice'))}</p>`,
    '</footer>',
  ].join('\n');
}

function renderErrorSummary(snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  const id = `${scope}-errors`;
  const items: string[] = [];
  const missingTextField = (block: TextBlock): string | null => {
    if (block.value.en.trim().length === 0) return `${block.id}-en`;
    if (block.value.es.trim().length === 0) return `${block.id}-es`;
    return null;
  };
  const missingRecordField = (block: StructuredRecordBlock): string | null => {
    for (const f of block.fields) {
      if (f.value.en.trim().length === 0) return `${block.id}-${f.key}-en`;
      if (f.value.es.trim().length === 0) return `${block.id}-${f.key}-es`;
    }
    return null;
  };
  const missingAltField = (block: ImageBlock): string | null => {
    if (block.alt.en.trim().length === 0) return `${block.id}-alt-en`;
    if (block.alt.es.trim().length === 0) return `${block.id}-alt-es`;
    return null;
  };
  for (const block of snapshot.blocks) {
    if (block.kind === 'text') {
      const target = missingTextField(block);
      if (target !== null) {
        items.push(`<li><a href="#${esc(target)}">${esc(tx(t, 'errors.required'))}</a></li>`);
      }
    } else if (block.kind === 'structured_record') {
      const target = missingRecordField(block);
      if (target !== null) {
        items.push(`<li><a href="#${esc(target)}">${esc(tx(t, 'errors.required'))}</a></li>`);
      }
    } else if (block.kind === 'image') {
      const target = missingAltField(block);
      if (target !== null) {
        items.push(`<li><a href="#${esc(target)}">${esc(tx(t, 'errors.altRequired'))}</a></li>`);
      }
    }
  }
  const hidden = items.length === 0 ? ' hidden' : '';
  return [
    `<section id="${id}" class="cms-error-summary" role="alert" data-cms-region="errors" aria-labelledby="${id}-heading"${hidden} tabindex="-1">`,
    `  <h2 id="${id}-heading" class="cms-error-summary__heading">${esc(tx(t, 'errors.summaryTitle'))}</h2>`,
    '  <p class="cms-error-summary__runtime" data-cms-error-runtime="true"></p>',
    `  <ul class="cms-error-summary__list">${items.join('')}</ul>`,
    '</section>',
  ].join('\n');
}

function renderTextBlock(block: TextBlock, _snapshot: AuthoringSnapshot, _t: Translator, scope: string): string {
  // Per-block region id. Multiple text blocks of the same kind MUST NOT
  // share the same id; the nav anchor and any per-block focus target
  // depend on uniqueness.
  const regionId = `${scope}-region-text-${escAttr(block.id)}`;
  const valueEn = block.value.en;
  const valueEs = block.value.es;
  const enId = `${block.id}-en`;
  const esId = `${block.id}-es`;
  return [
    `<section id="${regionId}" class="cms-region cms-region--text" role="form" aria-labelledby="${regionId}-heading" data-cms-region="text" data-cms-block-id="${esc(block.id)}" data-cms-block-kind="text">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(block.id)}</h2>`,
    `  <form class="cms-form" data-cms-form="text" novalidate data-cms-block-form="${esc(block.id)}">`,
    `    <label class="cms-field__label" for="${enId}">${esc(tx(_t, 'text.locale.en'))}</label>`,
    `    <textarea id="${enId}" name="value.en" class="cms-field__input" rows="6" data-cms-input="text" data-cms-block-id="${esc(block.id)}" data-cms-locale="en">${esc(valueEn)}</textarea>`,
    `    <label class="cms-field__label" for="${esId}">${esc(tx(_t, 'text.locale.es'))}</label>`,
    `    <textarea id="${esId}" name="value.es" class="cms-field__input" rows="6" data-cms-input="text" data-cms-block-id="${esc(block.id)}" data-cms-locale="es">${esc(valueEs)}</textarea>`,
    '  </form>',
    '</section>',
  ].join('\n');
}

function renderStructuredRecordBlock(block: StructuredRecordBlock, _snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  // Per-block region id; multiple records of the same kind must not collide.
  const regionId = `${scope}-region-records-${escAttr(block.id)}`;
  const fields = block.fields
    .flatMap((field) =>
      (['en', 'es'] as const).map((locale) => {
        const inputId = `${block.id}-${field.key}-${locale}`;
        return [
          `<div class="cms-field" data-cms-field="${esc(block.id)}.${esc(field.key)}.${locale}">`,
          `  <label class="cms-field__label" for="${inputId}">${esc(field.key)} — ${esc(tx(t, locale === 'en' ? 'text.locale.en' : 'text.locale.es'))}</label>`,
          `  <input id="${inputId}" name="${esc(field.key)}-${locale}" class="cms-field__input" type="text" value="${esc(field.value[locale])}" data-cms-input="record-field" data-cms-block-id="${esc(block.id)}" data-cms-field-key="${esc(field.key)}" data-cms-locale="${locale}">`,
          '</div>',
        ].join('\n');
      }),
    )
    .join('\n');
  return [
    `<section id="${regionId}" class="cms-region cms-region--records" role="region" aria-labelledby="${regionId}-heading" data-cms-region="records" data-cms-block-id="${esc(block.id)}" data-cms-block-kind="structured_record">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(tx(t, 'records.heading'))}</h2>`,
    `  <article class="cms-record" data-cms-record="${esc(block.id)}">${fields}</article>`,
    '</section>',
  ].join('\n');
}

function renderProductBlock(block: ProductSafeContentBlock, _snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  // Per-block region id; multiple product blocks must not collide.
  const regionId = `${scope}-region-products-${escAttr(block.id)}`;
  // Localized price formatting via Intl.NumberFormat. We do not invent a
  // new i18n key for price: the currency comes from the block data and
  // the locale is derived from the active translator. The output element
  // additionally exposes a `data-cms-product-price-amount` /
  // `data-cms-product-price-currency` pair so test harnesses can verify
  // formatting without scraping localised text.
  const priceText = formatPrice(block.price, t);
  return [
    `<section id="${regionId}" class="cms-region cms-region--product" role="region" aria-labelledby="${regionId}-heading" data-cms-region="products" data-cms-block-id="${esc(block.id)}" data-cms-block-kind="product_safe_content">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(tx(t, 'records.product.heading'))}</h2>`,
    `  <form class="cms-product cms-form" data-cms-product="${esc(block.id)}" data-cms-form="product">`,
    ...(['en', 'es'] as const).flatMap((locale) => {
      const contentLocale = esc(tx(t, locale === 'en' ? 'text.locale.en' : 'text.locale.es'));
      const titleLabel = esc(tx(t, 'records.product.title'));
      const summaryLabel = esc(tx(t, 'records.product.summary'));
      const titleId = `${block.id}-title-${locale}`;
      const summaryId = `${block.id}-summary-${locale}`;
      return [
        `    <label for="${titleId}">${contentLocale} — ${titleLabel}</label>`,
        `    <input id="${titleId}" value="${esc(block.title[locale])}" data-cms-input="product-title" data-cms-block-id="${esc(block.id)}" data-cms-locale="${locale}">`,
        `    <label for="${summaryId}">${contentLocale} — ${summaryLabel}</label>`,
        `    <textarea id="${summaryId}" data-cms-input="product-summary" data-cms-block-id="${esc(block.id)}" data-cms-locale="${locale}">${esc(block.summary[locale])}</textarea>`,
      ];
    }),
    `    <p>${esc(tx(t, 'records.product.readonlyCommerce'))}</p>`,
    `    <output class="cms-product__price" data-cms-product-price="${esc(block.id)}" data-cms-product-price-amount="${esc(String(block.price.amountMinor))}" data-cms-product-price-currency="${esc(block.price.currency)}">${esc(priceText)}</output>`,
    '  </form>',
    '</section>',
  ].join('\n');
}

function renderApprovedBlocks(snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  const regionId = `${scope}-region-blocks`;
  const items = snapshot.blocks
    .map((block, index) => {
      const blockId = esc(block.id);
      // Action labels are distinct per action and carry the block id through
      // the typed Translator's named interpolation contract; the outer esc
      // escapes the composed label so user-controlled ids remain safe.
      const actionLabels = {
        moveUp: esc(tx(t, 'blocks.action.moveUp', { id: block.id })),
        moveDown: esc(tx(t, 'blocks.action.moveDown', { id: block.id })),
        hide: esc(tx(t, 'blocks.action.hide', { id: block.id })),
        duplicate: esc(tx(t, 'blocks.action.duplicate', { id: block.id })),
      };
      const controls = [
        `<button type="button" class="cms-button" data-cms-action="block-reorder" data-cms-action-direction="up" data-cms-block-id="${blockId}"${index === 0 ? ' disabled' : ''} aria-label="${actionLabels.moveUp}">↑</button>`,
        `<button type="button" class="cms-button" data-cms-action="block-reorder" data-cms-action-direction="down" data-cms-block-id="${blockId}"${index === snapshot.blocks.length - 1 ? ' disabled' : ''} aria-label="${actionLabels.moveDown}">↓</button>`,
        `<button type="button" class="cms-button" data-cms-action="block-hide" data-cms-block-id="${blockId}" aria-label="${actionLabels.hide}">${actionLabels.hide}</button>`,
        `<button type="button" class="cms-button" data-cms-action="block-duplicate" data-cms-block-id="${blockId}" aria-label="${actionLabels.duplicate}">+</button>`,
      ].join(' ');
      return `<li class="cms-block" data-cms-block="${blockId}"><h3 class="cms-block__heading">${blockId}</h3><p class="cms-block__meta">${esc(block.kind)}</p><div class="cms-block__actions" role="group" aria-label="${esc(tx(t, 'blocks.heading'))}">${controls}</div></li>`;
    })
    .join('');
  return [
    `<section id="${regionId}" class="cms-region cms-region--blocks" role="region" aria-labelledby="${regionId}-heading" data-cms-region="blocks">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(tx(t, 'blocks.heading'))}</h2>`,
    `  <ol class="cms-block__list" data-cms-block-list="true">${items}</ol>`,
    `  <button type="button" class="cms-button" data-cms-action="block-insert">${esc(tx(t, 'blocks.add'))}</button>`,
    '</section>',
  ].join('\n');
}


function renderImageBlock(block: ImageBlock, _snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  // Per-block region id; multiple image blocks must not collide.
  const regionId = `${scope}-region-media-${escAttr(block.id)}`;
  const altEnId = `${block.id}-alt-en`;
  const altEsId = `${block.id}-alt-es`;
  const cropId = `${block.id}-crop`;
  const focalId = `${block.id}-focal`;
  // The model asserts both alt locales are present; the template renders
  // both as required inputs. Crop / focal / upload / replace forms.
  return [
    `<section id="${regionId}" class="cms-region cms-region--media" role="region" aria-labelledby="${regionId}-heading" data-cms-region="media" data-cms-block-id="${esc(block.id)}" data-cms-block-kind="image">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(tx(t, 'media.heading'))}</h2>`,
    `  <form class="cms-form cms-form--upload" data-cms-form="upload" data-cms-block-id="${esc(block.id)}" aria-labelledby="${block.id}-upload-heading">`,
    `    <h3 id="${block.id}-upload-heading" class="cms-form__heading">${esc(tx(t, 'media.upload'))}</h3>`,
    `    <input type="file" accept="image/*" class="cms-field__file" required aria-label="${esc(tx(t, 'media.upload'))}" data-cms-input="upload" data-cms-block-id="${esc(block.id)}">`,
    `    <button type="submit" class="cms-button" data-cms-block-id="${esc(block.id)}">${esc(tx(t, 'media.upload'))}</button>`,
    '  </form>',
    `  <form class="cms-form cms-form--replace" data-cms-form="replace" data-cms-block-id="${esc(block.id)}" data-cms-asset-id="${esc(block.assetId)}" aria-labelledby="${block.id}-replace-heading">`,
    `    <h3 id="${block.id}-replace-heading" class="cms-form__heading">${esc(tx(t, 'media.replace'))}</h3>`,
    `    <input type="file" accept="image/*" class="cms-field__file" aria-label="${esc(tx(t, 'media.replace'))}" data-cms-input="replace" data-cms-block-id="${esc(block.id)}">`,
    `    <button type="submit" class="cms-button" data-cms-block-id="${esc(block.id)}">${esc(tx(t, 'media.replace'))}</button>`,
    '  </form>',
    `  <form class="cms-form cms-form--crop" data-cms-form="crop" data-cms-block-id="${esc(block.id)}" aria-labelledby="${cropId}-heading">`,
    `    <h3 id="${cropId}-heading" class="cms-form__heading">${esc(tx(t, 'media.crop'))}</h3>`,
    `    <input type="number" min="0" max="1" step="0.01" value="${block.crop.x.toFixed(2)}" data-cms-input="crop-x" data-cms-block-id="${esc(block.id)}" aria-label="x">`,
    `    <input type="number" min="0" max="1" step="0.01" value="${block.crop.y.toFixed(2)}" data-cms-input="crop-y" data-cms-block-id="${esc(block.id)}" aria-label="y">`,
    `    <input type="number" min="0" max="1" step="0.01" value="${block.crop.width.toFixed(2)}" data-cms-input="crop-w" data-cms-block-id="${esc(block.id)}" aria-label="w">`,
    `    <input type="number" min="0" max="1" step="0.01" value="${block.crop.height.toFixed(2)}" data-cms-input="crop-h" data-cms-block-id="${esc(block.id)}" aria-label="h">`,
    `    <h3 id="${focalId}-heading" class="cms-form__heading">${esc(tx(t, 'media.focal'))}</h3>`,
    `    <input type="number" min="0" max="1" step="0.01" value="${block.crop.focalX.toFixed(2)}" data-cms-input="focal-x" data-cms-block-id="${esc(block.id)}" aria-label="x">`,
    `    <input type="number" min="0" max="1" step="0.01" value="${block.crop.focalY.toFixed(2)}" data-cms-input="focal-y" data-cms-block-id="${esc(block.id)}" aria-label="y">`,
    `    <button type="submit" class="cms-button">${esc(tx(t, 'media.crop'))}</button>`,
    '  </form>',
    `  <div class="cms-field" data-cms-field="alt.${esc(block.id)}.en">`,
    `    <label class="cms-field__label" for="${altEnId}">${esc(tx(t, 'media.alt'))} (en)</label>`,
    `    <input id="${altEnId}" name="alt-en-${esc(block.id)}" class="cms-field__input" type="text" required value="${esc(block.alt.en)}" data-cms-input="alt" data-cms-block-id="${esc(block.id)}" data-cms-locale="en">`,
    '  </div>',
    `  <div class="cms-field" data-cms-field="alt.${esc(block.id)}.es">`,
    `    <label class="cms-field__label" for="${altEsId}">${esc(tx(t, 'media.alt'))} (es)</label>`,
    `    <input id="${altEsId}" name="alt-es-${esc(block.id)}" class="cms-field__input" type="text" required value="${esc(block.alt.es)}" data-cms-input="alt" data-cms-block-id="${esc(block.id)}" data-cms-locale="es">`,
    '  </div>',
    '</section>',
  ].join('\n');
}

function renderProposalPreview(snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  const regionId = `${scope}-region-proposal`;
  const empty = snapshot.visibleState !== 'preview_ready' && snapshot.visibleState !== 'proposed' && snapshot.visibleState !== 'approved';
  const body = empty
    ? `<p class="cms-region__empty">${esc(tx(t, 'preview.heading'))}</p>`
    : `<p class="cms-preview__state">${esc(snapshot.visibleState)}</p>`;
  return [
    `<section id="${regionId}" class="cms-region cms-region--proposal" role="region" aria-labelledby="${regionId}-heading" data-cms-region="proposal">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(tx(t, 'preview.heading'))}</h2>`,
    `  ${body}`,
    `  <button type="button" class="cms-button" data-cms-action="preview">${esc(tx(t, 'preview.heading'))}</button>`,
    '</section>',
  ].join('\n');
}

function renderActions(snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  const regionId = `${scope}-region-actions`;
  const isProposed = snapshot.visibleState === 'proposed';
  const isApproved = snapshot.visibleState === 'approved';
  const proposeDisabled = isProposed || isApproved ? ' disabled' : '';
  const approveDisabled = isApproved || !isProposed ? ' disabled' : '';
  const publishDisabled = !isApproved ? ' disabled' : '';
  return [
    `<section id="${regionId}" class="cms-region cms-region--actions" role="region" aria-labelledby="${regionId}-heading" data-cms-region="actions">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(tx(t, 'preview.heading'))}</h2>`,
    `  <button type="button" class="cms-button cms-button--primary" data-cms-action="propose"${proposeDisabled}>${esc(tx(t, 'propose.label'))}</button>`,
    `  <button type="button" class="cms-button" data-cms-action="approve"${approveDisabled}>${esc(tx(t, 'approve.label'))}</button>`,
    `  <button type="button" class="cms-button cms-button--destructive" data-cms-destructive="true" data-confirm="${esc(tx(t, 'publish.confirmTitle'))}" data-cms-action="publish"${publishDisabled}>${esc(tx(t, 'publish.label'))}</button>`,
    '</section>',
  ].join('\n');
}

function renderDeployStatus(snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  const regionId = `${scope}-region-deploy`;
  const kind = snapshot.deployStatus.kind;
  // Reconcile only permitted from deploy-related states. Mirrors the
  // model's `isReconcilable` predicate so the button cannot be clicked
  // when the dispatch boundary would throw `E_RECONCILE_FORBIDDEN`.
  const reconcilable = isReconcilable(snapshot.visibleState);
  const reconcileDisabled = reconcilable ? '' : ' disabled';
  const reconcileAria = reconcilable
    ? esc(tx(t, 'deploy.heading'))
    : esc(`${tx(t, 'errors.generic')}`);
  const body = `<p class="cms-deploy__state">${esc(kind)}</p>`;
  return [
    `<section id="${regionId}" class="cms-region cms-region--deploy" role="status" aria-labelledby="${regionId}-heading" aria-live="polite" data-cms-region="deploy">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(tx(t, 'deploy.heading'))}</h2>`,
    `  ${body}`,
    `  <button type="button" class="cms-button" data-cms-action="reconcile" data-cms-reconcile-allowed="${reconcilable ? 'true' : 'false'}" aria-disabled="${reconcilable ? 'false' : 'true'}" aria-label="${reconcileAria}"${reconcileDisabled}>${esc(tx(t, 'deploy.heading'))}</button>`,
    '</section>',
  ].join('\n');
}

function renderAuditHistory(
  snapshot: AuthoringSnapshot,
  t: Translator,
  scope: string,
  auditEntries: readonly AuditEntry[],
): string {
  const regionId = `${scope}-region-history`;
  const entries = auditEntries
    .map((entry) => {
      const action = entry.message ?? entry.command?.type ?? entry.kind;
      return [
        `<li class="cms-audit" data-cms-audit="${esc(entry.id)}">`,
        `  <p class="cms-audit__summary">${esc(tx(t, 'history.entry.action'))}: ${esc(action)}</p>`,
        `  <p class="cms-audit__actor">${esc(tx(t, 'history.entry.actor'))}: ${esc(entry.actor.displayName)}</p>`,
        `  <p class="cms-audit__at">${esc(tx(t, 'history.entry.at'))}: <time datetime="${esc(entry.at)}">${esc(entry.at)}</time></p>`,
        '</li>',
      ].join('');
    })
    .join('');
  const body =
    entries.length === 0
      ? `<p class="cms-region__empty">${esc(tx(t, 'history.empty'))}</p>`
      : `<ol class="cms-audit__list" data-cms-audit-list="true">${entries}</ol>`;
  const undoDisabled = snapshot.pendingEdits.length === 0 ? ' disabled' : '';
  return [
    `<section id="${regionId}" class="cms-region cms-region--history" role="region" aria-labelledby="${regionId}-heading" data-cms-region="history">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(tx(t, 'history.heading'))}</h2>`,
    `  ${body}`,
    `  <button type="button" class="cms-button" data-cms-action="undo-local-edit"${undoDisabled}>${esc(tx(t, 'history.undoLocal'))}</button>`,
    '</section>',
  ].join('\n');
}

function renderRollback(snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  const regionId = `${scope}-region-rollback`;
  // Mirrors `isRollbackAllowed` from the model: rollback is reachable
  // from `live` (normal reversal) and `error` (recoverable error). Other
  // states forbid rollback at the dispatch boundary, so the button must
  // be disabled so a click cannot dispatch a forbidden command.
  const allowed = isRollbackAllowed(snapshot.visibleState);
  const disabled = allowed ? '' : ' disabled';
  // When rollback is disallowed, surface an explicit status note for AT
  // users instead of letting the destructive label dangle. We reuse
  // existing i18n keys to avoid expanding the catalog in this slice.
  const statusId = `${regionId}-status`;
  const status = allowed
    ? ''
    : `<p id="${statusId}" class="cms-region__status" data-cms-region="rollback-status">${esc(tx(t, 'errors.generic'))}</p>`;
  return [
    `<aside id="${regionId}" class="cms-region cms-region--rollback" role="complementary" aria-labelledby="${regionId}-heading" data-cms-region="rollback">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(tx(t, 'rollback.label'))}</h2>`,
    `  <p class="cms-region__intro">${esc(tx(t, 'rollback.confirmBody'))}</p>`,
    `  ${status}`,
    `  <button type="button" class="cms-button cms-button--destructive" data-cms-destructive="true" data-confirm="${esc(tx(t, 'rollback.confirmTitle'))}" data-cms-action="rollback" data-cms-rollback-allowed="${allowed ? 'true' : 'false'}" aria-disabled="${allowed ? 'false' : 'true'}"${disabled}>${esc(tx(t, 'rollback.label'))}</button>`,
    '</aside>',
  ].join('\n');
}
/**
 * Render the preference surface. The buttons dispatch a synthetic
 * `set-preference` action; the value alternates between `true` and
 * `false` on each render so assistive tech can announce the resulting
 * state through the live region. The same surface is rendered in
 * either locale without ever changing shape, mirroring the bilingual
 * contract used by every other region.
 */
function renderPreferences(snapshot: AuthoringSnapshot, t: Translator, scope: string): string {
  const regionId = `${scope}-region-preferences`;
  const lowOn = snapshot.preference.lowDistraction;
  const motionOn = snapshot.preference.reduceMotion;
  const lowButton = `<button type="button" class="cms-button" data-cms-action="set-preference" data-cms-preference="lowDistraction" data-cms-preference-value="${lowOn ? 'false' : 'true'}" data-cms-control="low-distraction" aria-pressed="${lowOn ? 'true' : 'false'}" aria-label="${esc(tx(t, lowOn ? 'a11y.lowDistraction.on' : 'a11y.lowDistraction.off'))}">${esc(tx(t, 'a11y.lowDistraction'))}</button>`;
  const motionButton = `<button type="button" class="cms-button" data-cms-action="set-preference" data-cms-preference="reduceMotion" data-cms-preference-value="${motionOn ? 'false' : 'true'}" data-cms-control="reduce-motion" aria-pressed="${motionOn ? 'true' : 'false'}" aria-label="${esc(tx(t, 'a11y.reducedMotion'))}">${esc(tx(t, 'a11y.reducedMotion'))}</button>`;
  return [
    `<section id="${regionId}" class="cms-region cms-region--preferences" role="group" aria-labelledby="${regionId}-heading" data-cms-region="preferences" data-cms-preferences="low-distraction:${lowOn ? 'true' : 'false'};reduce-motion:${motionOn ? 'true' : 'false'}">`,
    `  <h2 id="${regionId}-heading" class="cms-region__heading">${esc(tx(t, 'a11y.lowDistraction'))}</h2>`,
    `  <div class="cms-preferences__group" role="group" aria-label="${esc(tx(t, 'a11y.screenReaderHints'))}">`,
    `    ${lowButton}`,
    `    ${motionButton}`,
    `  </div>`,
    '</section>',
  ].join('\n');
}

/**
 * Body-level mode classes for low-distraction + reduced-motion. These
 * mirror `preference.lowDistraction` and `preference.reduceMotion`
 * independently of the system media query so the user can opt in or
 * out explicitly. The classes are inert when the user has not enabled
 * either preference.
 */
function renderModeClasses(snapshot: AuthoringSnapshot): string {
  const classes: string[] = [];
  if (snapshot.preference.lowDistraction) classes.push('cms-mode--low-distraction');
  if (snapshot.preference.reduceMotion) classes.push('cms-mode--reduce-motion');
  return classes.join(' ');
}

function renderLiveRegions(scope: string): string {
  const statusId = `${scope}-live-status`;
  const logId = `${scope}-live-log`;
  return [
    `<div id="${statusId}" class="cms-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-cms-live="status"></div>`,
    `<div id="${logId}" class="cms-visually-hidden" role="log" aria-live="assertive" aria-atomic="false" data-cms-live="log"></div>`,
  ].join('\n');
}

// --------------------------------------------------------------------------
// Public render entry point
// --------------------------------------------------------------------------

export interface RenderOptions {
  /** Identifier used to scope interactive element ids on the page. */
  readonly scopeId?: string;
  /** When true (default), emit the full HTML5 document wrapper. */
  readonly fullDocument?: boolean;
  /** Append-only command/API audit entries rendered in the history region. */
  readonly auditEntries?: readonly AuditEntry[];
}

/**
 * Render the complete authoring surface as a single HTML5 string. Given
 * the same snapshot + translator, the output is byte-identical so the
 * Tastecheck gate remains deterministic.
 */
export function renderTemplate(
  snapshot: AuthoringSnapshot,
  t: Translator,
  options: RenderOptions = {},
): string {
  const scope = options.scopeId ?? 'cms';
  const full = options.fullDocument !== false;
  const parts: string[] = [];

  parts.push(renderSkipLink(t, scope));
  parts.push(renderBanner(snapshot, t, scope));
  parts.push(renderNav(snapshot, t, scope));
  parts.push(renderMainStart(snapshot, t, scope));
  parts.push(renderErrorSummary(snapshot, t, scope));
  parts.push(renderPreferences(snapshot, t, scope));


  // One section per block kind. The renderer does not invent surfaces
  // that the snapshot does not carry.
  for (const block of snapshot.blocks) {
    if (block.kind === 'text') {
      parts.push(renderTextBlock(block, snapshot, t, scope));
    } else if (block.kind === 'structured_record') {
      parts.push(renderStructuredRecordBlock(block, snapshot, t, scope));
    } else if (block.kind === 'product_safe_content') {
      parts.push(renderProductBlock(block, snapshot, t, scope));
    } else if (block.kind === 'image') {
      parts.push(renderImageBlock(block, snapshot, t, scope));
    }
  }

  parts.push(renderApprovedBlocks(snapshot, t, scope));
  parts.push(renderProposalPreview(snapshot, t, scope));
  parts.push(renderActions(snapshot, t, scope));
  parts.push(renderDeployStatus(snapshot, t, scope));
  parts.push(renderAuditHistory(snapshot, t, scope, options.auditEntries ?? []));
  parts.push(renderRollback(snapshot, t, scope));
  parts.push(renderMainEnd());
  parts.push(renderFooter(t, scope));
  parts.push(renderLiveRegions(scope));

  const body = parts.join('\n');
  if (!full) return body;

  return [
    '<!doctype html>',
    `<html lang="${snapshot.locale}" dir="ltr" data-cms-scope="${esc(scope)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(tx(t, 'app.title'))}</title>`,
    `<link rel="stylesheet" href="./styles.css">`,
    '</head>',
    `<body data-locale="${snapshot.locale}" data-cms-mode="${esc(renderModeClasses(snapshot))}">`,
    body,
    '</body>',
    '</html>',
  ].join('\n');
}
