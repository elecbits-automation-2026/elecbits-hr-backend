import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  bookSchema,
  createSlotSchema,
  markSchema,
  meSchema,
  slotSchema,
} from './openDoor.schema.js';

const bearer = [{ bearerAuth: [] }];
const tags = ['Open door'];

/** OpenAPI registration for the /open-door endpoints. */
export const registerOpenDoorDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/open-door/slots',
    tags,
    summary: 'Bookable open-door slots from today to the booking horizon (not your own)',
    security: bearer,
    responses: { 200: jsonResponse('Slots', z.array(slotSchema)) },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/open-door/me',
    tags,
    summary:
      'My bookings, whether I can publish, and my own slots with their bookings (topics visible to the owner only)',
    security: bearer,
    responses: { 200: jsonResponse('Me', meSchema) },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/open-door/slots',
    tags,
    summary:
      'Publish a slot (HR: hrbp.grievances update, or a department head: level L5–L6)',
    security: bearer,
    request: { body: jsonBody(createSlotSchema) },
    responses: {
      201: jsonResponse('Me', meSchema),
      403: errorResponse('NOT_A_PUBLISHER'),
      422: errorResponse('PAST_SLOT'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/open-door/slots/{id}/cancel',
    tags,
    summary: 'The owner cancels a slot; everyone booked gets a bell',
    security: bearer,
    responses: { 200: jsonResponse('Me', meSchema), 404: errorResponse('Not your slot') },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/open-door/slots/{id}/book',
    tags,
    summary: 'Book a seat (never your own slot, within the horizon)',
    security: bearer,
    request: { body: jsonBody(bookSchema) },
    responses: {
      201: jsonResponse('Me', meSchema),
      409: errorResponse('SLOT_FULL'),
      422: errorResponse('OWN_SLOT, NOT_BOOKABLE'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/open-door/bookings/{id}/cancel',
    tags,
    summary: 'Cancel my booking before the slot starts',
    security: bearer,
    responses: {
      200: jsonResponse('Me', meSchema),
      409: errorResponse('Started or closed'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/open-door/bookings/{id}/mark',
    tags,
    summary: 'The slot owner marks a booking done or no-show once the slot started',
    security: bearer,
    request: { body: jsonBody(markSchema) },
    responses: {
      200: jsonResponse('Me', meSchema),
      409: errorResponse('Not started or already marked'),
    },
  });
};
