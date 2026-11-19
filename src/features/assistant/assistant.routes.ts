import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { assistantController } from './assistant.controller.js';
import { chatSchema } from './assistant.schema.js';

/**
 * HR Assistant (phase 1, read-only) — mounted at /api/v1/assistant.
 *
 *   POST /chat   the conversation so far → the answer as server-sent events
 *
 * No requireAccess: who may chat (HR or a manager) and which tools each
 * caller gets are resolved per request in the service, from grants and the
 * reporting line.
 */
export const assistantRoutes = Router();

assistantRoutes.use(authenticate);

assistantRoutes.post('/chat', validateBody(chatSchema), assistantController.chat);
