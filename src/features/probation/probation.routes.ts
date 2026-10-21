import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { probationController } from './probation.controller.js';
import { decideSchema, recommendSchema } from './probation.schema.js';

/**
 * Probation decisions — mounted at /api/v1/probation. HR (hrbp.people in
 * reach), the person's RM and the person share the door; the service gates.
 *
 *   GET  /                 reviews I can see (HR in reach, my reports)
 *   GET  /mine             my own review (and its letter once confirmed)
 *   POST /:id/recommend    the RM: confirm or end, with a note
 *   POST /:id/decide       HR: confirm, or end (starts a termination exit)
 *   GET  /:id/letter       the confirmation letter PDF
 */
export const probationRoutes = Router();

probationRoutes.use(authenticate);

probationRoutes.get('/', probationController.list);
probationRoutes.get('/mine', probationController.mine);
probationRoutes.post(
  '/:id/recommend',
  validateBody(recommendSchema),
  probationController.recommend,
);
probationRoutes.post(
  '/:id/decide',
  validateBody(decideSchema),
  probationController.decide,
);
probationRoutes.get('/:id/letter', probationController.letter);
