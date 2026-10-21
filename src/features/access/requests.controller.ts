import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from './authz.repository.js';
import { createRequestsRepository } from './requests.repository.js';
import type {
  CreateGrantRequestInput,
  DecideGrantRequestInput,
} from './requests.schema.js';
import { createRequestsService } from './requests.service.js';

/** Composition root: request-scoped repo + the authz read (HR check on create). */
const service = (req: Request) =>
  createRequestsService({
    repo: createRequestsRepository(req.db),
    authz: createAuthzRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

export const requestsController = {
  list: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).list());
  },

  options: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).options(req.auth!.employeeId));
  },

  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(req.auth!.employeeId));
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateGrantRequestInput = req.body;
    const request = await service(req).create(input, actor(req));
    req.log.info({ requestId: request.id }, 'grant request submitted');
    res.status(201).json(request);
  },

  decide: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid request id');
    const input: DecideGrantRequestInput = req.body;
    const request = await service(req).decide(id, input, actor(req));
    req.log.info({ requestId: id, status: request.status }, 'grant request decided');
    res.json(request);
  },
};
