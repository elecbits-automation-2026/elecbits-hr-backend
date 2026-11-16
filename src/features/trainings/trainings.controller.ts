import type { Request, Response } from 'express';
import createError from 'http-errors';
import type { DbClient } from '../../db/client.js';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/index.js';
import { createTrainingsRepository } from './trainings.repository.js';
import type { AssignTrainingInput, CompleteTrainingInput } from './trainings.schema.js';
import { createTrainingsService } from './trainings.service.js';

/** Composition root — also used by the scheduler for the reminder job. */
export const trainingsServiceFor = (db: DbClient) =>
  createTrainingsService({
    repo: createTrainingsRepository(db),
    authz: createAuthzRepository(db),
  });

const service = (req: Request) => trainingsServiceFor(req.db);

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

const idParam = (req: Request, name = 'id'): string => {
  const id = req.params[name];
  if (!isUuid(id)) throw createError(400, 'Invalid id');
  return id;
};

/** HTTP layer only: read validated input, call the service, shape the response. */
export const trainingsController = {
  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(req.auth!.employeeId));
  },

  team: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).team(req.auth!.employeeId));
  },

  all: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).all());
  },

  forPerson: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).forPerson(idParam(req, 'employeeId'), actor(req)));
  },

  assign: async (req: Request, res: Response): Promise<void> => {
    const input: AssignTrainingInput = req.body;
    const out = await service(req).assign(input, actor(req));
    req.log.info(
      { assigned: out.assigned, skipped: out.skipped.length },
      'trainings assigned',
    );
    res.status(201).json(out);
  },

  complete: async (req: Request, res: Response): Promise<void> => {
    const input: CompleteTrainingInput = req.body;
    res.json(await service(req).complete(idParam(req), input, actor(req)));
  },

  reopen: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).reopen(idParam(req), actor(req)));
  },

  cancel: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).cancel(idParam(req), actor(req)));
  },

  uploadCertificate: async (req: Request, res: Response): Promise<void> => {
    const id = idParam(req);
    if (!Buffer.isBuffer(req.body)) {
      throw createError(422, 'Send the file as the raw request body', {
        code: 'NOT_A_FILE',
      });
    }
    const fileName = String(req.query.filename ?? 'certificate').slice(0, 200);
    const out = await service(req).uploadCertificate(
      id,
      { fileName, data: req.body },
      actor(req),
    );
    req.log.info(
      { trainingId: id, bytes: req.body.length },
      'training certificate stored',
    );
    res.json(out);
  },

  certificate: async (req: Request, res: Response): Promise<void> => {
    const file = await service(req).certificate(idParam(req), actor(req));
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${file.fileName.replaceAll('"', '')}"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.data);
  },
};
