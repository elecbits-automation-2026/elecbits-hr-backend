import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { openDoorController } from './openDoor.controller.js';
import { bookSchema, createSlotSchema, markSchema } from './openDoor.schema.js';

/**
 * Open door (Batch 4) — mounted at /api/v1/open-door.
 *
 *   GET  /slots                   bookable slots (today → the horizon, not your own)
 *   GET  /me                      my bookings, canPublish, my slots with their bookings
 *   POST /slots                   publish (HR or a department head — service-gated)
 *   POST /slots/:id/cancel        the owner cancels; bookers are told
 *   POST /slots/:id/book          take a seat (capacity locked in the transaction)
 *   POST /bookings/:id/cancel     cancel my booking before the slot starts
 *   POST /bookings/:id/mark       the owner marks done / no_show once it started
 */
export const openDoorRoutes = Router();

openDoorRoutes.use(authenticate);

openDoorRoutes.get('/slots', openDoorController.slots);
openDoorRoutes.get('/me', openDoorController.me);
openDoorRoutes.post(
  '/slots',
  validateBody(createSlotSchema),
  openDoorController.createSlot,
);
openDoorRoutes.post('/slots/:id/cancel', openDoorController.cancelSlot);
openDoorRoutes.post('/slots/:id/book', validateBody(bookSchema), openDoorController.book);
openDoorRoutes.post('/bookings/:id/cancel', openDoorController.cancelBooking);
openDoorRoutes.post(
  '/bookings/:id/mark',
  validateBody(markSchema),
  openDoorController.mark,
);
