import 'express-async-errors'; // makes async route rejections reach errorHandler (Express 4)
import express, { type Express } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';

import { env } from './config/env.js';
import { mountDocs } from './docs/swagger.js';
import { dbConnection } from './middleware/dbConnection.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { healthRoutes } from './routes/health.js';
import { apiV1 } from './routes/index.js';

/**
 * Builds the Express application (no `listen` here — that lives in server.ts so
 * the app stays importable for tests). Middleware is registered in the order a
 * request flows through it; the error handler is registered last.
 */
export function createApp(): Express {
  const app = express();

  // No proxy locally; behind the future ALB this trusts one hop (see env.ts).
  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');

  // --- Observability (first, so every request gets an id + a log line) ------
  app.use(requestLogger);

  // --- API docs (before helmet so Swagger UI's inline assets aren't CSP-blocked)
  mountDocs(app);

  // --- Security & transport -------------------------------------------------
  app.use(helmet());
  app.use(compression());
  app.use(
    cors({
      // Explicit allow-list in prod; reflect any origin in dev for convenience.
      origin: env.corsOrigins.length > 0 ? env.corsOrigins : !env.isProduction,
      credentials: true,
      // Downloads (payslip PDFs) name themselves through this header.
      exposedHeaders: ['Content-Disposition'],
    }),
  );

  // Shared DB handle on every request (cheap; pool is lazy/persistent).
  app.use(dbConnection);

  // --- Probes (before anything that could throttle or reject them) ----------
  app.use(healthRoutes);

  app.use(express.json({ limit: env.bodyLimit }));

  // --- Feature routers ------------------------------------------------------
  app.use('/api/v1', apiV1);

  // --- Fallbacks (must be last) ---------------------------------------------
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
