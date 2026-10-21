import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { gatePassesController } from './gate-passes.controller.js';
import { createGatePassSchema, declineGatePassSchema } from './gate-passes.schema.js';

/**
 * Gate passes — mounted at /api/v1/gate-passes. The holder's own steps
 * ("back", "still out") live under /my-assets.
 *
 *   GET  /              -> 200 GatePass[]   (OPS view)
 *   POST /              -> 201 GatePass     (any employee; disclaimer required)
 *   POST /:id/approve   -> 200 GatePass     (OPS — approval lets it leave)
 *   POST /:id/decline   -> 200 GatePass     (OPS, with a reason)
 *   POST /:id/back      -> 200 GatePass     (OPS marks it back at its zone)
 */
export const gatePassesRoutes = Router();

gatePassesRoutes.use(authenticate);

gatePassesRoutes.get(
  '/',
  requireAccess('ops.gate_passes', 'read'),
  gatePassesController.list,
);
// Requesting a pass needs no OPS grant.
gatePassesRoutes.post(
  '/',
  validateBody(createGatePassSchema),
  gatePassesController.create,
);
gatePassesRoutes.post(
  '/:id/approve',
  requireAccess('ops.gate_passes', 'update'),
  gatePassesController.approve,
);
gatePassesRoutes.post(
  '/:id/decline',
  requireAccess('ops.gate_passes', 'update'),
  validateBody(declineGatePassSchema),
  gatePassesController.decline,
);
gatePassesRoutes.post(
  '/:id/back',
  requireAccess('ops.gate_passes', 'update'),
  gatePassesController.back,
);
