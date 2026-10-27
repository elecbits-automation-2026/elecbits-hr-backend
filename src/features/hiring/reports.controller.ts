import type { Request, Response } from 'express';
import createError from 'http-errors';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createHiringRepository } from './hiring.repository.js';
import { createReportsRepository } from './reports.repository.js';
import { reportPeriodQuery, TRACKER_VIEWS, type TrackerView } from './reports.schema.js';
import { createReportsService } from './reports.service.js';

const service = (req: Request) =>
  createReportsService({
    repo: createReportsRepository(req.db),
    hiring: createHiringRepository(req.db),
  });

/** HTTP layer for the TA tracker report and the hiring trackers. */
export const reportsController = {
  report: async (req: Request, res: Response): Promise<void> => {
    const q = reportPeriodQuery.safeParse(req.query);
    if (!q.success) {
      throw createError(400, q.error.issues[0]?.message ?? 'Give a period: from and to', {
        code: 'INVALID_PERIOD',
      });
    }
    res.json(await service(req).report(q.data.from, q.data.to));
  },

  pendingActions: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).pendingActions());
  },

  tracker: async (req: Request, res: Response): Promise<void> => {
    const view = String(req.query.view ?? 'external') as TrackerView;
    if (!(TRACKER_VIEWS as readonly string[]).includes(view)) {
      throw createError(400, 'view is internal or external', { code: 'INVALID_VIEW' });
    }
    // TA (the ta.hiring read grant, org-wide) sees either view of everything;
    // a department head sees the external view of their own departments.
    const access = await createAuthzRepository(req.db).resolveAccess(
      req.auth!.employeeId,
      'ta.hiring',
      'read',
    );
    const hasTa = access.bypass || access.scopes.includes('org');
    res.json(await service(req).tracker(view, req.auth!.employeeId, hasTa));
  },
};
