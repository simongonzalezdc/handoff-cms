/**
 * @cms/i18n
 *
 * Dependency-free bilingual authoring messages for the Handoff CMS G006
 * authoring application and deterministic Tastecheck gate.
 *
 * English (`en`) and Spanish (`es`) are peer catalogs: there is no silent
 * fallback from a missing Spanish key to English, and a missing key fails
 * closed. Catalogs live in this one source file so they stay under one
 * review per change. Every key required by the authoring surface is
 * defined for both locales; structural parity (same key set, same named
 * interpolation placeholders) is asserted at runtime.
 *
 * The translator uses a strict {@link MessageKey} union so the type
 * system prevents drift between consumers and catalogs; interpolation is
 * named and order-independent, does not evaluate expressions, and does
 * not read from inherited prototypes.
 */

export const SUPPORTED_LOCALES = ['en', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
const SUPPORTED_LOCALE_SET: ReadonlySet<string> = new Set(SUPPORTED_LOCALES);

const NEURODIVERGENT_ACCESSIBLE_BY_DESIGN = {
  en: 'neurodivergent-accessible by design',
  es: 'accesible para personas neurodivergentes por diseño',
} as const;

interface Catalog {
  readonly [key: string]: string;
}

const ENGLISH_CATALOG = Object.freeze({
  'app.title': 'Handoff CMS authoring',
  'app.skipToMain': 'Skip to main content',
  'app.lang.en': 'English',
  'app.lang.es': 'Spanish',
  'app.status.live': 'Live',
  'app.locale.label': 'Language',

  'nav.surfaces': 'Surfaces',
  'nav.text': 'Text',
  'nav.records': 'Records',
  'nav.blocks': 'Blocks',
  'nav.media': 'Media',
  'nav.history': 'History',
  'nav.rollback': 'Rollback',

  'text.heading': 'Text',
  'text.body': 'Body',
  'text.ctaPrimary': 'Primary action',
  'text.ctaSecondary': 'Secondary action',
  'text.locale.en': 'English copy',
  'text.locale.es': 'Spanish copy',
  'text.save': 'Save draft',
  'text.saved': 'Draft saved',
  'action.preview.done': 'Preview ready.',
  'action.propose.done': 'Sent for human review.',
  'action.approve.done': 'Proposal approved by a human.',
  'action.publish.done': 'Published.',
  'action.rollback.done': 'Rolled back to the previous canonical version.',
  'action.reconcile.done': 'Deploy state reconciled.',
  'reconcile.confirmTitle': 'Reconcile deploy state?',
  'reconcile.confirmBody':
    'Reconciliation is a governed deploy mutation. Continue only after a human has reviewed the current deploy state.',
  'text.error': 'Could not save the draft',

  'records.heading': 'Records',
  'records.product.heading': 'Products',
  'records.product.name': 'Name',
  'records.product.price': 'Price',
  'records.product.readonlyCommerce': 'Price and commerce fields are read-only.',
  'records.product.sku': 'SKU',
  'records.product.description': 'Description',
  'records.product.add': 'Add product',
  'records.product.remove': 'Remove product',
  'records.product.empty': 'No products yet.',
  'records.product.nameRequired': 'Product name is required in English and Spanish.',
  'records.product.title': 'Title',
  'records.product.summary': 'Summary',

  'blocks.heading': 'Blocks',
  'blocks.add': 'Add block',
  'blocks.empty': 'No blocks yet.',
  'blocks.approved.heading': 'Approved blocks',
  'blocks.approved.empty': 'No approved blocks yet.',
  'blocks.action.moveUp': 'Move block {id} up',
  'blocks.action.moveDown': 'Move block {id} down',
  'blocks.action.hide': 'Hide block {id}',
  'blocks.action.duplicate': 'Duplicate block {id}',

  'media.heading': 'Media',
  'media.upload': 'Upload media',
  'media.replace': 'Replace media',
  'media.crop': 'Crop',
  'media.focal': 'Set focal point',
  'media.alt': 'Alternative text',
  'media.altDecorative': 'Mark as decorative',
  'media.empty': 'No media uploaded.',
  'media.replaceConfirm':
    'Replacing the media keeps the existing alt text and focal point. Continue?',
  'media.uploadError': 'Upload failed. Try again or pick a different file.',

  'preview.heading': 'Preview',
  'preview.propose': 'Propose',
  'preview.approve': 'Approve',
  'preview.publish': 'Publish',
  'preview.rollback': 'Rollback',

  'propose.label': 'Propose for review',
  'propose.confirmTitle': 'Send this draft for human review?',
  'propose.confirmBody':
    'Send this draft to a human for review. Proposing does not approve or publish it.',
  'propose.confirmYes': 'Send for review',
  'propose.confirmNo': 'Keep editing',

  'approve.label': 'Approve',
  'approve.confirmTitle': 'Approve this proposal?',
  'approve.confirmBody':
    'Approving records a human decision in the audit log. Only an authorized human can approve.',
  'approve.confirmYes': 'Approve',
  'approve.confirmNo': 'Cancel',

  'publish.label': 'Publish',
  'publish.confirmTitle': 'Publish approved change?',
  'publish.confirmBody':
    'Only an authorized human can publish. A new audit entry will record who published and when.',
  'publish.confirmYes': 'Publish now',
  'publish.confirmNo': 'Cancel',
  'publish.done': 'Published.',

  'rollback.label': 'Rollback',
  'rollback.confirmTitle': 'Rollback to the previous version?',
  'rollback.confirmBody':
    'A new audit entry will record the reversal. The previous version will return to live.',
  'rollback.confirmYes': 'Rollback',
  'rollback.confirmNo': 'Cancel',
  'rollback.done': 'Rolled back.',

  'deploy.heading': 'Deploy status',
  'deploy.idle': 'Idle',
  'deploy.pending': 'Deploy pending',
  'deploy.live': 'Live',
  'deploy.failed': 'Deploy failed: {reason}',

  'history.heading': 'Audit history',
  'history.empty': 'No audit entries yet.',
  'history.entry.action': 'Action',
  'history.entry.actor': 'Actor',
  'history.entry.at': 'When',
  'history.undoLocal': 'Undo last local edit',

  'errors.summaryTitle': 'There are problems to fix before proposing.',
  'errors.required': 'This field is required.',
  'errors.altRequired': 'Alternative text is required unless the image is decorative.',
  'errors.generic': 'Something went wrong. Try again or contact a maintainer.',

  'validation.maxLength': '{field} must be {max} characters or fewer.',

  'a11y.skipToMain': 'Skip to main content',
  'a11y.keyboardHelp': 'Press the question mark key for keyboard shortcuts.',
  'a11y.lowDistraction': 'Low-distraction mode reduces motion and hides non-essential controls.',
  'a11y.lowDistraction.on': 'Low-distraction mode on',
  'a11y.lowDistraction.off': 'Low-distraction mode off',
  'a11y.reducedMotion': 'Reduced motion respected when the system requests it.',
  'a11y.reducedMotion.on': 'Reduced motion on',
  'a11y.reducedMotion.off': 'Reduced motion off',
  'a11y.screenReaderHints': 'Screen reader hints are available on each region.',
  'a11y.neurodivergentNotice': NEURODIVERGENT_ACCESSIBLE_BY_DESIGN.en,
  'a11y.neurodivergentClaimDetail':
    'Designed for keyboard, screen reader, and low-distraction use. External validation is planned for v1.1.',

  'media.altRequiredBoth': 'Alternative text is required in English and Spanish.',
} as const);

const SPANISH_CATALOG = Object.freeze({
  'app.title': 'Creación de contenido en Handoff CMS',
  'app.skipToMain': 'Saltar al contenido principal',
  'app.lang.en': 'Inglés',
  'app.lang.es': 'Español',
  'app.status.live': 'En vivo',
  'app.locale.label': 'Idioma',

  'nav.surfaces': 'Superficies',
  'nav.text': 'Texto',
  'nav.records': 'Registros',
  'nav.blocks': 'Bloques',
  'nav.media': 'Medios',
  'nav.history': 'Historial',
  'nav.rollback': 'Revertir',

  'text.heading': 'Texto',
  'text.body': 'Cuerpo',
  'text.ctaPrimary': 'Acción principal',
  'text.ctaSecondary': 'Acción secundaria',
  'text.locale.en': 'Texto en inglés',
  'text.locale.es': 'Texto en español',
  'text.save': 'Guardar borrador',
  'text.saved': 'Borrador guardado',
  'action.preview.done': 'Vista previa lista.',
  'action.propose.done': 'Enviado a revisión humana.',
  'action.approve.done': 'Propuesta aprobada por una persona.',
  'action.publish.done': 'Publicado.',
  'action.rollback.done': 'Revertido a la versión canónica anterior.',
  'action.reconcile.done': 'Estado de despliegue reconciliado.',
  'reconcile.confirmTitle': '¿Reconciliar el estado de despliegue?',
  'reconcile.confirmBody':
    'La reconciliación es una mutación de despliegue gobernada. Continúa solo después de que una persona revise el estado actual del despliegue.',
  'text.error': 'No se pudo guardar el borrador',

  'records.heading': 'Registros',
  'records.product.heading': 'Productos',
  'records.product.name': 'Nombre',
  'records.product.price': 'Precio',
  'records.product.readonlyCommerce': 'El precio y los campos comerciales son de solo lectura.',
  'records.product.sku': 'SKU',
  'records.product.description': 'Descripción',
  'records.product.add': 'Añadir producto',
  'records.product.remove': 'Quitar producto',
  'records.product.empty': 'Aún no hay productos.',
  'records.product.nameRequired':
    'El nombre del producto es obligatorio en español e inglés.',
  'records.product.title': 'Título',
  'records.product.summary': 'Resumen',

  'blocks.heading': 'Bloques',
  'blocks.add': 'Añadir bloque',
  'blocks.empty': 'Aún no hay bloques.',
  'blocks.approved.heading': 'Bloques aprobados',
  'blocks.approved.empty': 'Aún no hay bloques aprobados.',
  'blocks.action.moveUp': 'Mover bloque {id} arriba',
  'blocks.action.moveDown': 'Mover bloque {id} abajo',
  'blocks.action.hide': 'Ocultar bloque {id}',
  'blocks.action.duplicate': 'Duplicar bloque {id}',

  'media.heading': 'Medios',
  'media.upload': 'Subir medio',
  'media.replace': 'Reemplazar medio',
  'media.crop': 'Recortar',
  'media.focal': 'Definir punto focal',
  'media.alt': 'Texto alternativo',
  'media.altDecorative': 'Marcar como decorativo',
  'media.empty': 'No se subieron medios.',
  'media.replaceConfirm':
    'Reemplazar el medio conserva el texto alternativo y el punto focal. ¿Continuar?',
  'media.uploadError': 'Falló la subida. Inténtalo de nuevo o elige otro archivo.',

  'preview.heading': 'Vista previa',
  'preview.propose': 'Proponer',
  'preview.approve': 'Aprobar',
  'preview.publish': 'Publicar',
  'preview.rollback': 'Revertir',

  'propose.label': 'Proponer para revisión',
  'propose.confirmTitle': '¿Enviar este borrador a revisión humana?',
  'propose.confirmBody':
    'Envía este borrador a una persona para que lo revise. Proponerlo no lo aprueba ni lo publica.',
  'propose.confirmYes': 'Enviar a revisión',
  'propose.confirmNo': 'Seguir editando',

  'approve.label': 'Aprobar',
  'approve.confirmTitle': '¿Aprobar esta propuesta?',
  'approve.confirmBody':
    'Aprobar registra una decisión humana en el registro de auditoría. Solo una persona autorizada puede aprobar.',
  'approve.confirmYes': 'Aprobar',
  'approve.confirmNo': 'Cancelar',

  'publish.label': 'Publicar',
  'publish.confirmTitle': '¿Publicar el cambio aprobado?',
  'publish.confirmBody':
    'Solo una persona autorizada puede publicar. Una nueva entrada de auditoría registrará quién publicó y cuándo.',
  'publish.confirmYes': 'Publicar ahora',
  'publish.confirmNo': 'Cancelar',
  'publish.done': 'Publicado.',

  'rollback.label': 'Revertir',
  'rollback.confirmTitle': '¿Revertir a la versión anterior?',
  'rollback.confirmBody':
    'Una nueva entrada de auditoría registrará la reversión. La versión anterior volverá a estar en vivo.',
  'rollback.confirmYes': 'Revertir',
  'rollback.confirmNo': 'Cancelar',
  'rollback.done': 'Revertido.',

  'deploy.heading': 'Estado de despliegue',
  'deploy.idle': 'Inactivo',
  'deploy.pending': 'Despliegue pendiente',
  'deploy.live': 'En vivo',
  'deploy.failed': 'Despliegue fallido: {reason}',

  'history.heading': 'Historial de auditoría',
  'history.empty': 'Aún no hay entradas de auditoría.',
  'history.entry.action': 'Acción',
  'history.entry.actor': 'Actor',
  'history.entry.at': 'Cuándo',
  'history.undoLocal': 'Deshacer la última edición local',

  'errors.summaryTitle': 'Hay problemas que corregir antes de proponer.',
  'errors.required': 'Este campo es obligatorio.',
  'errors.altRequired':
    'El texto alternativo es obligatorio a menos que la imagen sea decorativa.',
  'errors.generic': 'Algo salió mal. Inténtalo de nuevo o contacta a una persona encargada.',

  'validation.maxLength': '{field} debe tener {max} caracteres o menos.',

  'a11y.skipToMain': 'Saltar al contenido principal',
  'a11y.keyboardHelp': 'Pulsa el signo de interrogación para ver los atajos de teclado.',
  'a11y.lowDistraction':
    'El modo de baja distracción reduce el movimiento y oculta controles no esenciales.',
  'a11y.lowDistraction.on': 'Modo de baja distracción activado',
  'a11y.lowDistraction.off': 'Modo de baja distracción desactivado',
  'a11y.reducedMotion': 'Movimiento reducido respetado cuando el sistema lo solicita.',
  'a11y.reducedMotion.on': 'Movimiento reducido activado',
  'a11y.reducedMotion.off': 'Movimiento reducido desactivado',
  'a11y.screenReaderHints': 'Hay pistas para lector de pantalla en cada región.',
  'a11y.neurodivergentNotice': NEURODIVERGENT_ACCESSIBLE_BY_DESIGN.es,
  'a11y.neurodivergentClaimDetail':
    'Diseñado para uso con teclado, lector de pantalla y baja distracción. La validación externa está prevista para la v1.1.',

  'media.altRequiredBoth': 'Se requiere texto alternativo en español e inglés.',
} as const);

export const CATALOGS = Object.freeze({
  en: ENGLISH_CATALOG,
  es: SPANISH_CATALOG,
});

export type MessageKey = keyof typeof ENGLISH_CATALOG & keyof typeof SPANISH_CATALOG;

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function isSupportedLocale(value: string): value is Locale {
  return SUPPORTED_LOCALE_SET.has(value);
}

function assertLocale(locale: string): asserts locale is Locale {
  if (!isSupportedLocale(locale)) {
    throw new Error(
      `Unsupported locale "${locale}". Expected one of: ${SUPPORTED_LOCALES.join(', ')}.`,
    );
  }
}

function extractPlaceholders(message: string): string[] {
  const names: string[] = [];
  for (const match of message.matchAll(PLACEHOLDER_PATTERN)) {
    if (typeof match[1] === 'string') names.push(match[1]);
  }
  return names.sort();
}

/**
 * Assert that every catalog exposes the same key set and the same
 * interpolation placeholders for each key. Throws on the first drift.
 * Useful at module load and inside tests.
 */
export function assertCatalogParity(
  catalogs: Readonly<Record<Locale, Catalog>> = CATALOGS,
): void {
  const reference = catalogs.en;
  const referencePlaceholders = new Map<string, string[]>();
  for (const key of Object.keys(reference)) {
    referencePlaceholders.set(key, extractPlaceholders(reference[key] ?? ''));
  }

  for (const locale of SUPPORTED_LOCALES) {
    if (locale === 'en') continue;
    const catalog = catalogs[locale];
    for (const key of Object.keys(reference)) {
      if (!(key in catalog)) {
        throw new Error(`Catalog "${locale}" is missing key "${key}".`);
      }
      const placeholders = extractPlaceholders(catalog[key] ?? '');
      if (placeholders.join('|') !== (referencePlaceholders.get(key) ?? []).join('|')) {
        throw new Error(
          `Catalog "${locale}" key "${key}" has placeholders [${placeholders.join(', ')}], ` +
            `expected [${(referencePlaceholders.get(key) ?? []).join(', ')}].`,
        );
      }
    }
    for (const key of Object.keys(catalog)) {
      if (!(key in reference)) {
        throw new Error(`Catalog "${locale}" has unexpected key "${key}".`);
      }
    }
  }
}

/**
 * Locale negotiation for an Accept-Language header or language-tag list.
 * Supported candidates are ranked by quality, then original order. Returns
 * `undefined` when nothing matches; there is no implicit English fallback.
 */
export function negotiateLocale(
  preference: string | readonly string[] | undefined | null,
): Locale | undefined {
  if (preference === undefined || preference === null) return undefined;
  const tags =
    typeof preference === 'string'
      ? preference.split(',')
      : preference.flatMap((entry) => entry.split(','));

  const candidates: Array<{ locale: Locale; quality: number; order: number }> = [];
  tags.forEach((rawTag, order) => {
    const cleaned = rawTag.trim();
    if (cleaned.length === 0) return;
    const [base, ...params] = cleaned.split(';');
    if (!base) return;
    const qualityParam = params
      .map((param) => param.trim())
      .find((param) => param.startsWith('q='));
    const quality = qualityParam === undefined ? 1 : Number(qualityParam.slice(2));
    if (!Number.isFinite(quality) || quality <= 0 || quality > 1) return;
    const primary = base.trim().split('-')[0]?.toLowerCase() ?? '';
    if (isSupportedLocale(primary)) candidates.push({ locale: primary, quality, order });
  });
  candidates.sort((left, right) => right.quality - left.quality || left.order - right.order);
  return candidates[0]?.locale;
}

export interface Translator {
  readonly locale: Locale;
  (key: MessageKey, variables?: Readonly<Record<string, string | number>>): string;
}

/**
 * Build a translator bound to a specific locale. The returned function
 * throws if the key is unknown for the active locale (no silent fallback)
 * or if a placeholder is missing from the supplied variables. This keeps
 * authoring copy honest: a missing translation or a missing argument is a
 * programmer error, not a UI string.
 */
export function createTranslator(locale: string): Translator {
  assertLocale(locale);
  const catalog = CATALOGS[locale];

  const translate = function translate(
    key: MessageKey,
    variables?: Readonly<Record<string, string | number>>,
  ): string {
    const template = catalog[key];
    if (template === undefined) {
      throw new Error(`Missing message "${key}" for locale "${locale}".`);
    }
    const supplied = variables ?? {};

    const required = new Set(extractPlaceholders(template));
    for (const name of required) {
      if (!Object.prototype.hasOwnProperty.call(supplied, name)) {
        throw new Error(
          `Missing interpolation variable "${name}" for message "${key}" in locale "${locale}".`,
        );
      }
    }

    return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
      if (Object.prototype.hasOwnProperty.call(supplied, name)) {
        return String(supplied[name]);
      }
      return match;
    });
  };

  const translator = translate as Translator;
  Object.defineProperty(translator, 'locale', {
    value: locale,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return Object.freeze(translator);
}

// Fail closed at module load: every English key must also exist in
// Spanish, and vice versa, with identical interpolation placeholders.
assertCatalogParity();