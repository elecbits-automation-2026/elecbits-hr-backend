import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { pipController } from './pip.controller.js';
import {
  cancelPipSchema,
  createPipSchema,
  pipOutcomeSchema,
} from './pip.schema.js';

/**
 * PIPs — mounted at /api/v1/pips. The person, their RM and HR (hrbp.people
 * in reach) share the door; the service gates every step.
 *
 *   GET  /?employeeId=        PIPs I can see
 *   GET  /can-start/:employeeId  { canStart } — the RM, or HR when there is no RM
 *   GET  /:id                 one, with what I may do
 *   POST /                    the RM opens one (targets, support, start) — active at
 *                             once, 60 days; HR and the employee are told
 *   POST /:id/outcome         the RM at the end: passed / extend / not passed
 *   POST /:id/cancel          withdraw (the RM or HR)
 */
export const pipRoutes = Router();

pipRoutes.use(authenticate);

pipRoutes.get('/', pipController.list);
pipRoutes.post('/', validateBody(createPipSchema), pipController.create);
pipRoutes.get('/can-start/:employeeId', pipController.canStart);
pipRoutes.get('/:id', pipController.get);
pipRoutes.post('/:id/outcome', validateBody(pipOutcomeSchema), pipController.outcome);
pipRoutes.post('/:id/cancel', validateBody(cancelPipSchema), pipController.cancel);
