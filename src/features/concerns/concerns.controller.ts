import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createSettingsRepository } from '../settings/index.js';
import { createConcernsRepository } from './concerns.repository.js';
import type {
  CreateConcernInput,
  DecideInput,
  DeclineInput,
  EscalateInput,
  ExtendInput,
  FollowUpInput,
  FollowUpNoteInput,
  NoteInput,
  QueueName,
  ResolveInput,
} from './concerns.schema.js';
import { createConcernsService } from './concerns.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createConcernsService({
    repo: createConcernsRepository(req.db),
    authz: createAuthzRepository(req.db),
    settings: createSettingsRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

const requireId = (req: Request): string => {
  const { id } = req.params;
  if (!isUuid(id)) throw createError(400, 'Invalid concern id');
  return id;
};

const QUEUES = new Set<QueueName>(['manager', 'hr', 'mrc', 'vigil']);

/** HTTP layer only. Bodies are never logged — confidentiality (policy §9). */
export const concernsController = {
  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateConcernInput = req.body;
    const out = await service(req).create(input, actor(req));
    req.log.info({ concern: out.concern.id, track: out.concern.track }, 'concern raised');
    res.status(201).json(out);
  },

  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(req.auth!.employeeId));
  },

  people: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).people(req.auth!.employeeId));
  },

  queues: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).queues(req.auth!.employeeId));
  },

  queue: async (req: Request, res: Response): Promise<void> => {
    const name = req.params.queue as QueueName;
    if (!QUEUES.has(name)) throw createError(404, 'No such queue');
    res.json(await service(req).queue(name, req.auth!.employeeId));
  },

  get: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).get(requireId(req), req.auth!.employeeId));
  },

  note: async (req: Request, res: Response): Promise<void> => {
    const input: NoteInput = req.body;
    res.status(201).json(await service(req).addNote(requireId(req), input, actor(req)));
  },

  acknowledge: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).acknowledge(requireId(req), actor(req)));
  },

  decide: async (req: Request, res: Response): Promise<void> => {
    const input: DecideInput = req.body;
    res.json(await service(req).decide(requireId(req), input, actor(req)));
  },

  resolve: async (req: Request, res: Response): Promise<void> => {
    const input: ResolveInput = req.body;
    res.json(await service(req).resolve(requireId(req), input, actor(req)));
  },

  extend: async (req: Request, res: Response): Promise<void> => {
    const input: ExtendInput = req.body;
    res.json(await service(req).extend(requireId(req), input, actor(req)));
  },

  decline: async (req: Request, res: Response): Promise<void> => {
    const input: DeclineInput = req.body;
    res.json(await service(req).decline(requireId(req), input, actor(req)));
  },

  accept: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).accept(requireId(req), actor(req)));
  },

  escalate: async (req: Request, res: Response): Promise<void> => {
    const input: EscalateInput = req.body;
    res.json(await service(req).escalate(requireId(req), input, actor(req)));
  },

  followUp: async (req: Request, res: Response): Promise<void> => {
    const input: FollowUpInput = req.body;
    res.json(await service(req).followUp(input));
  },

  followUpNote: async (req: Request, res: Response): Promise<void> => {
    const input: FollowUpNoteInput = req.body;
    res.status(201).json(await service(req).followUpNote(input));
  },
};
