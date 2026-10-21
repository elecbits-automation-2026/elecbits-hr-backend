import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { recognitionsController } from './recognitions.controller.js';
import {
  createRecognitionSchema,
  decideRecognitionSchema,
} from './recognitions.schema.js';

/**
 * R&R — mounted at /api/v1/recognitions.
 *
 *   GET  /board      -> 200 RecognitionBoard   (approved only — public inside the org)
 *   GET  /mine       -> 200 Recognition[]      (awards the caller has received)
 *   GET  /sent       -> 200 Recognition[]      (the caller's nominations, every status)
 *   GET  /pending    -> 200 Recognition[]      (HR's queue — broad hrbp.people; [] for others)
 *   GET  /directory  -> 200 DirectoryEntry[]   (the caller's own reports; HR: + the top people)
 *   GET  /catalog    -> 200 AwardCatalogEntry[] (award types to pick from)
 *   POST /           -> 201 Recognition        (nominate own report(s); team types: several)
 *   POST /:id/decide -> 200 Recognition        (HR's final approval/decline — whole nomination)
 *
 * No requireAccess: "may I nominate / decide this" is a RELATIONSHIP
 * question (recipient's manager, or broad HR) the service answers per row.
 */
export const recognitionsRoutes = Router();

recognitionsRoutes.use(authenticate);

recognitionsRoutes.get('/board', recognitionsController.board);
recognitionsRoutes.get('/mine', recognitionsController.mine);
recognitionsRoutes.get('/sent', recognitionsController.sent);
recognitionsRoutes.get('/pending', recognitionsController.pending);
recognitionsRoutes.get('/directory', recognitionsController.directory);
recognitionsRoutes.get('/catalog', recognitionsController.catalog);
recognitionsRoutes.post(
  '/',
  validateBody(createRecognitionSchema),
  recognitionsController.nominate,
);
recognitionsRoutes.post(
  '/:id/decide',
  validateBody(decideRecognitionSchema),
  recognitionsController.decide,
);
