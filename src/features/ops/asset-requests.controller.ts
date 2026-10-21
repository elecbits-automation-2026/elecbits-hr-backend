import type { Request, Response } from 'express';
import { keepReachable, peopleScopeOf } from '../../middleware/authorize.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createAssetRequestsRepository } from './asset-requests.repository.js';
import type {
  CreateAssetRequestInput,
  FulfilAssetRequestInput,
  UpdateAssetRequestInput,
} from './asset-requests.schema.js';
import { createAssetRequestsService } from './asset-requests.service.js';
import { actorOf, assetsServiceFor, idParam } from './assets.controller.js';
import { createOpsRepository } from './ops.repository.js';

/** Composition root: request-scoped service. */
export const assetRequestsServiceFor = (req: Request) =>
  createAssetRequestsService({
    repo: createAssetRequestsRepository(req.db),
    ops: createOpsRepository(req.db),
    assets: assetsServiceFor(req),
    authz: createAuthzRepository(req.db),
  });

export const assetRequestsController = {
  listQueue: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await keepReachable(
        req,
        await assetRequestsServiceFor(req).listQueue(),
        (r) => r.requestedBy.id,
      ),
    );
  },

  listMine: async (req: Request, res: Response): Promise<void> => {
    res.json(await assetRequestsServiceFor(req).listMine(actorOf(req).actorEmployeeId));
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateAssetRequestInput = req.body;
    const request = await assetRequestsServiceFor(req).create(input, actorOf(req));
    req.log.info({ requestId: request.id, type: request.type }, 'asset request queued');
    res.status(201).json(request);
  },

  handle: async (req: Request, res: Response): Promise<void> => {
    const input: UpdateAssetRequestInput = req.body;
    res.json(
      await assetRequestsServiceFor(req).handle(
        idParam(req),
        input,
        actorOf(req),
        await peopleScopeOf(req),
      ),
    );
  },

  fulfil: async (req: Request, res: Response): Promise<void> => {
    const input: FulfilAssetRequestInput = req.body;
    res.json(
      await assetRequestsServiceFor(req).fulfil(
        idParam(req),
        input,
        actorOf(req),
        await peopleScopeOf(req),
      ),
    );
  },
};
