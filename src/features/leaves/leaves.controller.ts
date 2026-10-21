import type { Request, Response } from 'express';
import { keepReachable } from '../../middleware/authorize.js';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createSettingsRepository } from '../settings/index.js';
import { createLeavesRepository } from './leaves.repository.js';
import type { CreateLeaveRequestInput, DecideLeaveInput } from './leaves.schema.js';
import { createLeavesService } from './leaves.service.js';

/** Composition root: request-scoped repo + the same authz read requireAccess uses. */
const service = (req: Request) =>
  createLeavesService({
    repo: createLeavesRepository(req.db),
    authz: createAuthzRepository(req.db),
    settings: createSettingsRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

const LEAVE_STATUSES = [
  'pending',
  'partially_approved',
  'approved',
  'declined',
  'cancelled',
] as const;
type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** HTTP layer only: read validated input, call the service, shape the response. */
export const leavesController = {
  uploadCertificate: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid leave id');
    if (!Buffer.isBuffer(req.body)) {
      throw createError(422, 'Send the file as the raw request body', { code: 'NOT_A_FILE' });
    }
    const fileName = String(req.query.filename ?? 'certificate').slice(0, 200);
    const out = await service(req).uploadCertificate(
      id,
      { fileName, contentType: req.headers['content-type'] ?? '', data: req.body },
      actor(req),
    );
    req.log.info({ leaveId: id, bytes: req.body.length }, 'leave certificate stored');
    res.json(out);
  },

  certificate: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid leave id');
    const file = await service(req).certificate(id, req.auth!.employeeId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${file.fileName.replaceAll('"', '')}"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.data);
  },

  listMine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).listMine(req.auth!.employeeId));
  },

  balances: async (req: Request, res: Response): Promise<void> => {
    const parsed = Number.parseInt(String(req.query.year ?? ''), 10);
    const year = Number.isInteger(parsed) ? parsed : new Date().getFullYear();
    res.json(await service(req).balances(req.auth!.employeeId, year));
  },

  listTeam: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).listTeam(req.auth!.employeeId));
  },

  teamBalances: async (req: Request, res: Response): Promise<void> => {
    const { employeeId } = req.params;
    if (!isUuid(employeeId)) throw createError(400, 'Invalid employee id');
    const parsed = Number.parseInt(String(req.query.year ?? ''), 10);
    const year = Number.isInteger(parsed) ? parsed : new Date().getFullYear();
    res.json(await service(req).teamBalances(employeeId, req.auth!.employeeId, year));
  },

  listQueue: async (req: Request, res: Response): Promise<void> => {
    const raw = req.query.status;
    const status =
      typeof raw === 'string' && (LEAVE_STATUSES as readonly string[]).includes(raw)
        ? (raw as LeaveStatus)
        : undefined;
    res.json(
      await keepReachable(
        req,
        await service(req).listQueue(status),
        (l) => l.employee.id,
      ),
    );
  },

  raise: async (req: Request, res: Response): Promise<void> => {
    const input: CreateLeaveRequestInput = req.body;
    // The caller IS the subject — employeeId never comes from the body.
    const leave = await service(req).raise(req.auth!.employeeId, input, actor(req));
    req.log.info({ leaveId: leave.id, type: leave.type }, 'leave requested');
    res.status(201).json(leave);
  },

  cancel: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid leave id');
    const leave = await service(req).cancel(id, actor(req));
    req.log.info({ leaveId: id }, 'leave cancelled');
    res.json(leave);
  },

  decide: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid leave id');
    const input: DecideLeaveInput = req.body;
    const leave = await service(req).decide(id, input, actor(req));
    req.log.info(
      { leaveId: id, decision: input.decision, status: leave.status },
      'leave decided',
    );
    res.json(leave);
  },
};
