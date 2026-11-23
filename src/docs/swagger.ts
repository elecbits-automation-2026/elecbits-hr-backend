import type { Express, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from '../config/env.js';
import { buildOpenApiDocument } from './openapi.js';

/**
 * Mounts the API docs:
 *  - GET /docs       Swagger UI
 *  - GET /docs.json  the raw OpenAPI document
 *
 * Development / testing only — skipped when NODE_ENV=production.
 * Generated once at startup from the feature Zod schemas. Mounted before
 * helmet in app.ts so Swagger UI's inline assets aren't blocked by the API's
 * strict CSP.
 */
export const mountDocs = (app: Express): void => {
  // Not in production: a public, ready-made map of every endpoint helps
  // nobody but an attacker. Use a local or testing server to read the docs.
  if (env.isProduction) return;
  const doc = buildOpenApiDocument();

  // Raw spec, registered BEFORE the UI mount so its fetch resolves to this
  // route rather than swagger-ui's static asset handler under /docs.
  app.get('/docs.json', (_req: Request, res: Response) => {
    res.json(doc);
  });

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(doc));
};
