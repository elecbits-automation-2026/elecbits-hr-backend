import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { batchesController } from './batches.controller.js';
import { assignBatchSchema, upsertBatchSchema } from './batches.schema.js';

/**
 * Access batches — mounted at /api/v1/batches.
 *
 *   GET    /                          -> 200 Batch[]
 *   GET    /modules                   -> 200 Module[]      (the composer's pick-list)
 *   POST   /                          -> 201 Batch         (Owner/admin surface)
 *   PUT    /:id                       -> 200 Batch         (edits apply LIVE to all holders, §3.2)
 *   GET    /:id/holders               -> 200 BatchHolder[]
 *   POST   /:id/assign                -> 204               (within the caller's assignable list)
 *   DELETE /:id/assign/:employeeId    -> 204               (revocation is immediate, §10)
 */
export const batchesRoutes = Router();

batchesRoutes.use(authenticate);

batchesRoutes.get('/', requireAccess('access.batches', 'read', { orgOnly: true }), batchesController.list);
// Static path registered before any '/:id' route so it never matches as an id.
batchesRoutes.get(
  '/modules',
  requireAccess('access.batches', 'read', { orgOnly: true }),
  batchesController.modules,
);
batchesRoutes.post(
  '/',
  requireAccess('access.batches', 'create', { orgOnly: true }),
  validateBody(upsertBatchSchema),
  batchesController.create,
);
batchesRoutes.put(
  '/:id',
  requireAccess('access.batches', 'update', { orgOnly: true }),
  validateBody(upsertBatchSchema),
  batchesController.update,
);
batchesRoutes.get(
  '/:id/holders',
  requireAccess('access.batches', 'read', { orgOnly: true }),
  batchesController.holders,
);
batchesRoutes.post(
  '/:id/assign',
  requireAccess('access.batches', 'update', { orgOnly: true }),
  validateBody(assignBatchSchema),
  batchesController.assign,
);
batchesRoutes.delete(
  '/:id/assign/:employeeId',
  requireAccess('access.batches', 'update', { orgOnly: true }),
  batchesController.revoke,
);
