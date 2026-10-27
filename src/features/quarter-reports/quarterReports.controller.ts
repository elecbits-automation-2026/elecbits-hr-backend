import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository, type PeopleScope } from '../access/authz.repository.js';
import { createAttendanceRepository } from '../attendance/attendance.repository.js';
import { createAttendanceService } from '../attendance/attendance.service.js';
import { createSettingsRepository } from '../settings/index.js';
import { createQuarterReportsRepository } from './quarterReports.repository.js';
import type { AdjustScoreInput, CloseCycleInput } from './quarterReports.schema.js';
import { createQuarterReportsService } from './quarterReports.service.js';

/**
 * Composition root. The quarter's attendance comes from the attendance
 * classifier in-process (no hrbp.attendance grant needed to close).
 */
const service = (req: Request) =>
  createQuarterReportsService({
    repo: createQuarterReportsRepository(req.db),
    attendance: createAttendanceService({
      repo: createAttendanceRepository(req.db),
      authz: createAuthzRepository(req.db),
      settings: createSettingsRepository(req.db),
    }),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

/** Whose reports the caller's hrbp.people grant reaches (none without one). */
const hrScope = (req: Request, action: 'read' | 'update') =>
  createAuthzRepository(req.db).peopleScope(req.auth!.employeeId, 'hrbp.people', action);

/** HTTP layer only: read validated input, call the service, shape the response. */
export const quarterReportsController = {
  cycles: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).cycles());
  },

  close: async (req: Request, res: Response): Promise<void> => {
    const input: CloseCycleInput = req.body;
    const cycle = await service(req).close(
      req.params.name!,
      input.early === true,
      actor(req),
    );
    req.log.info({ cycle: cycle.name, reports: cycle.reportCount }, 'quarter closed');
    res.json(cycle);
  },

  view: async (req: Request, res: Response): Promise<void> => {
    // `?as=rm` is the personal My performance board: only the caller's own
    // people. The HR reach stays on HR → Quarter reports (test-pass fix).
    const scope: PeopleScope =
      req.query.as === 'rm' ? { all: false, ids: new Set() } : await hrScope(req, 'read');
    res.json(await service(req).view(req.params.name!, req.auth!.employeeId, scope));
  },

  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(req.auth!.employeeId));
  },

  adjust: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid report id');
    const input: AdjustScoreInput = req.body;
    res.json(
      await service(req).adjust(id, input, actor(req), await hrScope(req, 'update')),
    );
  },

  forPerson: async (req: Request, res: Response): Promise<void> => {
    const { employeeId } = req.params;
    if (!isUuid(employeeId)) throw createError(400, 'Invalid employee id');
    const line = await createAuthzRepository(req.db).findReportingLine(employeeId);
    res.json(
      await service(req).forPerson(
        employeeId,
        req.auth!.employeeId,
        line ? (line.leaveApprover ?? line.reportsTo) : null,
        await hrScope(req, 'read'),
      ),
    );
  },
};
