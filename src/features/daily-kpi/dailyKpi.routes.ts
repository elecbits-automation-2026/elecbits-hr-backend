import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { dailyKpiController } from './dailyKpi.controller.js';

/**
 * Daily KPI — mounted at /api/v1/daily-kpi. `?date=YYYY-MM-DD` (default
 * today, up to 60 days back).
 *
 *   GET /mine -> 200 DailyKpi   your own day
 *   GET /team -> 200 DailyKpi   your reports (empty for non-managers)
 *   GET /org  -> 200 DailyKpi   everyone (HR: org-wide hrbp.people read)
 */
export const dailyKpiRoutes = Router();

dailyKpiRoutes.use(authenticate);

dailyKpiRoutes.get('/mine', dailyKpiController.mine);
dailyKpiRoutes.get('/team', dailyKpiController.team);
dailyKpiRoutes.get(
  '/org',
  requireAccess('hrbp.people', 'read', { orgOnly: true }),
  dailyKpiController.org,
);
