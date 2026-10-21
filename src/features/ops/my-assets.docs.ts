import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from '../../shared/zod.js';
import { assetSchema, reportIncidentSchema } from './assets.schema.js';
import { opsPath } from './assets.docs.js';
import { extendReturnSchema, gatePassSchema } from './gate-passes.schema.js';
import { myAssetsSchema } from './my-assets.schema.js';

/** OpenAPI registration for the employee's own asset endpoints. */
export const registerMyAssetsDocs = (registry: OpenAPIRegistry): void => {
  opsPath(
    registry,
    'get',
    '/api/v1/my-assets',
    'What I hold, my passes, requests and stock',
    myAssetsSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/my-assets/loans/{id}/back',
    'A lent item is back at its zone',
    assetSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/my-assets/loans/{id}/extend',
    'Still out: reason and new date',
    assetSchema,
    extendReturnSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/my-assets/passes/{id}/back',
    'A gate-pass item is back',
    gatePassSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/my-assets/passes/{id}/extend',
    'Still out: reason and new date',
    gatePassSchema,
    extendReturnSchema,
  );
  opsPath(
    registry,
    'post',
    '/api/v1/my-assets/{id}/incidents',
    'Report damage, loss or theft of an item I hold',
    z.object({ ok: z.boolean() }),
    reportIncidentSchema,
  );
};
