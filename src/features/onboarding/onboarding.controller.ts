import type { Request, Response } from 'express';
import { assertReaches, keepReachable } from '../../middleware/authorize.js';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createOnboardingRepository } from './onboarding.repository.js';
import type { StartJourneyInput, ToggleTaskInput } from './onboarding.schema.js';
import { createOnboardingService } from './onboarding.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createOnboardingService({
    repo: createOnboardingRepository(req.db),
    authz: createAuthzRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

/** HTTP layer only: read validated input, call the service, shape the response. */
export const onboardingController = {
  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(actor(req)));
  },

  team: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).team(actor(req)));
  },

  teamTasks: async (req: Request, res: Response): Promise<void> => {
    const owner = req.params.owner;
    if (owner !== 'ops' && owner !== 'payroll') throw createError(404, 'Unknown team');
    res.json(await service(req).teamTasks(owner, actor(req)));
  },

  forEmployee: async (req: Request, res: Response): Promise<void> => {
    const { employeeId } = req.params;
    if (!isUuid(employeeId)) throw createError(400, 'Invalid employee id');
    await assertReaches(req, employeeId, 'hide');
    res.json(await service(req).forEmployee(employeeId, actor(req).actorEmployeeId));
  },

  start: async (req: Request, res: Response): Promise<void> => {
    const input: StartJourneyInput = req.body;
    await assertReaches(req, input.employeeId);
    const journey = await service(req).start(input, actor(req));
    req.log.info({ employeeId: input.employeeId }, 'onboarding started');
    res.status(201).json(journey);
  },

  toggleTask: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid task id');
    const input: ToggleTaskInput = req.body ?? {};
    res.json(await service(req).toggleTask(id, input, actor(req)));
  },

  uploadTaskFile: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid task id');
    if (!Buffer.isBuffer(req.body)) {
      throw createError(422, 'Send the file as the raw request body', { code: 'NOT_A_FILE' });
    }
    const fileName = String(req.query.filename ?? 'document').slice(0, 200);
    const journey = await service(req).uploadTaskFile(
      id,
      { fileName, contentType: req.headers['content-type'] ?? '', data: req.body },
      actor(req),
    );
    req.log.info({ taskId: id, bytes: req.body.length }, 'onboarding document stored');
    res.json(journey);
  },

  taskFile: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid task id');
    const file = await service(req).taskFile(id, req.auth!.employeeId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${file.fileName.replaceAll('"', '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.data);
  },

  queue: async (req: Request, res: Response): Promise<void> => {
    res.json(await keepReachable(req, await service(req).queue(), (r) => r.employee.id));
  },
};
