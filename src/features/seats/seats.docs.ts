import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import {
  assignSeatSchema,
  seatSchema,
  seatsOverviewSchema,
  vacateSeatSchema,
} from './seats.schema.js';

/** OpenAPI registration for the seats endpoints. */
export const registerSeatsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/seats',
    tags: ['Seats'],
    summary: 'Current seat holders and empty seats (Admin account only)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Seats', seatsOverviewSchema),
      401: errorResponse('Not authenticated'),
      403: errorResponse('Not the Admin account'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/seats',
    tags: ['Seats'],
    summary: 'Assign a seat, replacing the current holder (Admin account only)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(assignSeatSchema) },
    responses: {
      200: jsonResponse('Assigned', seatSchema),
      403: errorResponse('Not the Admin account'),
      404: errorResponse('Employee not found'),
      409: errorResponse('Already holds the seat, or the seat changed meanwhile'),
      422: errorResponse('Department missing, employee not active, or the Admin account'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/seats/vacate',
    tags: ['Seats'],
    summary: 'Vacate a seat (Admin account only)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(vacateSeatSchema) },
    responses: {
      204: { description: 'Vacated' },
      403: errorResponse('Not the Admin account'),
      404: errorResponse('Nobody holds this seat'),
    },
  });
};
