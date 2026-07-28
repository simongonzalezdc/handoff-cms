/**
 * @cms/api — RFC 9457 Problem Details (application/problem+json).
 *
 * Every non-2xx response is a `Problem`. The body carries:
 *   - `type`   — stable URN `urn:cms:problem:<scope>:<code>`
 *   - `title`  — short, locale-localized
 *   - `status` — HTTP status, mirrored in the response line
 *   - `detail` — human-readable, locale-localized
 *   - `instance` — the request URL
 *   - `code`   — the stable machine code (closed union across core,
 *                storage, api)
 *   - `locale` — the resolved peer locale (`en` or `es`)
 *   - `extensions` — opaque pass-through; structured `errors[]` for
 *                    per-field validation never interpolates user data
 *                    into the message.
 *
 * No interpolation of caller data into the catalog messages. Per-field
 * values are carried in the `errors[]` extension. The catalog is closed:
 * adding a code to any of the three unions requires adding localized
 * entries for both `en` and `es` here.
 */

import {
  DomainInvariantError,
  ERROR_CODES,
  InvalidTransitionError,
  PolicyDeniedError,
  type ErrorCode as CoreErrorCode,
  type Locale,
} from '@cms/core';
import { StorageError, type StorageErrorCode } from '@cms/storage';
import { AuthorizationError } from './auth.js';

// ---------------------------------------------------------------------------
// API-scope codes (closed union)
// ---------------------------------------------------------------------------

export const API_ERROR_CODES = [
  'E_BAD_REQUEST',
  'E_UNSUPPORTED_MEDIA_TYPE',
  'E_PAYLOAD_TOO_LARGE',
  'E_IDEMPOTENCY_KEY_REQUIRED',
  'E_IDEMPOTENCY_KEY_MALFORMED',
  'E_IDEMPOTENCY_REPLAY_MISMATCH',
  'E_IDEMPOTENCY_IN_PROGRESS',
  'E_OPTIMISTIC_CONCURRENCY_CONFLICT',
  'E_VERSION_HEADER_REQUIRED',
  'E_UNAUTHORIZED',
  'E_TOKEN_MISSING',
  'E_TOKEN_MALFORMED',
  'E_TOKEN_EXPIRED',
  'E_TOKEN_AUDIENCE_MISMATCH',
  'E_SERVICE_APPROVAL_FORBIDDEN',
  'E_MCP_APPROVAL_FORBIDDEN',
  'E_DELEGATION_EXPIRED',
  'E_TENANT_HEADER_REQUIRED',
  'E_TENANT_FORBIDDEN',
  'E_INTERNAL',
] as const;
Object.freeze(API_ERROR_CODES);

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Closed problem code (union of all three scopes)
// ---------------------------------------------------------------------------

export type ProblemCode = CoreErrorCode | StorageErrorCode | ApiErrorCode;
export type ProblemCodeScope = 'core' | 'storage' | 'api';

const CORE_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);
const STORAGE_CODE_SET: ReadonlySet<string> = new Set<string>([
  'not_found',
  'tenant_disabled',
  'idempotency_replay_mismatch',
  'idempotency_in_progress',
  'optimistic_concurrency_conflict',
  'unique_violation',
  'foreign_key_violation',
  'check_violation',
  'append_only_violation',
  'invalid_input',
  'transaction_aborted',
  'connection_failed',
  'unsupported',
]);

export function problemCodeScope(code: ProblemCode): ProblemCodeScope {
  if (CORE_CODE_SET.has(code)) return 'core';
  if (STORAGE_CODE_SET.has(code)) return 'storage';
  return 'api';
}

export function problemTypeUrn(code: ProblemCode): string {
  return `urn:cms:problem:${problemCodeScope(code)}:${code}`;
}

// ---------------------------------------------------------------------------
// Localized problem catalog
// ---------------------------------------------------------------------------

export interface ProblemMessage {
  readonly title: string;
  readonly detail: string;
}

function entry(title: string, detail: string): ProblemMessage {
  return { title, detail };
}

function defaultEntry(code: string): ProblemMessage {
  const title = code.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  return entry(title, `Governance refusal: ${code}.`);
}

