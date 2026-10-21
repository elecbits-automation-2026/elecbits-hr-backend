import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createOpenDoorRepository } from './openDoor.repository.js';
import type { BookInput, CreateSlotInput, MarkInput } from './openDoor.schema.js';
import { createOpenDoorService } from './openDoor.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createOpenDoorService({
    repo: createOpenDoorRepository(req.db),
    authz: createAuthzRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

const requireId = (req: Request): string => {
  const { id } = req.params;
  if (!isUuid(id)) throw createError(400, 'Invalid id');
  return id;
};

/** HTTP layer only. Topics are never logged. */
export const openDoorController = {
  slots: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).slots(req.auth!.employeeId));
  },
  me: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).me(req.auth!.employeeId));
  },
  createSlot: async (req: Request, res: Response): Promise<void> => {
    const input: CreateSlotInput = req.body;
    res.status(201).json(await service(req).createSlot(input, actor(req)));
  },
  cancelSlot: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).cancelSlot(requireId(req), actor(req)));
  },
  book: async (req: Request, res: Response): Promise<void> => {
    const input: BookInput = req.body;
    await service(req).book(requireId(req), input, actor(req));
    res.status(201).json(await service(req).me(req.auth!.employeeId));
  },
  cancelBooking: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).cancelBooking(requireId(req), actor(req)));
  },
  mark: async (req: Request, res: Response): Promise<void> => {
    const input: MarkInput = req.body;
    res.json(await service(req).mark(requireId(req), input, actor(req)));
  },
};
