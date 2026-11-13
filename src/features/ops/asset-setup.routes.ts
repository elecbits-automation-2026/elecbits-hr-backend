import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { assetSetupController } from './asset-setup.controller.js';
import {
  createCategorySchema,
  updateCategorySchema,
} from './asset-setup.schema.js';

/**
 * OPS setup — mounted at /api/v1/asset-setup (grant: ops.locations, shown as
 * "OPS setup"; org scope).
 *
 *   GET   /                  categories (with counts)
 *   POST  /categories        add a category
 *   PATCH /categories/:id    edit (name, prefix, lab, gate-pass flag)
 */
export const assetSetupRoutes = Router();

assetSetupRoutes.use(authenticate);

assetSetupRoutes.get(
  '/',
  requireAccess('ops.locations', 'read', { orgOnly: true }),
  assetSetupController.overview,
);
assetSetupRoutes.post(
  '/categories',
  requireAccess('ops.locations', 'create', { orgOnly: true }),
  validateBody(createCategorySchema),
  assetSetupController.createCategory,
);
assetSetupRoutes.patch(
  '/categories/:id',
  requireAccess('ops.locations', 'update', { orgOnly: true }),
  validateBody(updateCategorySchema),
  assetSetupController.updateCategory,
);
