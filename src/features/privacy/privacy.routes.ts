import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { privacyController } from './privacy.controller.js';
import { acceptPrivacySchema } from './privacy.schema.js';

/**
 * The caller's own privacy routes — mounted at /api/v1/me next to meRoutes
 * (me scope: no requireAccess, everything is keyed to the caller).
 *
 *   GET  /me/privacy         -> 200 PrivacyStatus  (current notice, accepted?)
 *   POST /me/privacy/accept  -> 200 PrivacyStatus  (409 if the version changed)
 *   GET  /me/export          -> 200 MyDataExport   (own records as JSON)
 */
export const privacyMeRoutes = Router();

privacyMeRoutes.get('/privacy', authenticate, privacyController.status);
privacyMeRoutes.post(
  '/privacy/accept',
  authenticate,
  validateBody(acceptPrivacySchema),
  privacyController.accept,
);
privacyMeRoutes.get('/export', authenticate, privacyController.exportMine);

/**
 * Admin — mounted at /api/v1/admin/privacy (access.settings, org).
 *
 *   GET /retention -> 200 RetentionPreview (what the purge job would remove)
 */
export const privacyAdminRoutes = Router();

privacyAdminRoutes.get(
  '/retention',
  authenticate,
  requireAccess('access.settings', 'read', { orgOnly: true }),
  privacyController.retentionPreview,
);
