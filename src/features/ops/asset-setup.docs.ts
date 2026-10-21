import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { opsPath } from './assets.docs.js';
import {
  assetSetupSchema,
  createCategorySchema,
  putKitSchema,
  updateCategorySchema,
} from './asset-setup.schema.js';

/** OpenAPI registration for OPS setup (categories, kits). */
export const registerAssetSetupDocs = (registry: OpenAPIRegistry): void => {
  opsPath(
    registry,
    'get',
    '/api/v1/asset-setup',
    'Categories, kits, designations',
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
  opsPath(
    registry,
    'put',
    '/api/v1/asset-setup/kits',
    "Replace a designation's joiner kit",
    assetSetupSchema,
    putKitSchema,
  );
};
