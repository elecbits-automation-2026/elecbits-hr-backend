import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { seatsController } from './seats.controller.js';
import { assignSeatSchema, vacateSeatSchema } from './seats.schema.js';

/**
 * Seats (dept head, VP) — mounted at /api/v1/seats. Admin (Owner) account
 * only — checked in the service (learner, 2026-10-26).
 *
 *   GET  /        -> 200 SeatsOverview   holders + empty seats
 *   PUT  /        -> 200 Seat            assign / replace the holder
 *   POST /vacate  -> 204                 end the holder, seat left empty
 */
export const seatsRoutes = Router();

seatsRoutes.use(authenticate);

seatsRoutes.get('/', seatsController.overview);
seatsRoutes.put('/', validateBody(assignSeatSchema), seatsController.assign);
seatsRoutes.post('/vacate', validateBody(vacateSeatSchema), seatsController.vacate);
