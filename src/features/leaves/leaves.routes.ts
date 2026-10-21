import { Router, raw } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { leavesController } from './leaves.controller.js';
import { createLeaveRequestSchema, decideLeaveSchema } from './leaves.schema.js';

/**
 * Leave requests — mounted at /api/v1/leaves.
 *
 *   GET  /mine          -> 200 LeaveRequest[]  (own requests — me scope)
 *   GET  /balances      -> 200 LeaveBalance[]  (own, ?year=; unpaid uncapped)
 *   GET  /team          -> 200 LeaveRequest[]  (caller is the effective RM)
 *   GET  /              -> 200 LeaveRequest[]  (HR queue — hrbp.leaves read)
 *   POST /              -> 201 LeaveRequest    (raise; caller from the token)
 *   POST /:id/cancel    -> 200 LeaveRequest    (own, while not fully approved)
 *   POST /:id/decision  -> 200 LeaveRequest    (approve/decline; the service
 *                           resolves which slot(s) the caller fills — RM is a
 *                           relationship, not a grant, so no requireAccess here)
 *
 * Literal paths are registered before /:id/* so Express never captures them.
 */
export const leavesRoutes = Router();

leavesRoutes.use(authenticate);

leavesRoutes.get('/mine', leavesController.listMine);
leavesRoutes.get('/balances', leavesController.balances);
leavesRoutes.get('/team', leavesController.listTeam);
// A report's balances for the RM person sheet (service-gated; menstrual stripped).
leavesRoutes.get('/team/:employeeId/balances', leavesController.teamBalances);
leavesRoutes.get('/', requireAccess('hrbp.leaves', 'read'), leavesController.listQueue);
leavesRoutes.post('/', validateBody(createLeaveRequestSchema), leavesController.raise);
leavesRoutes.post('/:id/cancel', leavesController.cancel);
// Medical certificate for a sick leave (exit module): raw file body, like policy PDFs.
leavesRoutes.put(
  '/:id/certificate',
  raw({ type: () => true, limit: '10mb' }),
  leavesController.uploadCertificate,
);
leavesRoutes.get('/:id/certificate', leavesController.certificate);
leavesRoutes.post(
  '/:id/decision',
  validateBody(decideLeaveSchema),
  leavesController.decide,
);
