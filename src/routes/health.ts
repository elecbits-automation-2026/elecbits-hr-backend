import { Router, type Request, type Response } from 'express';

/**
 * Liveness and readiness probes.
 *
 *  - GET /health : liveness. Is the process up and serving? No dependencies are
 *    touched, so a DB blip never makes an orchestrator kill a healthy process.
 *  - GET /ready  : readiness. Can we actually serve traffic right now? Verifies
 *    the database is reachable; returns 503 when it is not.
 */
export const healthRoutes = Router();

healthRoutes.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

healthRoutes.get('/ready', async (req: Request, res: Response) => {
  // A failed probe must be 503 (not ready), never a 500. healthcheck() throws
  // when the pool can't connect, so treat any throw as "not ready" too.
  let ok = false;
  try {
    ok = await req.db.healthcheck();
  } catch {
    ok = false;
  }
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'unavailable', db: ok });
});
