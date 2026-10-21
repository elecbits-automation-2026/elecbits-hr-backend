import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createOpsCustodyReader } from '../ops/index.js';
import { createSettingsRepository } from '../settings/index.js';
import { createExitsFnf } from './exits.fnf.js';
import { createExitsRepository } from './exits.repository.js';
import type {
  AcceptInput,
  AcknowledgeInput,
  CancelExitInput,
  ClearInput,
  InterviewInput,
  ResignInput,
  TerminateInput,
} from './exits.schema.js';
import { createExitsService } from './exits.service.js';

/** Composition root: request-scoped service. */
export const exitsServiceFor = (req: Request) =>
  createExitsService({
    repo: createExitsRepository(req.db),
    authz: createAuthzRepository(req.db),
    custody: createOpsCustodyReader(req.db),
    fnf: createExitsFnf(req.db),
    settings: createSettingsRepository(req.db),
  });

const actor = (req: Request) => {
  if (!req.auth) throw createError(401, 'Authentication required');
  return { actorUserId: req.auth.userId, actorEmployeeId: req.auth.employeeId };
};

const id = (req: Request): string => {
  const v = req.params.id;
  if (!isUuid(v)) throw createError(400, 'Invalid id');
  return v;
};

/** HTTP layer only. The reason and interview answers are never logged. */
export const exitsController = {
  list: async (req: Request, res: Response): Promise<void> => {
    res.json(await exitsServiceFor(req).list(actor(req).actorEmployeeId));
  },
  team: async (req: Request, res: Response): Promise<void> => {
    res.json(await exitsServiceFor(req).team(actor(req).actorEmployeeId));
  },
  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await exitsServiceFor(req).mine(actor(req).actorEmployeeId));
  },
  get: async (req: Request, res: Response): Promise<void> => {
    res.json(await exitsServiceFor(req).get(id(req), actor(req).actorEmployeeId));
  },
  resign: async (req: Request, res: Response): Promise<void> => {
    const input: ResignInput = req.body;
    res.status(201).json(await exitsServiceFor(req).resign(input, actor(req)));
  },
  terminate: async (req: Request, res: Response): Promise<void> => {
    const input: TerminateInput = req.body;
    const out = await exitsServiceFor(req).terminate(input, actor(req));
    req.log.info({ exitId: out.id }, 'termination started');
    res.status(201).json(out);
  },
  withdraw: async (req: Request, res: Response): Promise<void> => {
    res.json(await exitsServiceFor(req).withdraw(id(req), actor(req)));
  },
  acknowledge: async (req: Request, res: Response): Promise<void> => {
    const input: AcknowledgeInput = req.body;
    res.json(await exitsServiceFor(req).acknowledge(id(req), input, actor(req)));
  },
  accept: async (req: Request, res: Response): Promise<void> => {
    const input: AcceptInput = req.body;
    res.json(await exitsServiceFor(req).accept(id(req), input, actor(req)));
  },
  cancel: async (req: Request, res: Response): Promise<void> => {
    const input: CancelExitInput = req.body;
    res.json(await exitsServiceFor(req).cancel(id(req), input, actor(req)));
  },
  clear: async (req: Request, res: Response): Promise<void> => {
    const input: ClearInput = req.body;
    res.json(await exitsServiceFor(req).clear(id(req), input, actor(req)));
  },
  interview: async (req: Request, res: Response): Promise<void> => {
    const input: InterviewInput = req.body;
    res.json(await exitsServiceFor(req).interview(id(req), input, actor(req)));
  },
  letter: async (req: Request, res: Response): Promise<void> => {
    const which = req.params.which;
    if (which !== 'relieving' && which !== 'experience') {
      throw createError(404, 'No such letter');
    }
    const { pdf, fileName } = await exitsServiceFor(req).letter(
      id(req),
      which,
      actor(req).actorEmployeeId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(pdf);
  },
};
