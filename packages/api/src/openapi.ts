/**
 * @cms/api — OpenAPI 3.1 document for the authority surface.
 *
 * The document is a static literal so the wire shape is diff-able.
 * Coverage mirrors the routes registered in `index.ts`; the only
 * `/v1` paths the API implements are:
 *
 *   - GET  /v1/health
 *   - GET  /v1/proposals/{id}
 *   - POST /v1/proposals
 *   - POST /v1/proposals/{id}/approve
 *   - POST /v1/proposals/{id}/publish
 *   - POST /v1/proposals/{id}/rollback
 *   - POST /v1/publications/{id}/deploy-receipts
 *   - POST /v1/proposals/{id}/reconcile
 *
 * All non-2xx responses are `application/problem+json` per RFC 9457.
 * Bearer tokens are audience-bound and tenant-bound; the X-Tenant-Id
 * header scopes every request and must match the token's `tenantId`
 * claim.
 */

import { PROPOSAL_STATE_TO_CONTENT_STATE } from '@cms/core';

import { PROBLEM_LOCALES, problemTypeUrn } from './problem.js';

const PROPOSAL_STATES = Object.freeze(Object.keys(PROPOSAL_STATE_TO_CONTENT_STATE));

// ---------------------------------------------------------------------------
// Document and primitive shapes
// ---------------------------------------------------------------------------

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
    readonly license: { readonly name: string };
  };
  readonly servers: readonly { readonly url: string; readonly description: string }[];
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly paths: Readonly<Record<string, OpenApiPathItem>>;
  readonly components: OpenApiComponents;
  readonly security: readonly { readonly bearerAuth: readonly string[] }[];
}

export interface OpenApiPathItem {
  readonly parameters?: readonly OpenApiParameter[];
  readonly get?: OpenApiOperation;
  readonly post?: OpenApiOperation;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly description: string;
  readonly schema: OpenApiSchema;
}

export interface OpenApiOperation {
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly operationId: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
  readonly security?: readonly { readonly bearerAuth: readonly string[] }[];
}

