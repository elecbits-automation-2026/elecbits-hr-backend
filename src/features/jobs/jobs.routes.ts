import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { jobsController } from './jobs.controller.js';

/**
 * Background jobs — mounted at /api/v1/admin/jobs (Admin: access.settings, org).
 *
 *   GET  /            -> scheduler on/off, the job list, recent runs
 *   POST /:name/run   -> run one job now (its own run key; never blocks the daily run)
 */
export const jobsRoutes = Router();

jobsRoutes.use(authenticate);

jobsRoutes.get(
  '/',
  requireAccess('access.settings', 'read', { orgOnly: true }),
  jobsController.overview,
);
jobsRoutes.post(
  '/:name/run',
  requireAccess('access.settings', 'update', { orgOnly: true }),
  jobsController.runNow,
);