const MESSAGES_EN: Record<ProblemCode, ProblemMessage> = (() => {
  const out = {} as Record<ProblemCode, ProblemMessage>;
  for (const code of ERROR_CODES) out[code] = defaultEntry(code);
  for (const code of STORAGE_CODE_SET) {
    if (!(code in out)) out[code as ProblemCode] = defaultEntry(code);
  }
  for (const code of API_ERROR_CODES) out[code] = defaultEntry(code);
  // Hand-curated overrides for the high-traffic API codes.
  out.E_BAD_REQUEST = entry('Bad request', 'The request body or query parameters are malformed.');
  out.E_UNSUPPORTED_MEDIA_TYPE = entry('Unsupported media type', 'The request Content-Type is not accepted on this endpoint.');
  out.E_PAYLOAD_TOO_LARGE = entry('Payload too large', 'The request body exceeds the configured maximum size.');
  out.E_IDEMPOTENCY_KEY_REQUIRED = entry('Idempotency-Key required', 'Writes require an Idempotency-Key header.');
  out.E_IDEMPOTENCY_KEY_MALFORMED = entry('Idempotency-Key malformed', 'The Idempotency-Key header is not a well-formed opaque token.');
  out.E_IDEMPOTENCY_REPLAY_MISMATCH = entry('Idempotency replay mismatch', 'The same Idempotency-Key was replayed with a different request fingerprint.');
  out.E_IDEMPOTENCY_IN_PROGRESS = entry('Idempotency key in progress', 'A previous attempt with this Idempotency-Key is still in progress.');
  out.E_OPTIMISTIC_CONCURRENCY_CONFLICT = entry('Version conflict', 'The expected If-Match version is stale; re-read the resource and retry.');
  out.E_VERSION_HEADER_REQUIRED = entry('If-Match required', 'This endpoint requires an If-Match header for optimistic concurrency.');
  out.E_UNAUTHORIZED = entry('Unauthorized', 'The request did not present a valid credential.');
  out.E_TOKEN_MISSING = entry('Token missing', 'The Authorization header is missing or empty.');
  out.E_TOKEN_MALFORMED = entry('Token malformed', 'The bearer token could not be verified.');
  out.E_TOKEN_EXPIRED = entry('Token expired', 'The bearer token is past its exp claim; refresh and retry.');
  out.E_TOKEN_AUDIENCE_MISMATCH = entry('Token audience mismatch', 'The token audience does not match the API audience.');
  out.E_SERVICE_APPROVAL_FORBIDDEN = entry('Service identity forbidden', 'Approve, publish, and rollback require a current human authorization event.');
  out.E_MCP_APPROVAL_FORBIDDEN = entry('MCP identity forbidden', 'MCP-capable identities are agents and may not exercise approval or publication authority.');
  out.E_DELEGATION_EXPIRED = entry('Delegation expired', 'The delegating human session has expired; obtain a fresh delegation.');
  out.E_TENANT_HEADER_REQUIRED = entry('X-Tenant-Id required', 'The X-Tenant-Id header is required for every multi-tenant request.');
  out.E_TENANT_FORBIDDEN = entry('Tenant forbidden', 'The resolved identity is not authorized to operate on the requested tenant.');
  out.E_INTERNAL = entry('Internal server error', 'An unexpected error occurred. The trace identifier is in the response extension.');
  return out;
})();

