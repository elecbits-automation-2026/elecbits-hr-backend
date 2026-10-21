import { Router, raw } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { reimbursementsController } from './reimbursements.controller.js';
import { createClaimSchema, decideClaimSchema } from './reimbursements.schema.js';

/**
 * Reimbursement claims — mounted at /api/v1/reimbursements.
 *
 *   GET  /mine           -> own claims (me scope)
 *   POST /               -> 201 claim (to the RM, or straight to Payroll)
 *   POST /:id/cancel     -> withdraw an own claim still waiting on someone
 *   GET  /team           -> claims waiting on the caller as RM (relationship)
 *   GET  /?status=a,b    -> every claim (pr.payroll read, org)
 *   POST /:id/decision   -> RM step (the effective RM) or Payroll step
 *                           (pr.payroll update, org) — the service decides which
 *   PUT  /:id/receipt    -> the claimant attaches the receipt (raw body, ?filename=)
 *   GET  /:id/receipt    -> the file (claimant, their RM, or pr.payroll read org)
 */
export const reimbursementsRoutes = Router();

reimbursementsRoutes.use(authenticate);

reimbursementsRoutes.get('/mine', reimbursementsController.mine);
reimbursementsRoutes.get('/team', reimbursementsController.team);
reimbursementsRoutes.get(
  '/',
  requireAccess('pr.payroll', 'read', { orgOnly: true }),
  reimbursementsController.queue,
);
reimbursementsRoutes.post(
  '/',
  validateBody(createClaimSchema),
  reimbursementsController.create,
);
reimbursementsRoutes.post(
  '/:id/decision',
  validateBody(decideClaimSchema),
  reimbursementsController.decide,
);
reimbursementsRoutes.post('/:id/cancel', reimbursementsController.cancel);
reimbursementsRoutes.put(
  '/:id/receipt',
  raw({ type: () => true, limit: '10mb' }),
  reimbursementsController.uploadReceipt,
);
reimbursementsRoutes.get('/:id/receipt', reimbursementsController.receipt);
