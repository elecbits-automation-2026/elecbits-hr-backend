import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { concernsController } from './concerns.controller.js';
import {
  createConcernSchema,
  decideSchema,
  declineSchema,
  escalateSchema,
  extendSchema,
  followUpNoteSchema,
  followUpSchema,
  noteSchema,
  resolveSchema,
} from './concerns.schema.js';

/**
 * Concerns (Batch 4) — mounted at /api/v1/concerns.
 *
 *   POST /                    raise (dispute | complaint | whistleblower)
 *   GET  /mine                own named cases
 *   GET  /people              colleagues a concern can be about (not the caller)
 *   GET  /queues              the caller's queues with open/overdue counts
 *   GET  /queue/:queue        manager | hr | mrc | vigil
 *   GET  /:id                 raiser view or handler view (else 404)
 *   POST /:id/notes           raiser note, or handler note / reply
 *   POST /:id/acknowledge | /decide | /resolve | /extend | /decline   handlers
 *   POST /:id/accept | /escalate                                       raiser (disputes)
 *   POST /follow-up · /follow-up/notes   anonymous raiser by code + key
 *
 * No requireAccess: who may act is a per-case question (the effective RM,
 * HR reaching the raiser, the Management Review Committee, the vigil team;
 * never the subject) — answered in the service, 404 when not theirs.
 */
export const concernsRoutes = Router();

concernsRoutes.use(authenticate);

concernsRoutes.post('/', validateBody(createConcernSchema), concernsController.create);
concernsRoutes.get('/mine', concernsController.mine);
concernsRoutes.get('/people', concernsController.people);
concernsRoutes.get('/queues', concernsController.queues);
concernsRoutes.get('/queue/:queue', concernsController.queue);
concernsRoutes.post(
  '/follow-up',
  validateBody(followUpSchema),
  concernsController.followUp,
);
concernsRoutes.post(
  '/follow-up/notes',
  validateBody(followUpNoteSchema),
  concernsController.followUpNote,
);
concernsRoutes.get('/:id', concernsController.get);
concernsRoutes.post('/:id/notes', validateBody(noteSchema), concernsController.note);
concernsRoutes.post('/:id/acknowledge', concernsController.acknowledge);
concernsRoutes.post('/:id/decide', validateBody(decideSchema), concernsController.decide);
concernsRoutes.post(
  '/:id/resolve',
  validateBody(resolveSchema),
  concernsController.resolve,
);
concernsRoutes.post('/:id/extend', validateBody(extendSchema), concernsController.extend);
concernsRoutes.post(
  '/:id/decline',
  validateBody(declineSchema),
  concernsController.decline,
);
concernsRoutes.post('/:id/accept', concernsController.accept);
concernsRoutes.post(
  '/:id/escalate',
  validateBody(escalateSchema),
  concernsController.escalate,
);
