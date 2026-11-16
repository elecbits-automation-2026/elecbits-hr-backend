import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { departmentsController } from './departments.controller.js';
import {
  addMemberSchema,
  createDepartmentSchema,
  setHeadSchema,
  setLeadSchema,
  updateDepartmentSchema,
} from './departments.schema.js';

/**
 * Org units — mounted at /api/v1/departments.
 *
 *   GET    /                            -> 200 Department[]
 *   GET    /memberships                 -> 200 DepartmentMembership[]
 *   POST   /                            -> 201 Department   (HRBP org-structure create)
 *   PATCH  /:id                         -> 200 Department   rename / move / kind (update)
 *   PUT    /:id/head                    -> 200 Department   seat the head (update)
 *   DELETE /:id/head                    -> 200 Department   clear the head (update)
 *   POST   /:id/members                 -> 201 Department   extra membership (update)
 *   DELETE /memberships/:membershipId   -> 200 Department   remove it (update)
 *   PUT    /:id/lead                    -> 200 Department   chapter lead (update)
 */
export const departmentsRoutes = Router();

departmentsRoutes.use(authenticate);

const canRead = requireAccess('hrbp.org', 'read', { orgOnly: true });
const canUpdate = requireAccess('hrbp.org', 'update', { orgOnly: true });

departmentsRoutes.get('/', canRead, departmentsController.list);
departmentsRoutes.get('/memberships', canRead, departmentsController.memberships);
departmentsRoutes.post(
  '/',
  requireAccess('hrbp.org', 'create', { orgOnly: true }),
  validateBody(createDepartmentSchema),
  departmentsController.create,
);
departmentsRoutes.patch(
  '/:id',
  canUpdate,
  validateBody(updateDepartmentSchema),
  departmentsController.update,
);
departmentsRoutes.put(
  '/:id/head',
  canUpdate,
  validateBody(setHeadSchema),
  departmentsController.setHead,
);
departmentsRoutes.delete('/:id/head', canUpdate, departmentsController.clearHead);
departmentsRoutes.post(
  '/:id/members',
  canUpdate,
  validateBody(addMemberSchema),
  departmentsController.addMember,
);
departmentsRoutes.delete(
  '/memberships/:membershipId',
  canUpdate,
  departmentsController.removeMember,
);
departmentsRoutes.put(
  '/:id/lead',
  canUpdate,
  validateBody(setLeadSchema),
  departmentsController.setLead,
);
