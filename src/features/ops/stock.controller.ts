import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { actorOf, idParam } from './assets.controller.js';
import { createOpsRepository } from './ops.repository.js';
import { createStockRepository } from './stock.repository.js';
import type {
  CreateStockItemInput,
  StockMoveInput,
  UpdateStockItemInput,
} from './stock.schema.js';
import { createStockService } from './stock.service.js';

/** Composition root: request-scoped service. */
export const stockServiceFor = (req: Request) =>
  createStockService({
    repo: createStockRepository(req.db),
    ops: createOpsRepository(req.db),
  });

const optionalUuid = (v: unknown, name: string): string | undefined => {
  if (typeof v !== 'string' || v === '') return undefined;
  if (!isUuid(v)) throw createError(400, `Invalid ${name}`);
  return v;
};

/** HTTP layer only. */
export const stockController = {
  overview: async (req: Request, res: Response): Promise<void> => {
    res.json(await stockServiceFor(req).overview());
  },
  createItem: async (req: Request, res: Response): Promise<void> => {
    const input: CreateStockItemInput = req.body;
    res.status(201).json(await stockServiceFor(req).createItem(input, actorOf(req)));
  },
  updateItem: async (req: Request, res: Response): Promise<void> => {
    const input: UpdateStockItemInput = req.body;
    res.json(await stockServiceFor(req).updateItem(idParam(req), input, actorOf(req)));
  },
  move: async (req: Request, res: Response): Promise<void> => {
    const input: StockMoveInput = req.body;
    const out = await stockServiceFor(req).move(input, actorOf(req));
    req.log.info({ kind: input.kind, itemId: input.itemId }, 'stock moved');
    res.status(201).json(out);
  },
  movements: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await stockServiceFor(req).movements({
        itemId: optionalUuid(req.query.itemId, 'itemId'),
        employeeId: optionalUuid(req.query.employeeId, 'employeeId'),
      }),
    );
  },
};
