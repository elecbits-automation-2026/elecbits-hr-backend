import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  createHolidaySchema,
  // createRegularizationSchema, // self-service regularization disabled (user decision)
  createWfhSchema,
  decideSchema,
  employeeAttendanceSchema,
  holidaySchema,
  createZoneSchema,
  hrMarkSchema,
  myAttendanceSchema,
  punchSchema,
  punchZoneSchema,
  // regularizationSchema, // self-service regularization disabled (user decision)
  wfhRequestSchema,
} from './attendance.schema.js';

const bearer = [{ bearerAuth: [] }];

/** OpenAPI registration for the attendance endpoints. */
export const registerAttendanceDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/attendance/check-in',
    tags: ['Attendance'],
    summary:
      'Check in (geo zones: office radius clean, flag radius flagged, beyond blocked without an approved remote-work request)',
    security: bearer,
    request: { body: jsonBody(punchSchema) },
    responses: {
      201: jsonResponse(
        'Checked in',
        z.object({ date: z.string(), checkInAt: z.string(), source: z.string() }),
      ),
      401: errorResponse('Not authenticated'),
      403: errorResponse('Outside office range without an approved remote-work request'),
      409: errorResponse('Already checked in'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/attendance/check-out',
    tags: ['Attendance'],
    summary: 'Check out for today (same geo zones as check-in)',
    security: bearer,
    request: { body: jsonBody(punchSchema) },
    responses: {
      200: jsonResponse(
        'Checked out',
        z.object({
          date: z.string(),
          checkInAt: z.string(),
          checkOutAt: z.string(),
          workedHours: z.number().nullable(),
        }),
      ),
      403: errorResponse('Outside office range without an approved remote-work request'),
      409: errorResponse('Not checked in / already out'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attendance/me',
    tags: ['Attendance'],
    summary: 'Own classified month (?month=YYYY-MM) + today punch state',
    security: bearer,
    responses: {
      200: jsonResponse('MyAttendance', myAttendanceSchema),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attendance/team',
    tags: ['Attendance'],
    summary: "Reports' classified months (caller is the effective RM)",
    security: bearer,
    responses: {
      200: jsonResponse('Team', z.array(employeeAttendanceSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attendance/org',
    tags: ['Attendance'],
    summary:
      'Org-wide classified months, optionally ?zone= and ?department= (hrbp.attendance read)',
    security: bearer,
    responses: {
      200: jsonResponse('Org', z.array(employeeAttendanceSchema)),
      403: errorResponse('Not allowed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/attendance/hr-mark',
    tags: ['Attendance'],
    summary:
      "HR marks someone's missed day as regularized (hrbp.attendance update); single-day leave on the date is revoked + refunded",
    security: bearer,
    request: { body: jsonBody(hrMarkSchema) },
    responses: {
      201: jsonResponse(
        'Marked',
        z.object({
          date: z.string(),
          checkInAt: z.string(),
          checkOutAt: z.string(),
          source: z.string(),
        }),
      ),
      403: errorResponse('Not allowed'),
      409: errorResponse('Multi-day leave on this date'),
      422: errorResponse('Future date'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attendance/export',
    tags: ['Attendance'],
    summary: 'CSV month export (?month=&department=) — HRBP or PR only',
    security: bearer,
    responses: {
      200: { description: 'text/csv attachment' },
      403: errorResponse('Needs HR or Payroll access'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attendance/zones',
    tags: ['Attendance'],
    summary: 'List punch zones (any signed-in user; mutations are Admin-only)',
    security: bearer,
    responses: {
      200: jsonResponse('Zones', z.array(punchZoneSchema)),
      403: errorResponse('Admin only'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/attendance/zones',
    tags: ['Attendance'],
    summary: 'Add a punch zone (Admin only)',
    security: bearer,
    request: { body: jsonBody(createZoneSchema) },
    responses: {
      201: jsonResponse('Zone', punchZoneSchema),
      403: errorResponse('Admin only'),
      409: errorResponse('Duplicate name'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/attendance/zones/{id}',
    tags: ['Attendance'],
    summary: 'Remove a punch zone (Admin only)',
    security: bearer,
    responses: {
      204: { description: 'Removed' },
      403: errorResponse('Admin only'),
      404: errorResponse('Not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attendance/holidays',
    tags: ['Attendance'],
    summary: 'Holiday list (?year=)',
    security: bearer,
    responses: { 200: jsonResponse('Holidays', z.array(holidaySchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/attendance/holidays',
    tags: ['Attendance'],
    summary: 'Add a holiday (hrbp.attendance update)',
    security: bearer,
    request: { body: jsonBody(createHolidaySchema) },
    responses: {
      201: jsonResponse('Holiday', holidaySchema),
      403: errorResponse('Not allowed'),
      409: errorResponse('Duplicate date'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/attendance/holidays/{id}',
    tags: ['Attendance'],
    summary: 'Remove a holiday (hrbp.attendance update)',
    security: bearer,
    responses: { 204: { description: 'Removed' }, 404: errorResponse('Not found') },
  });

  // Self-service regularization routes are DISABLED (user decision) — only
  // HRBP/Admin regularize, via POST /attendance/hr-mark. The five
  // /regularizations registrations are removed from the docs with the routes;
  // restore them together with attendance.routes.ts if the flow comes back.

  registry.registerPath({
    method: 'post',
    path: '/api/v1/attendance/wfh',
    tags: ['Attendance'],
    summary: 'Request remote work for a date range (reason required; RM + HR approve)',
    security: bearer,
    request: { body: jsonBody(createWfhSchema) },
    responses: { 201: jsonResponse('WfhRequest', wfhRequestSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attendance/wfh/queue',
    tags: ['Attendance'],
    summary: 'Live remote requests org-wide (hrbp.attendance read)',
    security: bearer,
    responses: {
      200: jsonResponse('RemoteRequests', z.array(wfhRequestSchema)),
      403: errorResponse('Not allowed'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attendance/wfh/mine',
    tags: ['Attendance'],
    summary: 'Own WFH requests',
    security: bearer,
    responses: { 200: jsonResponse('WfhRequests', z.array(wfhRequestSchema)) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/attendance/wfh/team',
    tags: ['Attendance'],
    summary: "Reports' WFH requests (effective RM)",
    security: bearer,
    responses: { 200: jsonResponse('WfhRequests', z.array(wfhRequestSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/attendance/wfh/{id}/decision',
    tags: ['Attendance'],
    summary: 'Approve or decline a remote request (dual slots: RM + hrbp.attendance)',
    security: bearer,
    request: { body: jsonBody(decideSchema) },
    responses: {
      200: jsonResponse('WfhRequest', wfhRequestSchema),
      403: errorResponse('Not the approver / self-approval'),
      404: errorResponse('Not found'),
      409: errorResponse('Already decided'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/attendance/wfh/{id}/cancel',
    tags: ['Attendance'],
    summary: 'Cancel an own pending WFH request',
    security: bearer,
    responses: {
      200: jsonResponse('WfhRequest', wfhRequestSchema),
      403: errorResponse('Not your request'),
      409: errorResponse('Already decided'),
    },
  });
};
