import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { ZodType } from 'zod';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  assetDetailSchema,
  assetIncidentSchema,
  assetOptionsSchema,
  assetSchema,
  closeIncidentSchema,
  createAssetSchema,
  importAssetsSchema,
  importResultSchema,
  issueAssetSchema,
  kitCheckSchema,
  moveAssetSchema,
  reportIncidentSchema,
  returnAssetSchema,
  setAssetStatusSchema,
  transferAssetSchema,
  updateAssetSchema,
} from './assets.schema.js';

/** Register one OPS path: tag, bearer auth, the usual error responses. */
export const opsPath = (
  registry: OpenAPIRegistry,
  method: 'get' | 'post' | 'patch' | 'put',
  path: string,
  summary: string,
  response: ZodType,
  body?: ZodType,
): void => {
  registry.registerPath({
    method,
    path,
    tags: ['OPS'],
    summary,
    security: [{ bearerAuth: [] }],
    ...(body ? { request: { body: jsonBody(body) } } : {}),
    responses: {
      [method === 'post' && !path.includes('{') ? 201 : 200]: jsonResponse(
        'OK',
        response,
      ),
      401: errorResponse('Not authenticated'),
      403: errorResponse('No access'),
      404: errorResponse('Not found'),
      409: errorResponse('The item is not in a state that allows this'),
      422: errorResponse('Invalid for this item'),
    },
  });
};

/** OpenAPI registration for the asset-register endpoints. */
export const registerAssetsDocs = (registry: OpenAPIRegistry): void => {
  const p = (
    ...a: Parameters<typeof opsPath> extends [unknown, ...infer R] ? R : never
  ) => opsPath(registry, ...a);
  p(
    'get',
    '/api/v1/assets/options',
    'Categories, zones and people for the forms',
    assetOptionsSchema,
  );
  p(
    'get',
    '/api/v1/assets',
    'The register (?holderId= for one person)',
    z.array(assetSchema),
  );
  p(
    'get',
    '/api/v1/assets/incidents',
    'Damage / loss / theft incidents',
    z.array(assetIncidentSchema),
  );
  p(
    'post',
    '/api/v1/assets/incidents/{id}/close',
    'Close an incident (loss / theft may mark the asset lost)',
    assetDetailSchema,
    closeIncidentSchema,
  );
  p(
    'get',
    '/api/v1/assets/kit-check/{employeeId}',
    'Joiner kit vs holdings',
    kitCheckSchema,
  );
  p(
    'post',
    '/api/v1/assets/import',
    'Import CSV rows (dryRun checks only)',
    importResultSchema,
    importAssetsSchema,
  );
  p('post', '/api/v1/assets', 'Register an asset', assetSchema, createAssetSchema);
  p('get', '/api/v1/assets/{id}', 'Asset detail with history', assetDetailSchema);
  p('patch', '/api/v1/assets/{id}', 'Edit asset details', assetSchema, updateAssetSchema);
  p(
    'post',
    '/api/v1/assets/{id}/issue',
    'Issue to a person (lab: with a due date)',
    assetSchema,
    issueAssetSchema,
  );
  p(
    'post',
    '/api/v1/assets/{id}/return',
    'Take back from the holder',
    assetSchema,
    returnAssetSchema,
  );
  p(
    'post',
    '/api/v1/assets/{id}/transfer',
    'Hand over to another person',
    assetSchema,
    transferAssetSchema,
  );
  p(
    'post',
    '/api/v1/assets/{id}/move',
    'Move to another zone',
    assetSchema,
    moveAssetSchema,
  );
  p(
    'post',
    '/api/v1/assets/{id}/status',
    'Set idle / shared / repair / scrapped / gifted',
    assetSchema,
    setAssetStatusSchema,
  );
  p(
    'post',
    '/api/v1/assets/{id}/incidents',
    'Record damage / loss / theft',
    assetDetailSchema,
    reportIncidentSchema,
  );
};
