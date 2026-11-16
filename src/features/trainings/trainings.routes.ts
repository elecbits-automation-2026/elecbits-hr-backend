import { Router, raw } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { trainingsController } from './trainings.controller.js';
import { assignTrainingSchema, completeTrainingSchema } from './trainings.schema.js';

/**
 * Trainings — mounted at /api/v1/trainings. Who may assign / reopen /
 * withdraw is a RELATIONSHIP (manager of the person) or HR reach, checked in
 * the service; only the org-wide list is gated here.
 *
 *   GET  /mine                    -> 200 Training[]
 *   GET  /team                    -> 200 Training[]   your reports'
 *   GET  /                        -> 200 Training[]   everyone (HR)
 *   GET  /person/:employeeId      -> 200 Training[]   the person sheet (self, manager, HR)
 *   POST /                        -> 201 AssignTrainingResult
 *   POST /:id/complete            -> 200 Training     the person only
 *   POST /:id/reopen              -> 200 Training
 *   POST /:id/cancel              -> 200 Training
 *   PUT  /:id/certificate         -> 200 Training     raw file body, the person only
 *   GET  /:id/certificate         -> 200 file
 */
export const trainingsRoutes = Router();

trainingsRoutes.use(authenticate);

trainingsRoutes.get('/mine', trainingsController.mine);
trainingsRoutes.get('/team', trainingsController.team);
trainingsRoutes.get(
  '/',
  requireAccess('hrbp.people', 'read', { orgOnly: true }),
  trainingsController.all,
);
trainingsRoutes.get('/person/:employeeId', trainingsController.forPerson);
trainingsRoutes.post('/', validateBody(assignTrainingSchema), trainingsController.assign);
trainingsRoutes.post(
  '/:id/complete',
  validateBody(completeTrainingSchema),
  trainingsController.complete,
);
trainingsRoutes.post('/:id/reopen', trainingsController.reopen);
trainingsRoutes.post('/:id/cancel', trainingsController.cancel);
trainingsRoutes.put(
  '/:id/certificate',
  raw({ type: () => true, limit: '10mb' }),
  trainingsController.uploadCertificate,
);
trainingsRoutes.get('/:id/certificate', trainingsController.certificate);
