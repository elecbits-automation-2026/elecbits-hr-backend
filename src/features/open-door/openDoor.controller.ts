import type { Request, Response } from 'express';
import createError from 'http-errors';
import type { DbClient } from '../../db/client.js';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createConcernsRepository, createConcernsService } from '../concerns/index.js';
import { createSettingsRepository } from '../settings/index.js';
import { createOpenDoorRepository } from './openDoor.repository.js';
import type {
  BookInput,
  CreateRequestInput,
  CreateSlotInput,
  DeclineRequestInput,
  MarkInput,
  OfferRequestInput,
} from './openDoor.schema.js';
import { createOpenDoorService } from './openDoor.service.js';

/**
 * Composition root (also used by the scheduler). Concerns is wired in for
 * "request a meeting about this case" (who handles it, the case line).
 */
export const openDoorServiceFor = (db: DbClient) =>
  createOpenDoorService({
    repo: createOpenDoorRepository(db),
    authz: createAuthzRepository(db),
    concerns: createConcernsService({
      repo: createConcernsRepository(db),
      authz: createAuthzRepository(db),
      settings: createSettingsRepository(db),
    }),
  });

const service = (req: Request) => openDoorServiceFor(req.db);

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

  hosts: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).hosts(req.auth!.employeeId));
  },
  requests: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).requests(req.auth!.employeeId));
  },
  createRequest: async (req: Request, res: Response): Promise<void> => {
    const input: CreateRequestInput = req.body;
    res.status(201).json(await service(req).createRequest(input, actor(req)));
  },
  offerRequest: async (req: Request, res: Response): Promise<void> => {
    const input: OfferRequestInput = req.body;
    res.json(await service(req).offerRequest(requireId(req), input, actor(req)));
  },
  declineRequest: async (req: Request, res: Response): Promise<void> => {
    const input: DeclineRequestInput = req.body;
    res.json(await service(req).declineRequest(requireId(req), input, actor(req)));
  },
  cancelRequest: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).cancelRequest(requireId(req), actor(req)));
  },
};
