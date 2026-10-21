import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { stockController } from './stock.controller.js';
import {
  createStockItemSchema,
  stockMoveSchema,
  updateStockItemSchema,
} from './stock.schema.js';

/**
 * Consumable stock — mounted at /api/v1/stock (grant: ops.stock, org scope).
 *
 *   GET   /                      items, zones, per-zone levels
 *   POST  /items                 add an item
 *   PATCH /items/:id             edit / archive
 *   POST  /movements             in / issue / transfer / adjust
 *   GET   /movements?itemId=&employeeId=   the ledger, newest first
 */
export const stockRoutes = Router();

stockRoutes.use(authenticate);

const read = requireAccess('ops.stock', 'read', { orgOnly: true });
const create = requireAccess('ops.stock', 'create', { orgOnly: true });
const update = requireAccess('ops.stock', 'update', { orgOnly: true });

stockRoutes.get('/', read, stockController.overview);
stockRoutes.post(
  '/items',
  create,
  validateBody(createStockItemSchema),
  stockController.createItem,
);
stockRoutes.patch(
  '/items/:id',
  update,
  validateBody(updateStockItemSchema),
  stockController.updateItem,
);
stockRoutes.post(
  '/movements',
  update,
  validateBody(stockMoveSchema),
  stockController.move,
);
stockRoutes.get('/movements', read, stockController.movements);
