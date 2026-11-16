import type { Request, Response } from 'express';
import createError from 'http-errors';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createAttendanceRepository } from '../attendance/attendance.repository.js';
import { createAttendanceService } from '../attendance/attendance.service.js';
import { createPerformanceRepository } from '../performance/performance.repository.js';
import { createPerformanceService } from '../performance/performance.service.js';
import { createSettingsRepository } from '../settings/index.js';
import { createDailyKpiRepository } from './dailyKpi.repository.js';
import { dailyKpiQuerySchema } from './dailyKpi.schema.js';
import { createDailyKpiService } from './dailyKpi.service.js';

/** Composition root: the page reads attendance and performance through their services. */
const service = (req: Request) => {
  const authz = createAuthzRepository(req.db);
  const settings = createSettingsRepository(req.db);
  return createDailyKpiService({
    repo: createDailyKpiRepository(req.db),
    attendance: createAttendanceService({
      repo: createAttendanceRepository(req.db),
      authz,
      settings,
    }),
    performance: createPerformanceService({
      repo: createPerformanceRepository(req.db),
      authz,
      settings,
    }),
    settings,
  });
};

const dateParam = (req: Request): string | undefined => {
  const parsed = dailyKpiQuerySchema.safeParse(req.query);
  if (!parsed.success) throw createError(400, 'date must be YYYY-MM-DD');
  return parsed.data.date;
};

export const dailyKpiController = {
  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(req.auth!.employeeId, dateParam(req)));
  },

  team: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).team(req.auth!.employeeId, dateParam(req)));
  },

  org: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).org(dateParam(req)));
  },
};