const MESSAGES_ES: Record<ProblemCode, ProblemMessage> = (() => {
  const out: Record<string, ProblemMessage> = {};
  for (const code of Object.keys(MESSAGES_EN)) {
    out[code] = entry(
      'Operación rechazada',
      `La operación se rechazó con el código ${code}.`,
    );
  }
  out.E_BAD_TIMESTAMP = entry('Fecha y hora no válidas', 'La fecha y hora debe usar un formato ISO 8601 válido.');
  out.E_BAD_HASH = entry('Huella no válida', 'La huella criptográfica no tiene el formato requerido.');
  out.E_BAD_LOCALE = entry('Idioma no válido', 'El idioma solicitado no está disponible.');
  out.E_BAD_PATH = entry('Ruta no válida', 'La ruta no cumple las reglas del repositorio.');
  out.E_ABSOLUTE_PATH = entry('Ruta absoluta prohibida', 'Las rutas deben ser relativas al repositorio.');
  out.E_ESCAPING_PATH = entry('Ruta fuera del repositorio', 'La ruta intenta salir del repositorio.');
  out.E_INVALID_IDENTITY = entry('Identidad no válida', 'La identidad no cumple el contrato de autorización.');
  out.E_INSUFFICIENT_AUTHORITY = entry('Autoridad insuficiente', 'La identidad no tiene autoridad vigente para esta acción.');
  out.E_SELF_APPROVAL_FORBIDDEN = entry('Autoaprobación prohibida', 'La política vigente no permite aprobar esta propuesta propia.');
  out.E_FIELD_CAPABILITY_MISSING = entry('Falta una capacidad', 'La identidad no tiene todas las capacidades requeridas.');
  out.E_ROLE_MISMATCH = entry('Rol no autorizado', 'Ningún rol vigente cubre esta acción.');
  out.E_CONTENT_TYPE_MISMATCH = entry('Tipo de contenido no autorizado', 'La autorización no cubre este tipo de contenido.');
  out.E_ENVIRONMENT_MISMATCH = entry('Entorno no autorizado', 'La autorización no cubre este entorno.');
  out.E_ACTION_FORBIDDEN = entry('Acción prohibida', 'La política vigente prohíbe esta acción.');
  out.E_INVALID_TRANSITION = entry('Transición no válida', 'El recurso no puede realizar esa transición desde su estado actual.');
  out.E_ROLLBACK_WINDOW_EXPIRED = entry('Plazo de reversión vencido', 'La ventana autorizada para revertir ya venció.');
  out.E_FROZEN_VIOLATION = entry('Recurso inmutable', 'El recurso aprobado no puede modificarse de esta manera.');
  out.E_MISSING_LOCALE = entry('Falta un idioma', 'El contenido debe incluir valores en inglés y español.');
  out.E_INVALID_PROPOSAL = entry('Propuesta no válida', 'La propuesta no cumple los invariantes del dominio.');
  out.E_INVALID_REVISION = entry('Revisión no válida', 'La revisión no cumple los invariantes del dominio.');
  out.not_found = entry('No encontrado', 'El recurso solicitado no existe en este inquilino.');
  out.tenant_disabled = entry('Inquilino deshabilitado', 'Este inquilino está deshabilitado y no admite escrituras.');
  out.idempotency_replay_mismatch = entry('Reutilización de idempotencia no válida', 'La clave se reutilizó con una solicitud diferente.');
  out.idempotency_in_progress = entry('Operación en curso', 'Ya existe un intento en curso con esta clave de idempotencia.');
  out.optimistic_concurrency_conflict = entry('Conflicto de versión', 'La versión esperada está desactualizada.');
  out.unique_violation = entry('Valor duplicado', 'El valor ya existe donde debe ser único.');
  out.foreign_key_violation = entry('Referencia no válida', 'La operación hace referencia a un recurso inexistente.');
  out.check_violation = entry('Restricción incumplida', 'Los datos no cumplen una restricción de almacenamiento.');
  out.append_only_violation = entry('Registro inmutable', 'El registro de auditoría solo permite añadir eventos.');
  out.invalid_input = entry('Entrada no válida', 'El almacenamiento rechazó los datos de entrada.');
  out.transaction_aborted = entry('Transacción cancelada', 'La transacción se canceló sin aplicar cambios parciales.');
  out.connection_failed = entry('Conexión no disponible', 'No se pudo conectar al almacenamiento.');
  out.unsupported = entry('Operación no admitida', 'El almacenamiento no admite esta operación.');
  out.E_BAD_REQUEST = entry('Solicitud incorrecta', 'El cuerpo o los parámetros de la solicitud están mal formados.');
  out.E_UNSUPPORTED_MEDIA_TYPE = entry('Tipo de medio no admitido', 'El Content-Type de la solicitud no se admite en este endpoint.');
  out.E_PAYLOAD_TOO_LARGE = entry('Carga demasiado grande', 'El cuerpo de la solicitud excede el tamaño máximo configurado.');
  out.E_IDEMPOTENCY_KEY_REQUIRED = entry('Se requiere Idempotency-Key', 'Las escrituras requieren la cabecera Idempotency-Key.');
  out.E_IDEMPOTENCY_KEY_MALFORMED = entry('Idempotency-Key mal formada', 'La cabecera Idempotency-Key no es un token opaco bien formado.');
  out.E_IDEMPOTENCY_REPLAY_MISMATCH = entry('Reutilización de idempotencia con cuerpo distinto', 'La misma Idempotency-Key se reutilizó con una huella de solicitud diferente.');
  out.E_IDEMPOTENCY_IN_PROGRESS = entry('Clave de idempotencia en curso', 'Un intento previo con esta Idempotency-Key sigue en curso.');
  out.E_OPTIMISTIC_CONCURRENCY_CONFLICT = entry('Conflicto de versión', 'La versión If-Match esperada está desactualizada; vuelva a leer y reintente.');
  out.E_VERSION_HEADER_REQUIRED = entry('Se requiere If-Match', 'Este endpoint requiere la cabecera If-Match para la concurrencia optimista.');
  out.E_UNAUTHORIZED = entry('No autorizado', 'La solicitud no presentó una credencial válida.');
  out.E_TOKEN_MISSING = entry('Token ausente', 'La cabecera Authorization falta o está vacía.');
  out.E_TOKEN_MALFORMED = entry('Token mal formado', 'No se pudo verificar el token bearer.');
  out.E_TOKEN_EXPIRED = entry('Token expirado', 'El token bearer está expirado; renueve y reintente.');
  out.E_TOKEN_AUDIENCE_MISMATCH = entry('Audiencia de token incorrecta', 'La audiencia del token no coincide con la audiencia de la API.');
  out.E_SERVICE_APPROVAL_FORBIDDEN = entry('Identidad de servicio prohibida', 'Aprobar, publicar y revertir requieren un evento de autorización humana vigente.');
  out.E_MCP_APPROVAL_FORBIDDEN = entry('Identidad MCP prohibida', 'Las identidades con capacidad MCP son agentes y no pueden aprobar ni publicar.');
  out.E_DELEGATION_EXPIRED = entry('Delegación expirada', 'La sesión humana que delega ha expirado; obtenga una nueva delegación.');
  out.E_TENANT_HEADER_REQUIRED = entry('Se requiere X-Tenant-Id', 'La cabecera X-Tenant-Id es obligatoria en cada solicitud multi-inquilino.');
  out.E_TENANT_FORBIDDEN = entry('Inquilino prohibido', 'La identidad resuelta no está autorizada a operar sobre el inquilino solicitado.');
  out.E_INTERNAL = entry('Error interno del servidor', 'Ocurrió un error inesperado. El identificador de traza está en la extensión.');
  return out as Record<ProblemCode, ProblemMessage>;
})();

