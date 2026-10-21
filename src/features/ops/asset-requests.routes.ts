import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { assetRequestsController } from './asset-requests.controller.js';
import {
  createAssetRequestSchema,
  fulfilAssetRequestSchema,
  updateAssetRequestSchema,
} from './asset-requests.schema.js';

/**
 * Asset requests — mounted at /api/v1/asset-requests.
 *
 *   GET   /              -> 200 AssetRequest[]   (the shared OPS queue)
 *   GET   /mine          -> 200 AssetRequest[]   (the caller's own — `me` scope)
 *   POST  /              -> 201 AssetRequest     (any employee may ask)
 *   PATCH /:id           -> 200 AssetRequest     (OPS: in progress / decline)
 *   POST  /:id/fulfil    -> 200 AssetRequest     (OPS: issue / take back / close)
 */
export const assetRequestsRoutes = Router();

assetRequestsRoutes.use(authenticate);

assetRequestsRoutes.get(
  '/',
  requireAccess('ops.asset_requests', 'read'),
  assetRequestsController.listQueue,
);
// Own requests need no OPS grant — `me` scope by definition.
assetRequestsRoutes.get('/mine', assetRequestsController.listMine);
assetRequestsRoutes.post(
  '/',
  validateBody(createAssetRequestSchema),
  assetRequestsController.create,
);
assetRequestsRoutes.patch(
  '/:id',
  requireAccess('ops.asset_requests', 'update'),
  validateBody(updateAssetRequestSchema),
  assetRequestsController.handle,
);
assetRequestsRoutes.post(
  '/:id/fulfil',
  requireAccess('ops.asset_requests', 'update'),
  validateBody(fulfilAssetRequestSchema),
  assetRequestsController.fulfil,
);
