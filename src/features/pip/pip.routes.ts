import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { pipController } from './pip.controller.js';
import {
  cancelPipSchema,
  createCheckinSchema,
  createPipSchema,
  decidePipSchema,
  pipOutcomeSchema,
} from './pip.schema.js';

/**
 * PIPs — mounted at /api/v1/pips. The person, their RM and HR (hrbp.people
 * in reach) share the door; the service gates every step.
 *
 *   GET  /?employeeId=        PIPs I can see
 *   GET  /:id                 one, with check-ins and what I may do
 *   POST /                    the RM opens one (targets, support, start)
 *   POST /:id/decide          HR approves or declines
 *   POST /:id/acknowledge     the employee
 *   POST /:id/checkins        the RM, every 2 weeks
 *   POST /:id/outcome         the RM at the end: passed / extend / not passed
 *   POST /:id/cancel          withdraw (RM before approval, HR any time)
 */
export const pipRoutes = Router();

pipRoutes.use(authenticate);

pipRoutes.get('/', pipController.list);
pipRoutes.post('/', validateBody(createPipSchema), pipController.create);
pipRoutes.get('/:id', pipController.get);
pipRoutes.post('/:id/decide', validateBody(decidePipSchema), pipController.decide);
pipRoutes.post('/:id/acknowledge', pipController.acknowledge);
pipRoutes.post('/:id/checkins', validateBody(createCheckinSchema), pipController.checkin);
pipRoutes.post('/:id/outcome', validateBody(pipOutcomeSchema), pipController.outcome);
pipRoutes.post('/:id/cancel', validateBody(cancelPipSchema), pipController.cancel);