const MESSAGES: Readonly<Record<Locale, Readonly<Record<ProblemCode, ProblemMessage>>>> = Object.freeze({
  en: MESSAGES_EN,
  es: MESSAGES_ES,
});

export function messageFor(code: ProblemCode, locale: Locale): ProblemMessage {
  const bundle = MESSAGES[locale] ?? MESSAGES.en;
  return bundle[code] ?? bundle.E_INTERNAL;
}

export const PROBLEM_LOCALES: readonly Locale[] = Object.freeze(['en', 'es']);

export function isSupportedLocale(value: string): value is Locale {
  return value === 'en' || value === 'es';
}

export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (typeof acceptLanguage !== 'string' || acceptLanguage.length === 0) return 'en';
  for (const entry$ of acceptLanguage.split(',')) {
    const primary = entry$.split(';')[0]?.trim().split('-')[0]?.toLowerCase() ?? '';
    if (isSupportedLocale(primary)) return primary;
  }
  return 'en';
}

// ---------------------------------------------------------------------------
// Problem shape (RFC 9457)
// ---------------------------------------------------------------------------

export interface FieldError {
  readonly pointer: string;
  readonly code: ProblemCode;
  readonly message: string;
  readonly value?: unknown;
}

export interface ProblemExtensions {
  readonly tenantId?: string;
  readonly proposalId?: string;
  readonly approvalId?: string;
  readonly publicationId?: string;
  readonly deployReceiptId?: string;
  readonly revisionId?: string;
  readonly idempotencyKey?: string;
  readonly locale?: Locale;
  readonly selfApproved?: boolean;
  readonly traceId?: string;
  readonly errors?: readonly FieldError[];
  readonly [k: string]: unknown;
}

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: ProblemCode;
  readonly locale: Locale;
  readonly extensions: ProblemExtensions;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

const STATUS_FOR_CORE: Record<CoreErrorCode, number> = {
  E_BAD_TIMESTAMP: 400,
  E_BAD_HASH: 400,
  E_BAD_LOCALE: 400,
  E_BAD_PATH: 400,
  E_ABSOLUTE_PATH: 400,
  E_ESCAPING_PATH: 400,
  E_SELF_ALIAS: 400,
  E_CYCLIC_ALIAS: 400,
  E_AMBIGUOUS_CANONICAL: 409,
  E_BAD_REGENERATION_MODE: 400,
  E_EMPTY_DERIVED_ARTIFACTS: 400,
  E_INVALID_IDENTITY: 400,
  E_SERVICE_APPROVAL_FORBIDDEN: 403,
  E_MCP_APPROVAL_FORBIDDEN: 403,
  E_SELF_APPROVAL_FORBIDDEN: 403,
  E_INSUFFICIENT_AUTHORITY: 403,
  E_FIELD_CAPABILITY_MISSING: 403,
  E_ROLE_MISMATCH: 403,
  E_CONTENT_TYPE_MISMATCH: 403,
  E_ENVIRONMENT_MISMATCH: 403,
  E_ACTION_FORBIDDEN: 403,
  E_INVALID_TRANSITION: 409,
  E_ROLLBACK_WINDOW_EXPIRED: 409,
  E_FROZEN_VIOLATION: 409,
  E_MISSING_LOCALE: 422,
  E_INVALID_PROPOSAL: 422,
  E_INVALID_REVISION: 422,
};

