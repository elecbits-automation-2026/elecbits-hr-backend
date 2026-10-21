import type { Request, Response } from 'express';
import { actorOf, idParam } from './assets.controller.js';
import { createAssetSetupRepository } from './asset-setup.repository.js';
import type {
  CreateCategoryInput,
  PutKitInput,
  UpdateCategoryInput,
} from './asset-setup.schema.js';
import { createAssetSetupService } from './asset-setup.service.js';
import { createOpsRepository } from './ops.repository.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createAssetSetupService({
    repo: createAssetSetupRepository(req.db),
    ops: createOpsRepository(req.db),
  });

/** HTTP layer only. */
export const assetSetupController = {
  overview: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).overview());
  },
  createCategory: async (req: Request, res: Response): Promise<void> => {
    const input: CreateCategoryInput = req.body;
    res.status(201).json(await service(req).createCategory(input, actorOf(req)));
  },
  updateCategory: async (req: Request, res: Response): Promise<void> => {
    const input: UpdateCategoryInput = req.body;
    res.json(await service(req).updateCategory(idParam(req), input, actorOf(req)));
  },
  putKit: async (req: Request, res: Response): Promise<void> => {
    const input: PutKitInput = req.body;
    res.json(await service(req).putKit(input, actorOf(req)));
  },
};
