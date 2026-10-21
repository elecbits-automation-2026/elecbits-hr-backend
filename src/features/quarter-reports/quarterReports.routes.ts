import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { quarterReportsController } from './quarterReports.controller.js';
import { adjustScoreSchema, closeCycleSchema } from './quarterReports.schema.js';

/**
 * Quarter reports — mounted at /api/v1/quarter-reports.
 *
 *   GET   /cycles              -> every quarter with its close state
 *   POST  /cycles/:name/close  -> close + generate (hrbp.people update, org)
 *   GET   /cycles/:name        -> reports the caller may see: their people as
 *                                 manager at close + their hrbp.people reach
 *   GET   /mine                -> own reports (me scope)
 *   GET   /people/:employeeId  -> one person's reports (self, manager, HR reach)
 *   PATCH /:id/score           -> final score + reason (manager at close, or HR reach)
 */
export const quarterReportsRoutes = Router();

quarterReportsRoutes.use(authenticate);

quarterReportsRoutes.get('/cycles', quarterReportsController.cycles);
quarterReportsRoutes.post(
  '/cycles/:name/close',
  requireAccess('hrbp.people', 'update', { orgOnly: true }),
  validateBody(closeCycleSchema),
  quarterReportsController.close,
);
quarterReportsRoutes.get('/cycles/:name', quarterReportsController.view);
quarterReportsRoutes.get('/mine', quarterReportsController.mine);
quarterReportsRoutes.get('/people/:employeeId', quarterReportsController.forPerson);
quarterReportsRoutes.patch(
  '/:id/score',
  validateBody(adjustScoreSchema),
  quarterReportsController.adjust,
);
