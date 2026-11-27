import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { assistantController } from './assistant.controller.js';
import { chatSchema, quickSchema } from './assistant.schema.js';

/**
 * HR Assistant — mounted at /api/v1/assistant.
 *
 *   POST /chat   the conversation so far → the answer as server-sent events
 *                (action tools only PROPOSE; the drawer's Confirm calls the
 *                existing endpoint — goals, trainings, recognitions, hiring)
 *   POST /quick  one whitelisted read, no model (the offline buttons)
 *   GET  /access { allowed } — switch on and caller is HR or a manager
 *
 * No requireAccess: who may chat (HR or a manager) and which tools each
 * caller gets are resolved per request in the service, from grants and the
 * reporting line.
 */
export const assistantRoutes = Router();

assistantRoutes.use(authenticate);

assistantRoutes.get('/access', assistantController.access);
assistantRoutes.post('/chat', validateBody(chatSchema), assistantController.chat);
assistantRoutes.post('/quick', validateBody(quickSchema), assistantController.quick);
