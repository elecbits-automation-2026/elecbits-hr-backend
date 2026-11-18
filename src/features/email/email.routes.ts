import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { emailController } from './email.controller.js';

/**
 * Email delivery — mounted at /api/v1/admin/email (Admin: access.settings, org),
 * shown as a card on the Jobs page.
 *
 *   GET  /               -> 200 EmailStatus
 *   POST /retry-failed   -> 200 { requeued }
 *   POST /test           -> 200 { sentTo, driver }   to the caller's own address
 */
export const emailRoutes = Router();

emailRoutes.use(authenticate);

emailRoutes.get(
  '/',
  requireAccess('access.settings', 'read', { orgOnly: true }),
  emailController.status,
);
emailRoutes.post(
  '/retry-failed',
  requireAccess('access.settings', 'update', { orgOnly: true }),
  emailController.retryFailed,
);
emailRoutes.post(
  '/test',
  requireAccess('access.settings', 'update', { orgOnly: true }),
  emailController.test,
);
