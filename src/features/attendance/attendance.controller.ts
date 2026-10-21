import type { Request, Response } from 'express';
import { assertReaches, keepReachable } from '../../middleware/authorize.js';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createSettingsRepository } from '../settings/index.js';
import { createAttendanceRepository } from './attendance.repository.js';
import type {
  CreateHolidayInput,
  CreateRegularizationInput,
  CreateWfhInput,
  CreateZoneInput,
  DecideInput,
  HrMarkInput,
  PunchInput,
} from './attendance.schema.js';
import { createAttendanceService } from './attendance.service.js';

/**
 * Composition root: request-scoped repo + the same authz read requireAccess
 * uses + org settings (default work hours, grace, regularize window).
 */
const service = (req: Request) =>
  createAttendanceService({
    repo: createAttendanceRepository(req.db),
    authz: createAuthzRepository(req.db),
    settings: createSettingsRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

/** `?month=YYYY-MM`, defaulting to the current month. */
const monthParam = (req: Request): string => {
  const raw = String(req.query.month ?? '');
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return raw;
  return new Date().toLocaleDateString('en-CA').slice(0, 7);
};

const requireId = (req: Request): string => {
  const { id } = req.params;
  if (!isUuid(id)) throw createError(400, 'Invalid id');
  return id;
};

/** HTTP layer only: read validated input, call the service, shape the response. */
export const attendanceController = {
  checkIn: async (req: Request, res: Response): Promise<void> => {
    const input: PunchInput = req.body;
    const coords =
      input.lat !== undefined && input.lng !== undefined
        ? { lat: input.lat, lng: input.lng }
        : null;
    const result = await service(req).checkIn(req.auth!.employeeId, req.ip, coords);
    req.log.info({ source: result.source, hasCoords: coords !== null }, 'checked in');
    res.status(201).json(result);
  },

  checkOut: async (req: Request, res: Response): Promise<void> => {
    const input: PunchInput = req.body;
    const coords =
      input.lat !== undefined && input.lng !== undefined
        ? { lat: input.lat, lng: input.lng }
        : null;
    res.json(await service(req).checkOut(req.auth!.employeeId, req.ip, coords));
  },

  myMonth: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).myMonth(req.auth!.employeeId, monthParam(req)));
  },

  teamMonth: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).teamMonth(req.auth!.employeeId, monthParam(req)));
  },

  orgMonth: async (req: Request, res: Response): Promise<void> => {
    const zone = String(req.query.zone ?? '');
    const dept = String(req.query.department ?? '');
    res.json(
      await keepReachable(
        req,
        await service(req).orgMonth(
          monthParam(req),
          isUuid(zone) ? zone : null,
          isUuid(dept) ? dept : null,
        ),
        (r) => r.employee.id,
      ),
    );
  },

  hrMark: async (req: Request, res: Response): Promise<void> => {
    const input: HrMarkInput = req.body;
    await assertReaches(req, input.employeeId);
    const result = await service(req).hrMark(input, actor(req));
    req.log.info(
      { employeeId: input.employeeId, date: input.date },
      'attendance hr-marked',
    );
    res.status(201).json(result);
  },

  exportCsv: async (req: Request, res: Response): Promise<void> => {
    const month = monthParam(req);
    const dept = String(req.query.department ?? '');
    const zone = String(req.query.zone ?? '');
    const departmentId = isUuid(dept) ? dept : null;
    const csv = await service(req).exportMonthCsv(
      req.auth!.employeeId,
      month,
      departmentId,
      isUuid(zone) ? zone : null,
    );
    req.log.info({ month, departmentId }, 'attendance exported');
    res
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="attendance-${month}.csv"`)
      .send(csv);
  },

  listZones: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).listZones());
  },

  addZone: async (req: Request, res: Response): Promise<void> => {
    const input: CreateZoneInput = req.body;
    const zone = await service(req).addZone(input, actor(req));
    req.log.info({ zone: zone.name }, 'punch zone added');
    res.status(201).json(zone);
  },

  removeZone: async (req: Request, res: Response): Promise<void> => {
    await service(req).removeZone(requireId(req), actor(req));
    req.log.info({ zoneId: req.params.id }, 'punch zone removed');
    res.status(204).end();
  },

  listHolidays: async (req: Request, res: Response): Promise<void> => {
    const parsed = Number.parseInt(String(req.query.year ?? ''), 10);
    const year = Number.isInteger(parsed) ? parsed : new Date().getFullYear();
    res.json(await service(req).listHolidays(year));
  },

  addHoliday: async (req: Request, res: Response): Promise<void> => {
    const input: CreateHolidayInput = req.body;
    const holiday = await service(req).addHoliday(input, actor(req));
    req.log.info({ date: holiday.date }, 'holiday added');
    res.status(201).json(holiday);
  },

  removeHoliday: async (req: Request, res: Response): Promise<void> => {
    await service(req).removeHoliday(requireId(req), actor(req));
    req.log.info({ holidayId: req.params.id }, 'holiday removed');
    res.status(204).end();
  },

  raiseRegularization: async (req: Request, res: Response): Promise<void> => {
    const input: CreateRegularizationInput = req.body;
    const reg = await service(req).raiseRegularization(
      req.auth!.employeeId,
      input,
      actor(req),
    );
    req.log.info({ regId: reg.id, date: reg.date }, 'regularization raised');
    res.status(201).json(reg);
  },

  myRegularizations: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).myRegularizations(req.auth!.employeeId));
  },

  teamRegularizations: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).teamRegularizations(req.auth!.employeeId));
  },

  decideRegularization: async (req: Request, res: Response): Promise<void> => {
    const input: DecideInput = req.body;
    const reg = await service(req).decideRegularization(
      requireId(req),
      input,
      actor(req),
    );
    req.log.info({ regId: reg.id, decision: input.decision }, 'regularization decided');
    res.json(reg);
  },

  cancelRegularization: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).cancelRegularization(requireId(req), actor(req)));
  },

  raiseWfh: async (req: Request, res: Response): Promise<void> => {
    const input: CreateWfhInput = req.body;
    const wfh = await service(req).raiseWfh(req.auth!.employeeId, input, actor(req));
    req.log.info({ wfhId: wfh.id }, 'wfh requested');
    res.status(201).json(wfh);
  },

  myWfh: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).myWfh(req.auth!.employeeId));
  },

  teamWfh: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).teamWfh(req.auth!.employeeId));
  },

  wfhQueue: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await keepReachable(req, await service(req).wfhQueue(), (w) => w.employee.id),
    );
  },

  decideWfh: async (req: Request, res: Response): Promise<void> => {
    const input: DecideInput = req.body;
    const wfh = await service(req).decideWfh(requireId(req), input, actor(req));
    req.log.info({ wfhId: wfh.id, decision: input.decision }, 'wfh decided');
    res.json(wfh);
  },

  cancelWfh: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).cancelWfh(requireId(req), actor(req)));
  },
};
