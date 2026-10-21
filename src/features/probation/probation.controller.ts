import type { Request, Response } from 'express';
import createError from 'http-errors';
import type { DbClient } from '../../db/client.js';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import {
  createExitsFnf,
  createExitsRepository,
  createExitsService,
} from '../exits/index.js';
import { createOpsCustodyReader } from '../ops/index.js';
import { createSettingsRepository } from '../settings/index.js';
import { createProbationRepository } from './probation.repository.js';
import type { DecideInput, RecommendInput } from './probation.schema.js';
import { createProbationService } from './probation.service.js';

/** Composition root (also used by the scheduler). Ending a probation starts an exit. */
export const probationServiceFor = (db: DbClient) =>
  createProbationService({
    repo: createProbationRepository(db),
    authz: createAuthzRepository(db),
    settings: createSettingsRepository(db),
    exits: createExitsService({
      repo: createExitsRepository(db),
      authz: createAuthzRepository(db),
      custody: createOpsCustodyReader(db),
      fnf: createExitsFnf(db),
      settings: createSettingsRepository(db),
    }),
  });

const actor = (req: Request) => {
  if (!req.auth) throw createError(401, 'Authentication required');
  return { actorUserId: req.auth.userId, actorEmployeeId: req.auth.employeeId };
};

const id = (req: Request) => {
  if (!isUuid(req.params.id)) throw createError(400, 'Invalid id');
  return req.params.id;
};

/** HTTP layer only. */
export const probationController = {
  list: async (req: Request, res: Response): Promise<void> => {
    res.json(await probationServiceFor(req.db).list(actor(req).actorEmployeeId));
  },
  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await probationServiceFor(req.db).mine(actor(req).actorEmployeeId));
  },
  recommend: async (req: Request, res: Response): Promise<void> => {
    const input: RecommendInput = req.body;
    res.json(await probationServiceFor(req.db).recommend(id(req), input, actor(req)));
  },
  decide: async (req: Request, res: Response): Promise<void> => {
    const input: DecideInput = req.body;
    const out = await probationServiceFor(req.db).decide(id(req), input, actor(req));
    req.log.info({ reviewId: out.id, status: out.status }, 'probation decided');
    res.json(out);
  },
  letter: async (req: Request, res: Response): Promise<void> => {
    const { pdf, fileName } = await probationServiceFor(req.db).letter(
      id(req),
      actor(req).actorEmployeeId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(pdf);
  },
};
