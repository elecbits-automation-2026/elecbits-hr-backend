import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from '../../shared/zod.js';
import { opsPath } from './assets.docs.js';
import {
  createStockItemSchema,
  stockMoveSchema,
  stockMovementSchema,
  stockOverviewSchema,
  updateStockItemSchema,
} from './stock.schema.js';

/** OpenAPI registration for the stock endpoints. */
export const registerStockDocs = (registry: OpenAPIRegistry): void => {
  opsPath(
    registry,
    'get',
    '/api/v1/stock',
    'Items, zones and per-zone levels',
    stockOverviewSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/stock/items',
    'Add a stock item',
    stockOverviewSchema,
    createStockItemSchema,
  );
  opsPath(
    registry,
    'patch',
    '/api/v1/stock/items/{id}',
    'Edit or archive a stock item',
    stockOverviewSchema,
    updateStockItemSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/stock/movements',
    'Stock in / issue / transfer / adjust',
    stockOverviewSchema,
    stockMoveSchema,
  );
  opsPath(
    registry,
    'get',
    '/api/v1/stock/movements',
    'The stock ledger',
    z.array(stockMovementSchema),
  );
};
