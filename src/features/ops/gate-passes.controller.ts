import type { Request, Response } from 'express';
import { keepReachable, peopleScopeOf } from '../../middleware/authorize.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { actorOf, idParam } from './assets.controller.js';
import { createGatePassesRepository } from './gate-passes.repository.js';
import type { CreateGatePassInput, DeclineGatePassInput } from './gate-passes.schema.js';
import { createGatePassesService } from './gate-passes.service.js';
import { createOpsRepository } from './ops.repository.js';

/** Composition root: request-scoped service. */
export const gatePassesServiceFor = (req: Request) =>
  createGatePassesService({
    repo: createGatePassesRepository(req.db),
    ops: createOpsRepository(req.db),
    authz: createAuthzRepository(req.db),
  });

export const gatePassesController = {
  list: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await keepReachable(
        req,
        await gatePassesServiceFor(req).list(),
        (p) => p.holder.id,
      ),
    );
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateGatePassInput = req.body;
    const pass = await gatePassesServiceFor(req).create(input, actorOf(req));
    req.log.info({ gatePassId: pass.id, assetId: pass.asset.id }, 'gate pass requested');
    res.status(201).json(pass);
  },

  approve: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await gatePassesServiceFor(req).approve(
        idParam(req),
        actorOf(req),
        await peopleScopeOf(req),
      ),
    );
  },

  decline: async (req: Request, res: Response): Promise<void> => {
    const input: DeclineGatePassInput = req.body;
    res.json(
      await gatePassesServiceFor(req).decline(
        idParam(req),
        input,
        actorOf(req),
        await peopleScopeOf(req),
      ),
    );
  },

  back: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await gatePassesServiceFor(req).back(idParam(req), actorOf(req), {
        reach: await peopleScopeOf(req),
      }),
    );
  },
};
