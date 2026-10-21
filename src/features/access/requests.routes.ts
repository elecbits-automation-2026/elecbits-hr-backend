import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { requestsController } from './requests.controller.js';
import { createGrantRequestSchema, decideGrantRequestSchema } from './requests.schema.js';

/**
 * Grant requests — mounted at /api/v1/grant-requests.
 *
 *   GET  /             -> 200 GrantRequest[]  (Admin's queue — access.requests read)
 *   GET  /mine         -> 200 GrantRequest[]  (requests the caller raised)
 *   GET  /options      -> 200 Batch refs      (batches HR may propose — HR only)
 *   POST /             -> 201 GrantRequest    (HR asks for one person; the HR
 *                                             check — broad hrbp.people update —
 *                                             lives in the service)
 *   POST /:id/decision -> 200 GrantRequest    (Owner/SuperAdmin decides; may
 *                                             narrow — access.requests update)
 */
export const grantRequestsRoutes = Router();

grantRequestsRoutes.use(authenticate);

grantRequestsRoutes.get(
  '/',
  requireAccess('access.requests', 'read', { orgOnly: true }),
  requestsController.list,
);
grantRequestsRoutes.get('/mine', requestsController.mine);
grantRequestsRoutes.get('/options', requestsController.options);
grantRequestsRoutes.post(
  '/',
  validateBody(createGrantRequestSchema),
  requestsController.create,
);
grantRequestsRoutes.post(
  '/:id/decision',
  requireAccess('access.requests', 'update', { orgOnly: true }),
  validateBody(decideGrantRequestSchema),
  requestsController.decide,
);