export interface OpenApiRequestBody {
  readonly required: boolean;
  readonly content: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiResponse {
  readonly description: string;
  readonly headers?: Readonly<Record<string, OpenApiHeader>>;
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiHeader {
  readonly description: string;
  readonly schema: OpenApiSchema;
}

export interface OpenApiMediaType {
  readonly schema: OpenApiSchema;
  readonly example?: unknown;
}

export interface OpenApiComponents {
  readonly schemas: Readonly<Record<string, OpenApiSchema>>;
  readonly parameters: Readonly<Record<string, OpenApiParameter>>;
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
  readonly securitySchemes: Readonly<Record<string, OpenApiSecurityScheme>>;
  readonly headers: Readonly<Record<string, OpenApiHeader>>;
}

export interface OpenApiSecurityScheme {
  readonly type: 'http';
  readonly scheme: 'bearer';
  readonly bearerFormat: string;
  readonly description: string;
}

export type OpenApiSchema =
  | OpenApiPrimitive
  | OpenApiReference
  | OpenApiObject
  | OpenApiArray
  | OpenApiOneOf
  | OpenApiAllOf;

export interface OpenApiPrimitive {
  readonly type?: 'string' | 'integer' | 'number' | 'boolean' | 'null';
  readonly format?: string;
  readonly enum?: readonly (string | number)[];
  readonly description?: string;
  readonly example?: unknown;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly nullable?: boolean;
}

export interface OpenApiReference {
  readonly $ref: string;
}

export interface OpenApiObject {
  readonly type: 'object';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, OpenApiSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface OpenApiArray {
  readonly type: 'array';
  readonly description?: string;
  readonly items: OpenApiSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface OpenApiOneOf {
  readonly oneOf: readonly OpenApiSchema[];
  readonly description?: string;
  readonly discriminator?: { readonly propertyName: string; readonly mapping: Readonly<Record<string, string>> };
}

export interface OpenApiAllOf {
  readonly allOf: readonly OpenApiSchema[];
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Reusable schemas
// ---------------------------------------------------------------------------

const ProblemSchema: OpenApiObject = {
  type: 'object',
  required: ['type', 'title', 'status', 'detail', 'instance', 'code', 'locale', 'extensions'],
  properties: {
    type: { type: 'string', description: 'Stable URN for the problem class.', example: problemTypeUrn('E_INVALID_PROPOSAL') },
    title: { type: 'string' },
    status: { type: 'integer', minimum: 100, maximum: 599 },
    detail: { type: 'string' },
    instance: { type: 'string', format: 'uri' },
    code: { type: 'string', description: 'Stable machine-readable code drawn from the closed union.' },
    locale: { type: 'string', enum: [...PROBLEM_LOCALES] },
    extensions: {
      type: 'object',
      additionalProperties: true,
      properties: {
        traceId: { type: 'string', nullable: true },
        selfApproved: { type: 'boolean', nullable: true },
      },
    },
  },
};

const LocalizedValue: OpenApiObject = {
  type: 'object',
  required: ['en', 'es'],
  properties: {
    en: { type: 'string', minLength: 1 },
    es: { type: 'string', minLength: 1 },
  },
};

const ContentPayload: OpenApiObject = {
  type: 'object',
  required: ['localizedTitle', 'localizedBody', 'canonicalRepoPath'],
  properties: {
    localizedTitle: LocalizedValue,
    localizedBody: LocalizedValue,
    canonicalRepoPath: { type: 'string', pattern: '^[A-Za-z0-9._/-]+$' },
  },
};

const AssetPayload: OpenApiObject = {
  type: 'object',
  required: ['bindingId', 'canonicalRepoPath', 'previewRepoPath'],
  properties: {
    bindingId: { type: 'string', format: 'uuid' },
    canonicalRepoPath: { type: 'string', pattern: '^[A-Za-z0-9._/-]+$' },
    previewRepoPath: { type: 'string', pattern: '^[A-Za-z0-9._/-]+$' },
  },
};

const ProposalCreate: OpenApiObject = {
  type: 'object',
  required: ['regionBindingId', 'slug', 'title', 'proposal'],
  properties: {
    regionBindingId: { type: 'string', format: 'uuid' },
    slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,127}$' },
    title: { type: 'string', minLength: 1, maxLength: 256 },
    proposal: {
      oneOf: [
        {
          type: 'object',
          required: ['kind', 'id', 'tenantId', 'contentType', 'environment', 'action', 'createdAt', 'localizedTitle', 'localizedBody', 'canonicalRepoPath'],
          properties: {
            kind: { type: 'string', enum: ['content'] },
            id: { type: 'string', format: 'uuid' },
            tenantId: { type: 'string', format: 'uuid' },
            contentType: { type: 'string', minLength: 1, maxLength: 64 },
            environment: { type: 'string', enum: ['staging', 'production'] },
            action: { type: 'string', enum: ['create', 'update', 'delete', 'retire'] },
            createdAt: { type: 'string', format: 'date-time' },
            draft: { type: 'boolean' },
            localizedTitle: LocalizedValue,
            localizedBody: LocalizedValue,
            canonicalRepoPath: { type: 'string', pattern: '^[A-Za-z0-9._/-]+$' },
          },
        },
        {
          type: 'object',
          required: ['kind', 'id', 'tenantId', 'contentType', 'environment', 'action', 'createdAt', 'bindingId', 'canonicalRepoPath', 'previewRepoPath'],
          properties: {
            kind: { type: 'string', enum: ['asset'] },
            id: { type: 'string', format: 'uuid' },
            tenantId: { type: 'string', format: 'uuid' },
            contentType: { type: 'string', minLength: 1, maxLength: 64 },
            environment: { type: 'string', enum: ['staging', 'production'] },
            action: { type: 'string', enum: ['create', 'update', 'delete', 'retire'] },
            createdAt: { type: 'string', format: 'date-time' },
            draft: { type: 'boolean' },
            bindingId: { type: 'string', format: 'uuid' },
            canonicalRepoPath: { type: 'string', pattern: '^[A-Za-z0-9._/-]+$' },
            previewRepoPath: { type: 'string', pattern: '^[A-Za-z0-9._/-]+$' },
          },
        },
      ],
    },
  },
};

const Proposal: OpenApiObject = {
  type: 'object',
  required: ['id', 'tenantId', 'regionBindingId', 'slug', 'title', 'state', 'version'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    regionBindingId: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    title: { type: 'string' },
    state: {
      type: 'string',
      enum: PROPOSAL_STATES,
    },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const Approval: OpenApiObject = {
  type: 'object',
  required: ['id', 'proposalId', 'approverActorId', 'selfApproved', 'targetState', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    proposalId: { type: 'string', format: 'uuid' },
    approverActorId: { type: 'string', format: 'uuid' },
    selfApproved: { type: 'boolean' },
    targetState: { type: 'string', enum: ['approved', 'rolled_back'] },
    role: { type: 'string' },
    contentType: { type: 'string' },
    environment: { type: 'string', enum: ['staging', 'production'] },
    note: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const Publication: OpenApiObject = {
  type: 'object',
  required: ['id', 'proposalId', 'canonicalRevisionId', 'status', 'version', 'canonicalWrittenAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    proposalId: { type: 'string', format: 'uuid' },
    canonicalRevisionId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['canonical_written', 'propagating', 'live', 'failed'] },
    canonicalWrittenAt: { type: 'string', format: 'date-time' },
    liveAt: { type: 'string', format: 'date-time', nullable: true },
    failureReason: { type: 'string', nullable: true },
    version: { type: 'integer', minimum: 1 },
    deployReceiptId: { type: 'string', format: 'uuid', nullable: true },
  },
};

const ProposalTransition: OpenApiObject = {
  type: 'object',
  required: ['proposal'],
  properties: {
    proposal: Proposal,
  },
};

// ---------------------------------------------------------------------------
// Reusable parameters
// ---------------------------------------------------------------------------

const TenantIdHeader: OpenApiParameter = {
  name: 'X-Tenant-Id',
  in: 'header',
  required: true,
  description: 'Tenant scope. The bearer token must carry the same tenantId claim.',
  schema: { type: 'string', format: 'uuid' },
};

const AuthorizationHeader: OpenApiParameter = {
  name: 'Authorization',
  in: 'header',
  required: true,
  description: 'Bearer token, audience-bound and tenant-bound.',
  schema: { type: 'string' },
};

const IdempotencyKeyHeader: OpenApiParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'Opaque per-write idempotency key. Max 200 chars; [A-Za-z0-9._:-].',
  schema: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9._:-]+$' },
};

const IfMatchHeader: OpenApiParameter = {
  name: 'If-Match',
  in: 'header',
  required: true,
  description: 'Expected version for optimistic concurrency.',
  schema: { type: 'string' },
};
const AcceptLanguageHeader: OpenApiParameter = {
  name: 'Accept-Language',
  in: 'header',
  required: false,
  description:
    "Preferred peer locale. Omitted defaults to 'en'; a non-empty value without supported 'en' or 'es' language ranges returns E_BAD_LOCALE.",
  schema: { type: 'string' },
};


const ProposalIdParam: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Proposal id (UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const PublicationIdParam: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Publication id (UUID).',
  schema: { type: 'string', format: 'uuid' },
};

const ProblemResponse: OpenApiResponse = {
  description: 'RFC 9457 Problem Details response.',
  content: { 'application/problem+json': { schema: ProblemSchema } },
};
const DeployReceiptResult: OpenApiSchema = {
  type: 'object',
  required: ['deploy_receipt', 'proposal'],
  properties: {
    deploy_receipt: { type: 'object', additionalProperties: true },
    proposal: Proposal,
  },
};


function jsonResponse(description: string, schema: OpenApiSchema): OpenApiResponse {
  return { description, content: { 'application/json': { schema } } };
}

function problemResponses(successStatus: number, successSchema: OpenApiSchema): Readonly<Record<string, OpenApiResponse>> {
  return {
    [String(successStatus)]: jsonResponse('Successful response.', successSchema),
    '400': ProblemResponse,
    '401': ProblemResponse,
    '403': ProblemResponse,
    '404': ProblemResponse,
    '409': ProblemResponse,
    '422': ProblemResponse,
    '428': ProblemResponse,
    '500': ProblemResponse,
  };
}

// ---------------------------------------------------------------------------
// Final document
// ---------------------------------------------------------------------------

export const openApiDocument: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Handoff CMS Authority API',
    version: '0.1.0',
    description:
      'Authoritative transport over @cms/core and @cms/storage. Agents propose; humans approve, ' +
      'publish, and roll back. Service and MCP identities never approve or publish. ' +
      'Canonical-written and live-propagated deploy states are distinct.',
    license: { name: 'Apache-2.0' },
  },
  servers: [{ url: '/', description: 'Same-origin.' }],
  tags: [
    { name: 'health', description: 'Liveness probe.' },
    { name: 'proposals', description: 'Propose, approve, publish, rollback.' },
    { name: 'deploys', description: 'Host deployment receipts and reconciliation.' },
  ],
  paths: {
    '/v1/health': {
      parameters: [AcceptLanguageHeader],
      get: {
        summary: 'Liveness probe (unauthenticated)',
        description:
          'Returns 200 with `{ status: "ok" }` if the API process is alive. This endpoint is the only route in the authority surface that does not require an `Authorization` header or an `X-Tenant-Id` header. The response echoes the negotiated locale (`en` or `es`) so the same probe works for both peers.',
        tags: ['health'],
        operationId: 'getHealth',
        security: [],
        responses: {
          '200': jsonResponse('Service is alive.', {
            type: 'object',
            required: ['status', 'service', 'locale'],
            properties: {
              status: { type: 'string', enum: ['ok'] },
              service: { type: 'string' },
              locale: { type: 'string', enum: ['en', 'es'] },
            },
          }),
          '400': ProblemResponse,
        },
      },
    },
    '/v1/proposals': {
      parameters: [TenantIdHeader, AuthorizationHeader, IdempotencyKeyHeader, AcceptLanguageHeader],
      post: {
        summary: 'Create a proposal',
        description:
          'Proposes a content or asset change. Any identity may propose; the policy engine ' +
          'verifies the actor holds a `propose` grant covering the content type, environment, and ' +
          'required capabilities. Returns the persisted proposal row.',
        tags: ['proposals'],
        operationId: 'createProposal',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ProposalCreate } },
        },
        responses: problemResponses(201, Proposal),
      },
    },
    '/v1/proposals/{id}': {
      parameters: [TenantIdHeader, AuthorizationHeader, ProposalIdParam, AcceptLanguageHeader],
      get: {
        summary: 'Fetch a proposal',
        description: 'Returns the proposal row. Tenants are isolated; cross-tenant reads 404.',
        tags: ['proposals'],
        operationId: 'getProposal',
        responses: problemResponses(200, Proposal),
      },
    },
    '/v1/proposals/{id}/approve': {
      parameters: [TenantIdHeader, AuthorizationHeader, IdempotencyKeyHeader, IfMatchHeader, ProposalIdParam, AcceptLanguageHeader],
      post: {
        summary: 'Approve a proposal (human only)',
        description:
          'Records an approval. Service and MCP identities are refused before the policy engine. ' +
          'If the proposer is the same human, `selfApproved: true` is recorded; the policy engine ' +
          'decides whether the same human is allowed to perform the second transition. The previous ' +
          'and next governance states are returned in the body.',
        tags: ['proposals'],
        operationId: 'approveProposal',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ProposalTransition } },
        },
        responses: problemResponses(200, Approval),
      },
    },
    '/v1/proposals/{id}/publish': {
      parameters: [TenantIdHeader, AuthorizationHeader, IdempotencyKeyHeader, IfMatchHeader, ProposalIdParam, AcceptLanguageHeader],
      post: {
        summary: 'Publish a proposal (human only)',
        description:
          'Drives the canonical_written transition. The publication row is created; the live ' +
          'propagation beat is recorded separately via deploy receipts and never conflated with the ' +
          'canonical write.',
        tags: ['proposals'],
        operationId: 'publishProposal',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ProposalTransition } },
        },
        responses: problemResponses(200, Publication),
      },
    },
    '/v1/proposals/{id}/rollback': {
      parameters: [TenantIdHeader, AuthorizationHeader, IdempotencyKeyHeader, IfMatchHeader, ProposalIdParam, AcceptLanguageHeader],
      post: {
        summary: 'Rollback a proposal (human only, single action)',
        description:
          'The single rollback click. The current policy-engine check must pass for the clicking ' +
          'operator. Reused authority is the captured approval-time capability scope; this is not a ' +
          'credential replay and not original-approver impersonation.',
        tags: ['proposals'],
        operationId: 'rollbackProposal',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ProposalTransition } },
        },
        responses: problemResponses(200, Proposal),
      },
    },
    '/v1/publications/{id}/deploy-receipts': {
      parameters: [TenantIdHeader, AuthorizationHeader, IdempotencyKeyHeader, PublicationIdParam, AcceptLanguageHeader],
      post: {
        summary: 'Record a host deployment receipt (coordinator-gated, adapter-owned)',
        description:
          'Records pending, succeeded, or failed host propagation separately from the canonical write and advances the proposal deployment state. ' +
          'Authority: the authenticated caller must have `identity.id === adapterId` and carry the narrowly scoped provisional `deploy.receipt` capability. ' +
          'A dedicated adapter service may report deployment state; this is not an approve, publish, apply, or rollback authority. ' +
          'On `status="failed"` the publication transitions to `failed`. A proposal still at `canonical_written` remains there because @cms/core has no direct `canonical_written + propagate -> propagate_failed` edge; a proposal already at `propagating` transitions to `deploy_failed`.',
        tags: ['deploys'],
        operationId: 'recordDeployReceipt',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: [
                  'proposalId',
                  'adapterId',
                  'externalDeployId',
                  'status',
                  'publicationVersion',
                ],
                properties: {
                  proposalId: { type: 'string' },
                  adapterId: { type: 'string' },
                  externalDeployId: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'succeeded', 'failed'] },
                  publicationVersion: { type: 'integer', minimum: 1 },
                  liveUrl: { type: 'string', format: 'uri' },
                  failureReason: { type: 'string' },
                  payload: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          ...problemResponses(200, DeployReceiptResult),
          '202': jsonResponse('Pending deployment receipt accepted.', DeployReceiptResult),
        },
      },
    },
    '/v1/proposals/{id}/reconcile': {
      parameters: [TenantIdHeader, AuthorizationHeader, IdempotencyKeyHeader, IfMatchHeader, ProposalIdParam, AcceptLanguageHeader],
      post: {
        summary: 'Reconcile live host state (human only)',
        description:
          'Records successful reconciliation or an explicit reconciliation failure after a live receipt. ' +
          'Authority: the calling identity must be a current human (service and MCP identities are refused). ' +
          'A tighter publication-owner binding is an explicit integration blocker: the storage schema must ' +
          'grow a `publication_owner_actor_id` column and a corresponding `IdentityResolver.loadPublicationOwner` ' +
          'hook before per-publication ownership can be enforced.',
        tags: ['deploys'],
        operationId: 'reconcileProposal',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['success'],
                properties: { success: { type: 'boolean' } },
              },
            },
          },
        },
        responses: problemResponses(200, Proposal),
      },
    },
  },
  components: {
    schemas: {
      Problem: ProblemSchema,
      Proposal,
      ProposalCreate,
      Approval,
      Publication,
      ContentPayload,
      AssetPayload,
    },
    parameters: {
      TenantId: TenantIdHeader,
      Authorization: AuthorizationHeader,
      IdempotencyKey: IdempotencyKeyHeader,
      IfMatch: IfMatchHeader,
    },
    responses: {
      Problem: ProblemResponse,
    },
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Audience-bound and tenant-bound bearer token. MCP delegated sessions are valid.',
      },
    },
    headers: {
      'Idempotency-Key': {
        description: 'Echoes the request idempotency key for replays.',
        schema: { type: 'string' },
      },
    },
  },
  security: [{ bearerAuth: [] }],
};

