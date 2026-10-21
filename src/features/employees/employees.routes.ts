import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { employeesController } from './employees.controller.js';
import {
  createEmployeeSchema,
  inviteEmployeeSchema,
  updateEmployeeSchema,
  updateBankDetailsSchema,
  updateSalarySchema,
  importEmployeesSchema,
} from './employees.schema.js';

/**
 * People records — mounted at /api/v1/employees.
 *
 *   GET    /        -> 200 Employee[]   (scope-filtered by the caller's grants)
 *   POST   /        -> 201 Employee     (HRBP creates top-down, §5.3 — record-first)
 *   POST   /invite  -> 201 Employee     (Admin invites with batches — access-first)
 *   GET    /:id     -> 200 Employee
 *   PATCH  /:id     -> 200 Employee     (incl. RM changes; no-cycle enforced)
 *
 * There is no DELETE — deactivation happens through the exits flow only (§10).
 */
export const employeesRoutes = Router();

employeesRoutes.use(authenticate);

employeesRoutes.get('/', requireAccess('hrbp.people', 'read'), employeesController.list);
employeesRoutes.post(
  '/',
  requireAccess('hrbp.people', 'create'),
  validateBody(createEmployeeSchema),
  employeesController.create,
);
// Inviting includes granting batches, so the gate is the access-granting
// right (Owner/SuperAdmin for now), not hrbp.people.
employeesRoutes.post(
  '/invite',
  requireAccess('access.batches', 'update', { orgOnly: true }),
  validateBody(inviteEmployeeSchema),
  employeesController.invite,
);
// Bulk CSV import (rows parsed client-side): dry run, then all-or-nothing.
employeesRoutes.post(
  '/import',
  requireAccess('hrbp.people', 'create'),
  validateBody(importEmployeesSchema),
  employeesController.importEmployees,
);
// Live records missing joining date / department / designation (before /:id).
employeesRoutes.get(
  '/incomplete',
  requireAccess('hrbp.people', 'read'),
  employeesController.incomplete,
);
employeesRoutes.get(
  '/:id',
  requireAccess('hrbp.people', 'read'),
  employeesController.getById,
);
// Reissue the single-use claim link for a not-yet-claimed record (expired
// token, or records predating claim security). 409 once claimed.
employeesRoutes.post(
  '/:id/claim-link',
  requireAccess('hrbp.people', 'update'),
  employeesController.claimLink,
);
employeesRoutes.patch(
  '/:id',
  requireAccess('hrbp.people', 'update'),
  validateBody(updateEmployeeSchema),
  employeesController.update,
);

// Salary + bank details are ME-SCOPED data (§3.1): an employee reads their own
// via GET /me/salary. THIS pair is the only other door, and it is gated on the
// PR compensation module — holding hrbp.people (or being someone's RM) grants
// nothing here. Owner/SuperAdmin pass via the middleware bypass.
employeesRoutes.get(
  '/:id/salary',
  requireAccess('pr.payroll.compensation', 'read', { orgOnly: true }),
  employeesController.getSalary,
);
employeesRoutes.put(
  '/:id/salary',
  requireAccess('pr.payroll.compensation', 'update', { orgOnly: true }),
  validateBody(updateSalarySchema),
  employeesController.updateSalary,
);
// Bank details on their own door (Phase 3): pr.payroll.bank_details, org only.
// The salary pair above hides/refuses the bank fields without it.
employeesRoutes.get(
  '/:id/bank-details',
  requireAccess('pr.payroll.bank_details', 'read', { orgOnly: true }),
  employeesController.getBankDetails,
);
employeesRoutes.put(
  '/:id/bank-details',
  requireAccess('pr.payroll.bank_details', 'update', { orgOnly: true }),
  validateBody(updateBankDetailsSchema),
  employeesController.updateBankDetails,
);
