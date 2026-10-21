import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createSettingsRepository } from '../settings/index.js';
import { createCareerRepository } from './career.repository.js';
import type { AddTrackNoteInput, CloseTrackInput, OpenTrackInput } from './career.schema.js';
import { createCareerService } from './career.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createCareerService({
    repo: createCareerRepository(req.db),
    authz: createAuthzRepository(req.db),
    settings: createSettingsRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

/** HTTP layer only: read validated input, call the service, shape the response. */
export const careerController = {
  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(actor(req)));
  },

  request: async (req: Request, res: Response): Promise<void> => {
    const track = await service(req).request(actor(req));
    req.log.info({ track: track.id }, 'career conversation requested');
    res.status(201).json(track);
  },

  open: async (req: Request, res: Response): Promise<void> => {
    const input: OpenTrackInput = req.body;
    const track = await service(req).openForReport(input, actor(req));
    req.log.info({ employeeId: input.employeeId }, 'career track opened');
    res.status(201).json(track);
  },

  close: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid track id');
    const input: CloseTrackInput = req.body;
    res.json(await service(req).closeTrack(id, input, actor(req)));
  },

  addNote: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid track id');
    const input: AddTrackNoteInput = req.body;
    res.status(201).json(await service(req).addNote(id, input, actor(req)));
  },

  person: async (req: Request, res: Response): Promise<void> => {
    const { employeeId } = req.params;
    if (!isUuid(employeeId)) throw createError(400, 'Invalid employee id');
    res.json(await service(req).person(employeeId, actor(req)));
  },

  team: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).team(actor(req)));
  },
};
