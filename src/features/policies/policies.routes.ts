import { raw, Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { policiesController } from './policies.controller.js';
import { createPolicySchema, updatePolicySchema } from './policies.schema.js';

/**
 * Policy library — mounted at /api/v1/policies.
 *
 *   GET   /         -> 200 Policy[]      (every signed-in employee reads the LIVE library)
 *   GET   /manage   -> 200 Policy[]      (live + retired — hrbp.policies read)
 *   POST  /:id/retire  -> 200 Policy     (withdraw; rows + signatures kept — hrbp.policies update)
 *   POST  /:id/restore -> 200 Policy     (bring a retired policy back — hrbp.policies update)
 *   GET   /mine     -> 200 MyPolicy[]    (library + the caller's ack state — me scope)
 *   POST  /:id/ack  -> 201 PolicyAck     (sign the CURRENT version — me scope)
 *   GET   /tracker  -> 200 PolicyTracker (people × policies grid — hrbp.policies read)
 *   POST  /         -> 201 Policy        (hrbp.policies create)
 *   PATCH /:id      -> 200 Policy        (hrbp.policies update; version change = bump)
 *   GET   /:id/document -> 200 PDF       (the stored document — any signed-in employee)
 *   PUT   /:id/document -> 200 Policy    (store/replace the PDF; clears doc_url — hrbp.policies update)
 *
 * Reading and acknowledging need no grant: the library applies to everyone,
 * and an ack is the caller signing for THEMSELVES, like a /me write.
 */
export const policiesRoutes = Router();

policiesRoutes.use(authenticate);

policiesRoutes.get('/', policiesController.list);
policiesRoutes.get('/mine', policiesController.mine);
policiesRoutes.get(
  '/manage',
  requireAccess('hrbp.policies', 'read', { orgOnly: true }),
  policiesController.listForManagement,
);
policiesRoutes.post(
  '/:id/retire',
  requireAccess('hrbp.policies', 'update', { orgOnly: true }),
  policiesController.retire,
);
policiesRoutes.post(
  '/:id/restore',
  requireAccess('hrbp.policies', 'update', { orgOnly: true }),
  policiesController.restore,
);
policiesRoutes.get(
  '/tracker',
  requireAccess('hrbp.policies', 'read', { orgOnly: true }),
  policiesController.tracker,
);
policiesRoutes.post(
  '/',
  requireAccess('hrbp.policies', 'create', { orgOnly: true }),
  validateBody(createPolicySchema),
  policiesController.create,
);
policiesRoutes.patch(
  '/:id',
  requireAccess('hrbp.policies', 'update', { orgOnly: true }),
  validateBody(updatePolicySchema),
  policiesController.update,
);
policiesRoutes.post('/:id/ack', policiesController.acknowledge);
// The stored PDF: readable by every signed-in employee, replaced by HR. The
// upload is the RAW request body (no multipart), filename via ?filename=.
policiesRoutes.get('/:id/document', policiesController.document);
policiesRoutes.put(
  '/:id/document',
  requireAccess('hrbp.policies', 'update', { orgOnly: true }),
  raw({ type: () => true, limit: '20mb' }),
  policiesController.uploadDocument,
);
