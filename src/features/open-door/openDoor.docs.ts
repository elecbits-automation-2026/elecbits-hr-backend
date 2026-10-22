import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  bookSchema,
  createRequestSchema,
  createSlotSchema,
  declineRequestSchema,
  hostSchema,
  markSchema,
  meSchema,
  offerRequestSchema,
  requestsSchema,
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

  // ── Session requests ────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get',
    path: '/api/v1/open-door/hosts',
    tags,
    summary:
      'Who a session request may go to: department heads (L5–L6) and HR (hrbp.grievances)',
    security: bearer,
    responses: { 200: jsonResponse('Hosts', z.array(hostSchema)) },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/open-door/requests',
    tags,
    summary:
      'My session requests, and the ones I am asked to answer (as host, or as the current handler of a concern)',
    security: bearer,
    responses: { 200: jsonResponse('Requests', requestsSchema) },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/open-door/requests',
    tags,
    summary:
      'Ask for a session when no slot suits: a host (hostId), or the handlers of my own named concern (concernId)',
    security: bearer,
    request: { body: jsonBody(createRequestSchema) },
    responses: {
      201: jsonResponse('Requests', requestsSchema),
      404: errorResponse('Concern not found (anonymous or not yours)'),
      409: errorResponse('REQUEST_PENDING, CONCERN_CLOSED'),
      422: errorResponse(
        'PAST_RANGE, BEYOND_HORIZON, OWN_REQUEST, NOT_A_HOST, NO_HANDLER',
      ),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/open-door/requests/{id}/offer',
    tags,
    summary: 'The host offers a time: a 1-seat slot booked for the requester',
    security: bearer,
    request: { body: jsonBody(offerRequestSchema) },
    responses: {
      200: jsonResponse('Requests', requestsSchema),
      404: errorResponse('Not yours to answer'),
      409: errorResponse('REQUEST_CLOSED'),
      422: errorResponse('PAST_SLOT'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/open-door/requests/{id}/decline',
    tags,
    summary: 'The host declines, with a reason the requester sees',
    security: bearer,
    request: { body: jsonBody(declineRequestSchema) },
    responses: {
      200: jsonResponse('Requests', requestsSchema),
      404: errorResponse('Not yours to answer'),
      409: errorResponse('REQUEST_CLOSED'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/open-door/requests/{id}/cancel',
    tags,
    summary: 'The requester withdraws a request that is still waiting',
    security: bearer,
    responses: {
      200: jsonResponse('Requests', requestsSchema),
      404: errorResponse('Not your request'),
      409: errorResponse('REQUEST_CLOSED'),
    },
  });
};
