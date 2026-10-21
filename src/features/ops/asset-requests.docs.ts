import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from '../../shared/zod.js';
import {
  assetRequestSchema,
  createAssetRequestSchema,
  fulfilAssetRequestSchema,
  updateAssetRequestSchema,
} from './asset-requests.schema.js';
import { opsPath } from './assets.docs.js';

/** OpenAPI registration for the asset-request endpoints. */
export const registerAssetRequestsDocs = (registry: OpenAPIRegistry): void => {
  opsPath(
    registry,
    'get',
    '/api/v1/asset-requests',
    'The OPS request queue',
    z.array(assetRequestSchema),
  );
  opsPath(
    registry,
    'get',
    '/api/v1/asset-requests/mine',
    'My asset requests',
    z.array(assetRequestSchema),
  );
  opsPath(
    registry,
    'post',
    '/api/v1/asset-requests',
    'Ask OPS for a new asset, upgrade, replacement, repair or return',
    assetRequestSchema,
    createAssetRequestSchema,
  );
  opsPath(
    registry,
    'patch',
    '/api/v1/asset-requests/{id}',
    'Pick up or decline a request',
    assetRequestSchema,
    updateAssetRequestSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/asset-requests/{id}/fulfil',
    'Fulfil: issue the new item and / or take the old one back',
    assetRequestSchema,
    fulfilAssetRequestSchema,
  );
};
