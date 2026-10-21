import { Router } from 'express';
import { validateBody } from '../../middleware/validateBody.js';
import { authController } from './auth.controller.js';
import { claimOrgSchema, claimRecordSchema, loginSchema } from './auth.schema.js';

/**
 * Auth — mounted at /api/v1/auth. The only unauthenticated group.
 *
 *   POST /login      -> 200 Session   (company email + password, §5.4)
 *   POST /claim      -> 201 Session   (claim the record HRBP created, §5.4)
 *   POST /claim-org  -> 201 Session   (one-time Owner claim, then closed, §5.2)
 *   POST /refresh    -> 200 Session   (rotate the httpOnly refresh cookie)
 *   POST /logout     -> 204           (revoke the cookie's session family)
 *
 * Every Session response also sets the rotating refresh cookie.
 */
export const authRoutes = Router();

authRoutes.post('/login', validateBody(loginSchema), authController.login);
authRoutes.post('/claim', validateBody(claimRecordSchema), authController.claimRecord);
authRoutes.post('/claim-org', validateBody(claimOrgSchema), authController.claimOrg);
authRoutes.post('/refresh', authController.refresh);
authRoutes.post('/logout', authController.logout);
