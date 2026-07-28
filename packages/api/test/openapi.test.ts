import { PROPOSAL_STATE_TO_CONTENT_STATE } from '@cms/core';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/openapi.js';

describe('OpenAPI source-derived contracts', () => {
  it('enumerates exactly the persisted proposal states emitted by the API', () => {
    const proposalSchema = openApiDocument.components.schemas.Proposal as {
      properties: { state: { enum: readonly string[] } };
    };

    expect(proposalSchema.properties.state.enum).toEqual(Object.keys(PROPOSAL_STATE_TO_CONTENT_STATE));
    expect(proposalSchema.properties.state.enum).toEqual([
      'draft',
      'proposed',
      'validated',
      'previewing',
      'approved',
      'applying',
      'canonical_written',
      'propagating',
      'live',
      'reconciled',
      'apply_failed',
      'deploy_pending',
      'deploy_failed',
      'reconcile_pending',
      'rolled_back',
      'refused',
    ]);
  });

  it('documents peer-locale negotiation and the health failure surface', () => {
    const paths = openApiDocument.paths as Record<
      string,
      {
        parameters?: readonly { name?: string }[];
        get?: {
          responses?: Record<string, unknown>;
        };
      }
    >;

    for (const path of Object.values(paths)) {
      expect(path.parameters?.some((parameter) => parameter.name === 'Accept-Language')).toBe(true);
    }

    const health = paths['/v1/health'];
    expect(health?.get?.responses).toHaveProperty('400');
    const deployReceipt = paths['/v1/publications/{id}/deploy-receipts'] as {
      post?: { responses?: Record<string, unknown> };
    };
    expect(deployReceipt.post?.responses).toHaveProperty('200');
    expect(deployReceipt.post?.responses).toHaveProperty('202');

    const success = health?.get?.responses?.['200'] as {
      content: {
        'application/json': {
          schema: { required: readonly string[] };
        };
      };
    };
    expect(success.content['application/json'].schema.required).toEqual([
      'status',
      'service',
      'locale',
    ]);
  });
});
