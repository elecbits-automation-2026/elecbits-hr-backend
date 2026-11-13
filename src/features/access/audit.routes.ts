import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { auditController } from './audit.controller.js';

/**
 * Audit log — mounted at /api/v1/audit-log. Read-only: entries are appended by
 * mutations inside their own transactions and are immutable (§10).
 *
 *   GET /?q=&page=&pageSize= -> 200 AuditPage (newest first; 50 a page by default, max 200)
 */
export const auditRoutes = Router();

auditRoutes.get(
  '/',
  authenticate,
  requireAccess('access.audit', 'read', { orgOnly: true }),
  auditController.list,
);
