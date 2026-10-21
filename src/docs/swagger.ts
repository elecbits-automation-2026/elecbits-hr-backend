import type { Express, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './openapi.js';

/**
 * Mounts the API docs:
 *  - GET /docs       Swagger UI
 *  - GET /docs.json  the raw OpenAPI document
 *
 * Generated once at startup from the feature Zod schemas. Mounted before
 * helmet in app.ts so Swagger UI's inline assets aren't blocked by the API's
 * strict CSP.
 */
export const mountDocs = (app: Express): void => {
  const doc = buildOpenApiDocument();

  // Raw spec, registered BEFORE the UI mount so its fetch resolves to this
  // route rather than swagger-ui's static asset handler under /docs.
  app.get('/docs.json', (_req: Request, res: Response) => {
    res.json(doc);
  });

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(doc));
};
