import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createSettingsRepository } from '../settings/index.js';
import { createRecognitionsRepository } from './recognitions.repository.js';
import type {
  CreateRecognitionInput,
  DecideRecognitionInput,
} from './recognitions.schema.js';
import { createRecognitionsService } from './recognitions.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createRecognitionsService({
    repo: createRecognitionsRepository(req.db),
    authz: createAuthzRepository(req.db),
    settings: createSettingsRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

/** HTTP layer only: read validated input, call the service, shape the response. */
export const recognitionsController = {
  nominate: async (req: Request, res: Response): Promise<void> => {
    const input: CreateRecognitionInput = req.body;
    const dto = await service(req).nominate(input, actor(req));
    req.log.info(
      { recipients: input.employeeIds.length, type: input.type },
      'recognition nominated',
    );
    res.status(201).json(dto);
  },

  decide: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid recognition id');
    const input: DecideRecognitionInput = req.body;
    const dto = await service(req).decide(id, input, actor(req));
    req.log.info({ id, decision: input.decision }, 'recognition decided');
    res.json(dto);
  },

  board: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).board());
  },

  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(req.auth!.employeeId));
  },

  sent: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).sent(req.auth!.employeeId));
  },

  pending: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).pending(actor(req)));
  },

  directory: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).directory(actor(req)));
  },

  catalog: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).awardCatalog());
  },
};
