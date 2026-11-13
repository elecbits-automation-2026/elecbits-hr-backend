import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { opsPath } from './assets.docs.js';
import {
  assetSetupSchema,
  createCategorySchema,
  updateCategorySchema,
} from './asset-setup.schema.js';

/** OpenAPI registration for OPS setup (categories). */
export const registerAssetSetupDocs = (registry: OpenAPIRegistry): void => {
  opsPath(
    registry,
    'get',
    '/api/v1/asset-setup',
    'Asset categories with counts',
    assetSetupSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/asset-setup/categories',
    'Add an asset category',
    assetSetupSchema,
    createCategorySchema,
  );
  opsPath(
    registry,
    'patch',
    '/api/v1/asset-setup/categories/{id}',
    'Edit an asset category',
    assetSetupSchema,
    updateCategorySchema,
  );
};