const STATUS_FOR_STORAGE: Record<StorageErrorCode, number> = {
  not_found: 404,
  tenant_disabled: 409,
  idempotency_replay_mismatch: 409,
  idempotency_in_progress: 409,
  optimistic_concurrency_conflict: 409,
  unique_violation: 409,
  foreign_key_violation: 409,
  check_violation: 409,
  append_only_violation: 409,
  invalid_input: 400,
  transaction_aborted: 500,
  connection_failed: 503,
  unsupported: 501,
};

const STATUS_FOR_API: Record<ApiErrorCode, number> = {
  E_BAD_REQUEST: 400,
  E_UNSUPPORTED_MEDIA_TYPE: 415,
  E_PAYLOAD_TOO_LARGE: 413,
  E_IDEMPOTENCY_KEY_REQUIRED: 400,
  E_IDEMPOTENCY_KEY_MALFORMED: 400,
  E_IDEMPOTENCY_REPLAY_MISMATCH: 409,
  E_IDEMPOTENCY_IN_PROGRESS: 409,
  E_OPTIMISTIC_CONCURRENCY_CONFLICT: 409,
  E_VERSION_HEADER_REQUIRED: 428,
  E_UNAUTHORIZED: 401,
  E_TOKEN_MISSING: 401,
  E_TOKEN_MALFORMED: 401,
  E_TOKEN_EXPIRED: 401,
  E_TOKEN_AUDIENCE_MISMATCH: 401,
  E_SERVICE_APPROVAL_FORBIDDEN: 403,
  E_MCP_APPROVAL_FORBIDDEN: 403,
  E_DELEGATION_EXPIRED: 403,
  E_TENANT_HEADER_REQUIRED: 400,
  E_TENANT_FORBIDDEN: 403,
  E_INTERNAL: 500,
};

const STATUS_FOR: Readonly<Record<ProblemCode, number>> = Object.freeze({
  ...STATUS_FOR_CORE,
  ...STATUS_FOR_STORAGE,
  ...STATUS_FOR_API,
});

export function statusFor(code: ProblemCode): number {
  return STATUS_FOR[code];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface BuildProblemInput {
  readonly code: ProblemCode;
  readonly instance: string;
  readonly locale: Locale;
  readonly extensions?: ProblemExtensions;
  readonly detailOverride?: string;
  readonly statusOverride?: number;
}


export function buildProblem(input: BuildProblemInput): Problem {
  const message = messageFor(input.code, input.locale);
  return {
    type: problemTypeUrn(input.code),
    title: message.title,
    status: input.statusOverride ?? statusFor(input.code),
    detail: input.detailOverride ?? message.detail,
    instance: input.instance,
    code: input.code,
    locale: input.locale,
    extensions: input.extensions ?? {},
  };
}

export function problemFromError(
  err: unknown,
  locale: Locale,
  instance: string,
  traceId?: string,
): Problem {
  if (err instanceof AuthorizationError) {
    const base: ProblemExtensions = { traceId: traceId ?? '' };
    return buildProblem({
      code: err.code,
      instance,
      locale,
      extensions:
        err.extensions === undefined || Object.keys(err.extensions).length === 0
          ? base
          : { ...base, ...err.extensions },
    });
  }
  if (
    err instanceof PolicyDeniedError ||
    err instanceof DomainInvariantError ||
    err instanceof InvalidTransitionError
  ) {
    return buildProblem({ code: err.code, instance, locale, extensions: { traceId: traceId ?? '' } });
  }
  if (err instanceof StorageError) {
    const base: ProblemExtensions = { traceId: traceId ?? '' };
    return buildProblem({
      code: err.code,
      instance,
      locale,
      extensions: err.detail === undefined ? base : { ...base, storageDetail: err.detail },
    });
  }
  return buildProblem({ code: 'E_INTERNAL', instance, locale, extensions: { traceId: traceId ?? '' } });
}
