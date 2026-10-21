import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { attendanceController } from './attendance.controller.js';
import {
  createHolidaySchema,
  // createRegularizationSchema, // self-service regularization disabled (user decision)
  createWfhSchema,
  createZoneSchema,
  decideSchema,
  hrMarkSchema,
  punchSchema,
} from './attendance.schema.js';

/**
 * Attendance — mounted at /api/v1/attendance.
 *
 *   POST   /check-in                     (self; office-IP guard flags, never blocks)
 *   POST   /check-out                    (self)
 *   GET    /me?month=                    (own classified month + today's punch state)
 *   GET    /team?month=                  (caller is the effective RM)
 *   GET    /org?month=&zone=&department= (hrbp.attendance read)
 *   GET    /holidays?year=               (everyone)
 *   POST   /holidays                     (hrbp.attendance update)
 *   DELETE /holidays/:id                 (hrbp.attendance update)
 *   POST   /regularizations…             DISABLED (user decision): employees
 *                                        cannot self-regularize; HRBP/Admin
 *                                        fix missed days via POST /hr-mark,
 *                                        which records the punch as
 *                                        `regularized`. Routes kept commented
 *                                        below for a later re-enable.
 *   POST   /wfh, GET /wfh/mine|team, /wfh/:id/decision, /wfh/:id/cancel (same shape)
 *
 * Decision routes carry no requireAccess: the RM is a relationship, resolved
 * by the service against the request's subject (hrbp.attendance stands in only
 * when the subject has no RM). Literal paths precede /:id/* registrations.
 */
export const attendanceRoutes = Router();

attendanceRoutes.use(authenticate);

attendanceRoutes.post(
  '/check-in',
  validateBody(punchSchema),
  attendanceController.checkIn,
);
attendanceRoutes.post(
  '/check-out',
  validateBody(punchSchema),
  attendanceController.checkOut,
);
attendanceRoutes.get('/me', attendanceController.myMonth);
attendanceRoutes.get('/team', attendanceController.teamMonth);
attendanceRoutes.get(
  '/org',
  requireAccess('hrbp.attendance', 'read'),
  attendanceController.orgMonth,
);
// Export is PR-or-HRBP: the dual-module gate lives in the service.
attendanceRoutes.get('/export', attendanceController.exportCsv);
// HR marks a missed day directly — lands as `regularized`, attached
// single-day leave revoked + refunded.
attendanceRoutes.post(
  '/hr-mark',
  requireAccess('hrbp.attendance', 'update'),
  validateBody(hrMarkSchema),
  attendanceController.hrMark,
);

// Zone management is Admin-only — the service enforces the access BYPASS
// (Owner/SuperAdmin), since "Admin" is not a module grant.
attendanceRoutes.get('/zones', attendanceController.listZones);
attendanceRoutes.post(
  '/zones',
  validateBody(createZoneSchema),
  attendanceController.addZone,
);
attendanceRoutes.delete('/zones/:id', attendanceController.removeZone);

attendanceRoutes.get('/holidays', attendanceController.listHolidays);
attendanceRoutes.post(
  '/holidays',
  requireAccess('hrbp.attendance', 'update', { orgOnly: true }),
  validateBody(createHolidaySchema),
  attendanceController.addHoliday,
);
attendanceRoutes.delete(
  '/holidays/:id',
  requireAccess('hrbp.attendance', 'update', { orgOnly: true }),
  attendanceController.removeHoliday,
);

// Self-service regularization DISABLED (user decision): only HRBP/Admin fix a
// missed day, via POST /hr-mark above (lands as source `regularized`). The
// whole request/approve loop is kept commented for a later re-enable.
// attendanceRoutes.post(
//   '/regularizations',
//   validateBody(createRegularizationSchema),
//   attendanceController.raiseRegularization,
// );
// attendanceRoutes.get('/regularizations/mine', attendanceController.myRegularizations);
// attendanceRoutes.get('/regularizations/team', attendanceController.teamRegularizations);
// attendanceRoutes.post(
//   '/regularizations/:id/decision',
//   validateBody(decideSchema),
//   attendanceController.decideRegularization,
// );
// attendanceRoutes.post('/regularizations/:id/cancel', attendanceController.cancelRegularization);

attendanceRoutes.post(
  '/wfh',
  validateBody(createWfhSchema),
  attendanceController.raiseWfh,
);
attendanceRoutes.get('/wfh/mine', attendanceController.myWfh);
attendanceRoutes.get('/wfh/team', attendanceController.teamWfh);
// The HR inbox: live remote requests org-wide (dual approval's second slot).
attendanceRoutes.get(
  '/wfh/queue',
  requireAccess('hrbp.attendance', 'read'),
  attendanceController.wfhQueue,
);
attendanceRoutes.post(
  '/wfh/:id/decision',
  validateBody(decideSchema),
  attendanceController.decideWfh,
);
attendanceRoutes.post('/wfh/:id/cancel', attendanceController.cancelWfh);
