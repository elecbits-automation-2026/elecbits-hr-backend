import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { meController } from './me.controller.js';
import { updateMeSchema } from './me.schema.js';

/**
 * The signed-in employee's own view — mounted at /api/v1/me.
 *
 *   GET   /        -> 200 Me             (profile, batches held, flags)
 *   PATCH /        -> 200 Me             (self-serve identity fields only, D3)
 *   GET   /salary  -> 200 EmployeeSalary (OWN salary+bank — me scope §3.1)
 *   GET   /assets  -> 200 MyAsset[]      (assets in own custody)
 *   GET   /exit    -> 200 MyExit|null    (own exit record, if any)
 *
 * No requireAccess: seeing and editing your own record is the `me` scope
 * every employee has by definition (§3.1). The Zod schema limits WHAT can be
 * self-edited — org placement stays with HRBP, salary with Payroll. Other
 * people's salary goes through /employees/:id/salary, which is gated on
 * `pr.payroll.compensation` — this route only ever serves the caller's own.
 */
export const meRoutes = Router();

meRoutes.get('/', authenticate, meController.getMe);
meRoutes.patch('/', authenticate, validateBody(updateMeSchema), meController.updateMe);
meRoutes.get('/salary', authenticate, meController.getMySalary);
// The caller's chain (reports + approver-only assignees), sanitized.
meRoutes.get('/team', authenticate, meController.getTeam);
meRoutes.get('/assets', authenticate, meController.getMyAssets);
meRoutes.get('/exit', authenticate, meController.getMyExit);
