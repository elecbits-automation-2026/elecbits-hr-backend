import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { feedbackController } from './feedback.controller.js';
import { createFeedbackSchema } from './feedback.schema.js';

/**
 * Feedback notes — mounted at /api/v1/feedback.
 *
 *   POST /        -> 201 FeedbackNote  (chain or broad hrbp.people — checked in service)
 *   GET  /mine    -> 200 FeedbackNote[] (notes received — me scope)
 *   GET  /sent    -> 200 FeedbackNote[] (notes the caller has sent)
 *   GET  /about/:employeeId -> 200 FeedbackNoteHistory[] (RM-or-HR; body only for the sender)
 *
 * No requireAccess on POST: like the approval slots, "may I note this person"
 * is a RELATIONSHIP question the service answers against the recipient row.
 */
export const feedbackRoutes = Router();

feedbackRoutes.use(authenticate);

feedbackRoutes.post('/', validateBody(createFeedbackSchema), feedbackController.send);
feedbackRoutes.get('/mine', feedbackController.mine);
feedbackRoutes.get('/sent', feedbackController.sent);
feedbackRoutes.get('/about/:employeeId', feedbackController.history);
