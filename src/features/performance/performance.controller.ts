import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createSettingsRepository } from '../settings/index.js';
import { createPerformanceRepository } from './performance.repository.js';
import type {
  CreateGoalInput,
  DecideLateInput,
  SubmitUpdateInput,
  UpdateGoalInput,
  UpdateProgressInput,
} from './performance.schema.js';
import { createPerformanceService } from './performance.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createPerformanceService({
    repo: createPerformanceRepository(req.db),
    authz: createAuthzRepository(req.db),
    settings: createSettingsRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

/** Clamp ?days= to something sane; strips default to two weeks. */
const daysParam = (req: Request, fallback: number): number => {
  const n = Number(req.query.days);
  return Number.isFinite(n) ? Math.min(60, Math.max(1, Math.round(n))) : fallback;
};

/** HTTP layer only: read validated input, call the service, shape the response. */
export const performanceController = {
  myGoals: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).myGoals(actor(req)));
  },

  createGoal: async (req: Request, res: Response): Promise<void> => {
    const input: CreateGoalInput = req.body;
    const goal = await service(req).createGoal(input, actor(req));
    req.log.info({ employeeId: input.employeeId, weight: input.weight }, 'goal created');
    res.status(201).json(goal);
  },

  updateGoal: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid goal id');
    const input: UpdateGoalInput = req.body;
    res.json(await service(req).updateGoal(id, input, actor(req)));
  },

  deleteGoal: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid goal id');
    await service(req).deleteGoal(id, actor(req));
    req.log.info({ goalId: id }, 'goal deleted');
    res.status(204).end();
  },

  updateProgress: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid goal id');
    const input: UpdateProgressInput = req.body;
    res.json(await service(req).updateProgress(id, input, actor(req)));
  },

  teamGoals: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).teamGoals(actor(req)));
  },

  teamMemberGoals: async (req: Request, res: Response): Promise<void> => {
    const { employeeId } = req.params;
    if (!isUuid(employeeId)) throw createError(400, 'Invalid employee id');
    res.json(await service(req).teamMemberGoals(employeeId, actor(req)));
  },

  teamMemberUpdates: async (req: Request, res: Response): Promise<void> => {
    const { employeeId } = req.params;
    if (!isUuid(employeeId)) throw createError(400, 'Invalid employee id');
    res.json(
      await service(req).teamMemberUpdates(employeeId, actor(req), daysParam(req, 14)),
    );
  },

  submitUpdate: async (req: Request, res: Response): Promise<void> => {
    const input: SubmitUpdateInput = req.body;
    const update = await service(req).submitUpdate(input, actor(req));
    req.log.info(
      { date: update.date, scored: update.score !== null },
      'work update submitted',
    );
    res.status(201).json(update);
  },

  latePending: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).latePending(actor(req)));
  },

  decideLate: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid update id');
    const input: DecideLateInput = req.body;
    res.json(await service(req).decideLate(id, input, actor(req)));
  },

  myUpdates: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).myUpdates(actor(req), daysParam(req, 14)));
  },

  teamUpdates: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).teamUpdates(actor(req), daysParam(req, 7)));
  },
};
