import type { Request, Response } from 'express';
import createError from 'http-errors';
import type { DbClient } from '../../db/client.js';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createSettingsRepository } from '../settings/index.js';
import { createPipRepository } from './pip.repository.js';
import type {
  CancelPipInput,
  CreateCheckinInput,
  CreatePipInput,
  DecidePipInput,
  PipOutcomeInput,
} from './pip.schema.js';
import { createPipService } from './pip.service.js';

/** Composition root (also used by the scheduler). */
export const pipServiceFor = (db: DbClient) =>
  createPipService({
    repo: createPipRepository(db),
    authz: createAuthzRepository(db),
    settings: createSettingsRepository(db),
  });

const actor = (req: Request) => {
  if (!req.auth) throw createError(401, 'Authentication required');
  return { actorUserId: req.auth.userId, actorEmployeeId: req.auth.employeeId };
};
const id = (req: Request) => {
  if (!isUuid(req.params.id)) throw createError(400, 'Invalid id');
  return req.params.id;
};

/** HTTP layer only. Reasons, targets and notes are never logged. */
export const pipController = {
  list: async (req: Request, res: Response): Promise<void> => {
    const employeeId =
      typeof req.query.employeeId === 'string' && isUuid(req.query.employeeId)
        ? req.query.employeeId
        : undefined;
    res.json(await pipServiceFor(req.db).list(actor(req).actorEmployeeId, employeeId));
  },
  get: async (req: Request, res: Response): Promise<void> => {
    res.json(await pipServiceFor(req.db).get(id(req), actor(req).actorEmployeeId));
  },
  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreatePipInput = req.body;
    res.status(201).json(await pipServiceFor(req.db).create(input, actor(req)));
  },
  decide: async (req: Request, res: Response): Promise<void> => {
    const input: DecidePipInput = req.body;
    res.json(await pipServiceFor(req.db).decide(id(req), input, actor(req)));
  },
  acknowledge: async (req: Request, res: Response): Promise<void> => {
    res.json(await pipServiceFor(req.db).acknowledge(id(req), actor(req)));
  },
  checkin: async (req: Request, res: Response): Promise<void> => {
    const input: CreateCheckinInput = req.body;
    res.status(201).json(await pipServiceFor(req.db).checkin(id(req), input, actor(req)));
  },
  outcome: async (req: Request, res: Response): Promise<void> => {
    const input: PipOutcomeInput = req.body;
    res.json(await pipServiceFor(req.db).outcome(id(req), input, actor(req)));
  },
  cancel: async (req: Request, res: Response): Promise<void> => {
    const input: CancelPipInput = req.body;
    res.json(await pipServiceFor(req.db).cancel(id(req), input, actor(req)));
  },
};
