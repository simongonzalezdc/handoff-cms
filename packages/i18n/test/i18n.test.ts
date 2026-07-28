import { describe, expect, it } from 'vitest';

import {
  CATALOGS,
  SUPPORTED_LOCALES,
  assertCatalogParity,
  createTranslator,
  negotiateLocale,
  type MessageKey,
} from '../src/index.js';

describe('@cms/i18n', () => {
  it('keeps exact English and Spanish key and interpolation parity', () => {
    expect(() => assertCatalogParity()).not.toThrow();
    expect(Object.keys(CATALOGS.es).sort()).toEqual(Object.keys(CATALOGS.en).sort());

    for (const key of Object.keys(CATALOGS.en) as MessageKey[]) {
      const placeholders = (message: string): string[] =>
        [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
          .map((match) => match[1] ?? '')
          .sort();

      expect(placeholders(CATALOGS.es[key]), key).toEqual(placeholders(CATALOGS.en[key]));
    }
  });

  it('interpolates named values without evaluating or reading inherited values', () => {
    const t = createTranslator('es');
    expect(t('validation.maxLength', { field: 'Título', max: 80 })).toBe(
      'Título debe tener 80 caracteres o menos.',
    );

    const inherited = Object.create({ field: 'Title', max: 80 }) as Record<string, string | number>;
    expect(() => createTranslator('en')('validation.maxLength', inherited)).toThrow(
      'Missing interpolation variable "field"',
    );
  });

  it('fails when a required interpolation variable is absent', () => {
    expect(() => createTranslator('en')('deploy.failed', {})).toThrow(
      'Missing interpolation variable "reason" for message "deploy.failed" in locale "en".',
    );
  });

  it('fails when interpolation variables are omitted entirely', () => {
    expect(() => createTranslator('en')('deploy.failed')).toThrow(
      'Missing interpolation variable "reason"',
    );
  });

  it('rejects unsupported locales and negotiates without an implicit default', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'es']);
    expect(negotiateLocale('fr-CA, es-MX;q=0.8, en;q=0.7')).toBe('es');
    expect(negotiateLocale(['de-DE', 'en-GB'])).toBe('en');
    expect(negotiateLocale('es;q=0, en;q=0')).toBeUndefined();
    expect(negotiateLocale('en;q=0.1, es;q=0.9')).toBe('es');
    expect(negotiateLocale('fr-FR')).toBeUndefined();
    expect(negotiateLocale(undefined)).toBeUndefined();
    expect(() => createTranslator('fr' as never)).toThrow('Unsupported locale "fr".');
  });

  it('fails closed rather than falling back to an English key', () => {
    expect(() => createTranslator('es')('only.in.english' as MessageKey)).toThrow(
      'Missing message "only.in.english" for locale "es".',
    );

    const missingSpanishKey = {
      en: { present: 'English only' },
      es: {},
    };
    expect(() => assertCatalogParity(missingSpanishKey)).toThrow(
      'Catalog "es" is missing key "present".',
    );
  });

  it('rejects placeholder drift and unexpected peer-locale keys', () => {
    expect(() =>
      assertCatalogParity({
        en: { key: '{name}' },
        es: { key: '{nombre}' },
      }),
    ).toThrow(/placeholders/);
    expect(() =>
      assertCatalogParity({
        en: { key: 'value' },
        es: { key: 'valor', extra: 'extra' },
      }),
    ).toThrow(/unexpected key/);
  });

  it('preserves critical human authority, reversibility, accessibility, and peer-alt wording', () => {
    const en = createTranslator('en');
    const es = createTranslator('es');

    expect(en('app.title')).toBe('Handoff CMS authoring');
    expect(es('app.title')).toBe('Creación de contenido en Handoff CMS');
    expect(en('propose.confirmBody')).toBe(
      'Send this draft to a human for review. Proposing does not approve or publish it.',
    );
    expect(es('propose.confirmBody')).toBe(
      'Envía este borrador a una persona para que lo revise. Proponerlo no lo aprueba ni lo publica.',
    );
    expect(en('publish.confirmBody')).toContain('Only an authorized human can publish');
    expect(es('publish.confirmBody')).toContain('Solo una persona autorizada puede publicar');
    expect(en('rollback.confirmBody')).toContain('A new audit entry will record the reversal');
    expect(es('rollback.confirmBody')).toContain('Una nueva entrada de auditoría registrará la reversión');
    expect(en('media.altRequiredBoth')).toBe('Alternative text is required in English and Spanish.');
    expect(es('media.altRequiredBoth')).toBe('Se requiere texto alternativo en español e inglés.');
    expect(en('a11y.neurodivergentNotice')).toBe('neurodivergent-accessible by design');
    expect(es('a11y.neurodivergentNotice')).toBe(
      'accesible para personas neurodivergentes por diseño',
    );
  });
  it('exposes peer-localized locale selector label, product title/summary, and distinct block-action names', () => {
    const en = createTranslator('en');
    const es = createTranslator('es');

    // Locale selector label is an exact peer key, not a fallback to app.title.
    expect(en('app.locale.label')).toBe('Language');
    expect(es('app.locale.label')).toBe('Idioma');
    expect(en('app.locale.label')).not.toBe(en('app.title'));
    expect(es('app.locale.label')).not.toBe(es('app.title'));

    // Product title and summary are translated peers; both locales agree.
    expect(en('records.product.title')).toBe('Title');
    expect(es('records.product.title')).toBe('Título');
    expect(en('records.product.summary')).toBe('Summary');
    expect(es('records.product.summary')).toBe('Resumen');
    expect(en('history.undoLocal')).toBe('Undo last local edit');
    expect(es('history.undoLocal')).toBe('Deshacer la última edición local');

    // Block-action names are distinct, translated, and carry the target
    // block id through the existing named interpolation contract.
    const enUp = en('blocks.action.moveUp', { id: 'text-1' });
    const enDown = en('blocks.action.moveDown', { id: 'text-1' });
    const enHide = en('blocks.action.hide', { id: 'text-1' });
    const enDup = en('blocks.action.duplicate', { id: 'text-1' });
    expect(enUp).toContain('text-1');
    expect(enDown).toContain('text-1');
    expect(enHide).toContain('text-1');
    expect(enDup).toContain('text-1');
    expect(new Set([enUp, enDown, enHide, enDup]).size).toBe(4);
    expect(enUp).not.toBe(enDown);
    expect(enUp).not.toBe(enHide);
    expect(enUp).not.toBe(enDup);

    const esUp = es('blocks.action.moveUp', { id: 'text-1' });
    const esDown = es('blocks.action.moveDown', { id: 'text-1' });
    const esHide = es('blocks.action.hide', { id: 'text-1' });
    const esDup = es('blocks.action.duplicate', { id: 'text-1' });
    expect(new Set([esUp, esDown, esHide, esDup]).size).toBe(4);
    expect(esUp).toBe('Mover bloque text-1 arriba');
    expect(esDown).toBe('Mover bloque text-1 abajo');
    expect(esHide).toBe('Ocultar bloque text-1');
    expect(esDup).toBe('Duplicar bloque text-1');

    // Interpolation contract fails closed when the variable is absent.
    expect(() => en('blocks.action.moveUp')).toThrow(/blocks\.action\.moveUp/);
    expect(() => en('blocks.action.moveUp', {})).toThrow(/id/);
  });

  it('keeps catalog key set and placeholder parity for the new peer keys', () => {
    // assertCatalogParity must keep holding once the catalog grows; this
    // catches any drift in placeholders or key set between EN and ES.
    expect(() => assertCatalogParity()).not.toThrow();

    const actionKeys: MessageKey[] = [
      'blocks.action.moveUp',
      'blocks.action.moveDown',
      'blocks.action.hide',
      'blocks.action.duplicate',
    ];
    for (const key of actionKeys) {
      expect(key in CATALOGS.en).toBe(true);
      expect(key in CATALOGS.es).toBe(true);
      // Every block-action key takes exactly the `{id}` placeholder and
      // nothing else, keeping the named-interpolation contract uniform.
      const placeholders = (message: string): string[] =>
        [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
          .map((match) => match[1] ?? '')
          .sort();
      expect(placeholders(CATALOGS.en[key])).toEqual(['id']);
      expect(placeholders(CATALOGS.es[key])).toEqual(['id']);
    }

    // Product title/summary and the locale selector label carry no
    // placeholders; their parity must stay literal.
    const noPlaceholderKeys: MessageKey[] = [
      'app.locale.label',
      'records.product.title',
      'records.product.summary',
      'history.undoLocal',
    ];
    for (const key of noPlaceholderKeys) {
      const placeholders = (message: string): string[] =>
        [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
          .map((match) => match[1] ?? '')
          .sort();
      expect(placeholders(CATALOGS.en[key])).toEqual([]);
      expect(placeholders(CATALOGS.es[key])).toEqual([]);
    }
  });

  it('provides peer-localized action-specific announcements for governed deploy mutations', () => {
    const en = createTranslator('en');
    const es = createTranslator('es');
    const requiredKeys: MessageKey[] = [
      'action.preview.done',
      'action.propose.done',
      'action.approve.done',
      'action.publish.done',
      'action.rollback.done',
      'action.reconcile.done',
      'reconcile.confirmTitle',
      'reconcile.confirmBody',
      'a11y.reducedMotion.on',
      'a11y.reducedMotion.off',
    ];
    for (const key of requiredKeys) {
      expect(key in CATALOGS.en, `en missing ${key}`).toBe(true);
      expect(key in CATALOGS.es, `es missing ${key}`).toBe(true);
    }
    expect(en('action.preview.done')).toBe('Preview ready.');
    expect(es('action.preview.done')).toBe('Vista previa lista.');
    expect(en('action.publish.done')).toBe('Published.');
    expect(es('action.publish.done')).toBe('Publicado.');
    expect(en('action.rollback.done')).toBe('Rolled back to the previous canonical version.');
    expect(es('action.rollback.done')).toBe('Revertido a la versión canónica anterior.');
    expect(en('action.reconcile.done')).toBe('Deploy state reconciled.');
    expect(es('action.reconcile.done')).toBe('Estado de despliegue reconciliado.');
    expect(en('reconcile.confirmTitle')).toBe('Reconcile deploy state?');
    expect(es('reconcile.confirmTitle')).toBe('¿Reconciliar el estado de despliegue?');
    expect(en('reconcile.confirmBody')).toContain('governed deploy mutation');
    expect(es('reconcile.confirmBody')).toContain('mutación de despliegue gobernada');
    expect(en('a11y.reducedMotion.on')).not.toBe(en('a11y.reducedMotion.off'));
    expect(es('a11y.reducedMotion.on')).not.toBe(es('a11y.reducedMotion.off'));
    // No silent English fallback for ES users.
    expect(es('action.publish.done')).not.toBe(en('action.publish.done'));
    expect(es('action.rollback.done')).not.toBe(en('action.rollback.done'));
    expect(es('action.reconcile.done')).not.toBe(en('action.reconcile.done'));
  });
});
