import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { assetsController } from './assets.controller.js';
import {
  closeIncidentSchema,
  createAssetSchema,
  importAssetsSchema,
  issueAssetSchema,
  moveAssetSchema,
  reportIncidentSchema,
  returnAssetSchema,
  setAssetStatusSchema,
  transferAssetSchema,
  updateAssetSchema,
} from './assets.schema.js';

/**
 * Asset register — mounted at /api/v1/assets. Company-wide, so every route
 * needs an org-scoped ops.assets grant.
 *
 *   GET  /options                  categories, zones, people for the forms
 *   GET  /?holderId=               the register (or one person's holdings)
 *   GET  /incidents                damage / loss / theft, open first
 *   POST /incidents/:id/close      close (loss / theft may mark the asset lost)
 *   GET  /kit-check/:employeeId    joiner kit vs what they hold
 *   POST /import                   CSV rows; dryRun checks only
 *   POST /                         register one asset (holder = issue at once)
 *   GET  /:id                      detail + history + incidents + passes
 *   PATCH /:id                     edit details
 *   POST /:id/issue | return | transfer | move | status | incidents
 */
export const assetsRoutes = Router();

assetsRoutes.use(authenticate);

const read = requireAccess('ops.assets', 'read', { orgOnly: true });
const create = requireAccess('ops.assets', 'create', { orgOnly: true });
const update = requireAccess('ops.assets', 'update', { orgOnly: true });

assetsRoutes.get('/options', read, assetsController.options);
assetsRoutes.get('/', read, assetsController.list);
assetsRoutes.get('/incidents', read, assetsController.incidents);
assetsRoutes.post(
  '/incidents/:id/close',
  update,
  validateBody(closeIncidentSchema),
  assetsController.closeIncident,
);
assetsRoutes.get('/kit-check/:employeeId', read, assetsController.kitCheck);
assetsRoutes.post(
  '/import',
  create,
  validateBody(importAssetsSchema),
  assetsController.importRows,
);
assetsRoutes.post('/', create, validateBody(createAssetSchema), assetsController.create);
assetsRoutes.get('/:id', read, assetsController.detail);
assetsRoutes.patch(
  '/:id',
  update,
  validateBody(updateAssetSchema),
  assetsController.update,
);
assetsRoutes.post(
  '/:id/issue',
  update,
  validateBody(issueAssetSchema),
  assetsController.issue,
);
assetsRoutes.post(
  '/:id/return',
  update,
  validateBody(returnAssetSchema),
  assetsController.returnAsset,
);
assetsRoutes.post(
  '/:id/transfer',
  update,
  validateBody(transferAssetSchema),
  assetsController.transfer,
);
assetsRoutes.post(
  '/:id/move',
  update,
  validateBody(moveAssetSchema),
  assetsController.move,
);
assetsRoutes.post(
  '/:id/status',
  update,
  validateBody(setAssetStatusSchema),
  assetsController.setStatus,
);
assetsRoutes.post(
  '/:id/incidents',
  update,
  validateBody(reportIncidentSchema),
  assetsController.reportIncident,
);
