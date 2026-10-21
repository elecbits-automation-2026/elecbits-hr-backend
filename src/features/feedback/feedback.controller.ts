import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createFeedbackRepository } from './feedback.repository.js';
import type { CreateFeedbackInput } from './feedback.schema.js';
import { createFeedbackService } from './feedback.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createFeedbackService({
    repo: createFeedbackRepository(req.db),
    authz: createAuthzRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

export const feedbackController = {
  send: async (req: Request, res: Response): Promise<void> => {
    const input: CreateFeedbackInput = req.body;
    const note = await service(req).send(input, actor(req));
    req.log.info({ recipient: input.employeeId, type: input.type }, 'feedback sent');
    res.status(201).json(note);
  },

  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(req.auth!.employeeId));
  },

  sent: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).sent(req.auth!.employeeId));
  },

  history: async (req: Request, res: Response): Promise<void> => {
    const { employeeId } = req.params;
    if (!isUuid(employeeId)) throw createError(400, 'Invalid employee id');
    res.json(await service(req).history(employeeId, req.auth!.employeeId));
  },
};
