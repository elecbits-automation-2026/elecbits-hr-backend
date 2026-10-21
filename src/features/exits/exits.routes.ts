import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { exitsController } from './exits.controller.js';
import {
  acceptSchema,
  acknowledgeSchema,
  cancelExitSchema,
  clearSchema,
  interviewSchema,
  resignSchema,
  terminateSchema,
} from './exits.schema.js';

/**
 * Exits — mounted at /api/v1/exits. Several roles share one door, so the
 * gates live in the service: the leaver, their manager, HR (hrbp.exits in
 * reach), OPS (ops.assets org) and payroll (pr.payroll org).
 *
 *   GET  /                      HR / OPS / payroll list
 *   GET  /mine                  my resignation page
 *   GET  /team                  exits of people who report to me
 *   GET  /:id                   one exit (what the caller may do in `can`)
 *   POST /resign                resign (reason, optional last day)
 *   POST /terminate             HR: end someone's employment
 *   POST /:id/withdraw          the leaver, until HR accepts
 *   POST /:id/acknowledge       manager: acknowledge + handover plan
 *   POST /:id/accept            HR: fix the last day, decide a short notice
 *   POST /:id/cancel            HR: call it off before the last day
 *   POST /:id/clear             HR / manager / OPS clearance (never your own)
 *   POST /:id/interview         the leaver, on the last day
 *   GET  /:id/letters/:which    relieving | experience PDF, once settled
 */
export const exitsRoutes = Router();

exitsRoutes.use(authenticate);

exitsRoutes.get('/', exitsController.list);
exitsRoutes.get('/mine', exitsController.mine);
exitsRoutes.get('/team', exitsController.team);
exitsRoutes.post('/resign', validateBody(resignSchema), exitsController.resign);
exitsRoutes.post('/terminate', validateBody(terminateSchema), exitsController.terminate);
exitsRoutes.get('/:id', exitsController.get);
exitsRoutes.post('/:id/withdraw', exitsController.withdraw);
exitsRoutes.post(
  '/:id/acknowledge',
  validateBody(acknowledgeSchema),
  exitsController.acknowledge,
);
exitsRoutes.post('/:id/accept', validateBody(acceptSchema), exitsController.accept);
exitsRoutes.post('/:id/cancel', validateBody(cancelExitSchema), exitsController.cancel);
exitsRoutes.post('/:id/clear', validateBody(clearSchema), exitsController.clear);
exitsRoutes.post(
  '/:id/interview',
  validateBody(interviewSchema),
  exitsController.interview,
);
exitsRoutes.get('/:id/letters/:which', exitsController.letter);
