import { Router, raw } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { reimbursementsController } from './reimbursements.controller.js';
import {
  createClaimSchema,
  decideClaimSchema,
  markPaidSchema,
} from './reimbursements.schema.js';

/**
 * Reimbursement claims — mounted at /api/v1/reimbursements.
 *
 *   GET  /mine               -> own claims (me scope)
 *   POST /                   -> 201 claim (to PR; a PR person's own claim to Admin)
 *   POST /:id/cancel         -> withdraw an own claim still waiting on someone
 *   GET  /?status=&month=    -> every claim (pr.payroll read, org — PR and Admin)
 *   POST /:id/decision       -> PR step (pr.payroll update, org) or the Admin
 *                               account (either step, final) — the service decides
 *   GET  /bank-file?month=   -> .xlsx of approved claims for the bank
 *                               (pr.payroll.bank_details read, org)
 *   POST /mark-paid          -> approved -> paid with date + reference (pr.payroll update, org)
 *   PUT  /:id/receipt        -> the claimant attaches the receipt (raw body, ?filename=)
 *   GET  /:id/receipt        -> the file (claimant, PR, or Admin)
 */
export const reimbursementsRoutes = Router();

reimbursementsRoutes.use(authenticate);

reimbursementsRoutes.get('/mine', reimbursementsController.mine);
reimbursementsRoutes.get(
  '/bank-file',
  requireAccess('pr.payroll.bank_details', 'read', { orgOnly: true }),
  reimbursementsController.bankFile,
);
reimbursementsRoutes.post(
  '/mark-paid',
  requireAccess('pr.payroll', 'update', { orgOnly: true }),
  validateBody(markPaidSchema),
  reimbursementsController.markPaid,
);
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
