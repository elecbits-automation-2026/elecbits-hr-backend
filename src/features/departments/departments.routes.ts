import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { departmentsController } from './departments.controller.js';
import { createDepartmentSchema } from './departments.schema.js';

/**
 * Department tree — mounted at /api/v1/departments.
 *
 *   GET  / -> 200 Department[]
 *   POST / -> 201 Department   (HRBP org-structure right)
 */
export const departmentsRoutes = Router();

departmentsRoutes.use(authenticate);

departmentsRoutes.get('/', requireAccess('hrbp.org', 'read', { orgOnly: true }), departmentsController.list);
departmentsRoutes.post(
  '/',
  requireAccess('hrbp.org', 'create', { orgOnly: true }),
  validateBody(createDepartmentSchema),
  departmentsController.create,
);
