import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createAssetsRepository } from './assets.repository.js';
import type {
  CloseIncidentInput,
  CreateAssetInput,
  ImportAssetsInput,
  IssueAssetInput,
  MoveAssetInput,
  ReportIncidentInput,
  ReturnAssetInput,
  SetAssetStatusInput,
  TransferAssetInput,
  UpdateAssetInput,
} from './assets.schema.js';
import { createAssetsService } from './assets.service.js';
import { createOpsRepository } from './ops.repository.js';

/** Composition root: request-scoped service. */
export const assetsServiceFor = (req: Request) =>
  createAssetsService({
    ops: createOpsRepository(req.db),
    repo: createAssetsRepository(req.db),
    authz: createAuthzRepository(req.db),
  });

export const actorOf = (req: Request) => {
  if (!req.auth) throw createError(401, 'Authentication required');
  return { actorUserId: req.auth.userId, actorEmployeeId: req.auth.employeeId };
};

export const idParam = (req: Request, name = 'id'): string => {
  const id = req.params[name];
  if (!isUuid(id)) throw createError(400, 'Invalid id');
  return id;
};

/** HTTP layer only. */
export const assetsController = {
  options: async (req: Request, res: Response): Promise<void> => {
    res.json(await assetsServiceFor(req).options());
  },

  list: async (req: Request, res: Response): Promise<void> => {
    const holderId =
      typeof req.query.holderId === 'string' ? req.query.holderId : undefined;
    if (holderId && !isUuid(holderId)) throw createError(400, 'Invalid holderId');
    res.json(await assetsServiceFor(req).list({ holderId }));
  },

  detail: async (req: Request, res: Response): Promise<void> => {
    res.json(await assetsServiceFor(req).detail(idParam(req)));
  },

  kitCheck: async (req: Request, res: Response): Promise<void> => {
    res.json(await assetsServiceFor(req).kitCheck(idParam(req, 'employeeId')));
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateAssetInput = req.body;
    const asset = await assetsServiceFor(req).create(input, actorOf(req));
    req.log.info({ assetId: asset.id }, 'asset registered');
    res.status(201).json(asset);
  },

  importRows: async (req: Request, res: Response): Promise<void> => {
    const input: ImportAssetsInput = req.body;
    const result = await assetsServiceFor(req).importRows(input, actorOf(req));
    req.log.info(
      { rows: input.rows.length, created: result.created, dryRun: !!input.dryRun },
      'asset import',
    );
    res.json(result);
  },

  update: async (req: Request, res: Response): Promise<void> => {
    const input: UpdateAssetInput = req.body;
    res.json(await assetsServiceFor(req).update(idParam(req), input, actorOf(req)));
  },

  issue: async (req: Request, res: Response): Promise<void> => {
    const input: IssueAssetInput = req.body;
    res.json(await assetsServiceFor(req).issue(idParam(req), input, actorOf(req)));
  },

  returnAsset: async (req: Request, res: Response): Promise<void> => {
    const input: ReturnAssetInput = req.body;
    res.json(await assetsServiceFor(req).returnAsset(idParam(req), input, actorOf(req)));
  },

  transfer: async (req: Request, res: Response): Promise<void> => {
    const input: TransferAssetInput = req.body;
    res.json(await assetsServiceFor(req).transfer(idParam(req), input, actorOf(req)));
  },

  move: async (req: Request, res: Response): Promise<void> => {
    const input: MoveAssetInput = req.body;
    res.json(await assetsServiceFor(req).move(idParam(req), input, actorOf(req)));
  },

  setStatus: async (req: Request, res: Response): Promise<void> => {
    const input: SetAssetStatusInput = req.body;
    res.json(await assetsServiceFor(req).setStatus(idParam(req), input, actorOf(req)));
  },

  incidents: async (req: Request, res: Response): Promise<void> => {
    res.json(await assetsServiceFor(req).incidents());
  },

  reportIncident: async (req: Request, res: Response): Promise<void> => {
    const input: ReportIncidentInput = req.body;
    res
      .status(201)
      .json(
        await assetsServiceFor(req).reportIncident(
          idParam(req),
          input,
          actorOf(req),
          true,
        ),
      );
  },

  closeIncident: async (req: Request, res: Response): Promise<void> => {
    const input: CloseIncidentInput = req.body;
    res.json(
      await assetsServiceFor(req).closeIncident(idParam(req), input, actorOf(req)),
    );
  },
};
