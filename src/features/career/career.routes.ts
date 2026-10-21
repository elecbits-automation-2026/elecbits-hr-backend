import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { careerController } from './career.controller.js';
import { addTrackNoteSchema, closeTrackSchema, openTrackSchema } from './career.schema.js';

/**
 * Career ladder & roadmap — mounted at /api/v1/career.
 *
 *   GET  /mine             -> 200 MyCareer       (ladder, evidence, open track + notes, history, self-request check — me scope)
 *   POST /request          -> 201 CareerTrack    (the employee asks — career.selfRequest minimums apply)
 *   GET  /people/:employeeId -> 200 PersonCareer (RM-or-HR: history, open track, notes)
 *   GET  /team             -> 200 TeamCareerRow[] (the caller's chain — relationship IS the authz)
 *   POST /tracks           -> 201 CareerTrack    (RM-or-HR opens one for a report — service-gated)
 *   POST /tracks/:id/close -> 200 CareerTrack    (RM-or-HR; never the person themselves)
 *   POST /tracks/:id/notes -> 201 CareerTrackNote (RM-or-HR write; the employee reads via /mine)
 *
 * No requireAccess: like /me/team and the approval slots, every gate here is
 * a RELATIONSHIP question the service answers against the target row.
 */
export const careerRoutes = Router();

careerRoutes.use(authenticate);

careerRoutes.get('/mine', careerController.mine);
careerRoutes.post('/request', careerController.request);
careerRoutes.get('/team', careerController.team);
careerRoutes.post('/tracks', validateBody(openTrackSchema), careerController.open);
careerRoutes.post('/tracks/:id/close', validateBody(closeTrackSchema), careerController.close);
careerRoutes.post('/tracks/:id/notes', validateBody(addTrackNoteSchema), careerController.addNote);
careerRoutes.get('/people/:employeeId', careerController.person);
