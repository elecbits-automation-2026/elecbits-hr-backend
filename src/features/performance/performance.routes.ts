import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { performanceController } from './performance.controller.js';
import {
  createGoalSchema,
  decideLateSchema,
  updateGoalSchema,
  submitUpdateSchema,
  updateProgressSchema,
} from './performance.schema.js';

/**
 * Goals — mounted at /api/v1/goals.
 *
 *   GET   /mine         -> 200 MyGoals          (own goals + attainment — me scope)
 *   GET   /team         -> 200 TeamGoalsRow[]   (the caller's chain — relationship IS the authz)
 *   POST  /             -> 201 Goal             (RM-or-HR for a report; never yourself — service-gated)
 *   PATCH /:id          -> 200 Goal             (edit: RM-or-HR, open cycle only — service-gated)
 *   DELETE /:id         -> 204                  (delete: same gate, audited)
 *   PATCH /:id/progress -> 200 Goal             (the OWNER only — "only the person who owns it moves this")
 *
 * No requireAccess: every gate is a relationship question the service answers.
 */
export const goalsRoutes = Router();

goalsRoutes.use(authenticate);

goalsRoutes.get('/mine', performanceController.myGoals);
goalsRoutes.get('/team', performanceController.teamGoals);
// One report's FULL sheet for the RM person sheet (service-gated: RM-or-HR).
goalsRoutes.get('/team/:employeeId', performanceController.teamMemberGoals);
goalsRoutes.post('/', validateBody(createGoalSchema), performanceController.createGoal);
goalsRoutes.patch(
  '/:id',
  validateBody(updateGoalSchema),
  performanceController.updateGoal,
);
goalsRoutes.delete('/:id', performanceController.deleteGoal);
goalsRoutes.patch(
  '/:id/progress',
  validateBody(updateProgressSchema),
  performanceController.updateProgress,
);

/**
 * Daily work updates — mounted at /api/v1/work-updates.
 *
 *   GET  /mine?days=14 -> 200 MyWorkUpdates    (own entries + whether scoring runs)
 *   GET  /team?days=7  -> 200 TeamUpdatesRow[] (chain's sheet, READ-ONLY for the RM)
 *   POST /             -> 201 WorkUpdate       (today, or a LATE entry for a missed day in the window)
 *   GET  /late         -> 200 LateWorkUpdate[] (pending late entries the caller decides — RM)
 *   POST /:id/late-decision -> 200 WorkUpdate  (RM-or-HR approves/declines a late entry)
 */
export const workUpdatesRoutes = Router();

workUpdatesRoutes.use(authenticate);

workUpdatesRoutes.get('/mine', performanceController.myUpdates);
workUpdatesRoutes.get('/team', performanceController.teamUpdates);
// One report's recent updates for the person sheet (service-gated: RM-or-HR).
workUpdatesRoutes.get('/team/:employeeId', performanceController.teamMemberUpdates);
workUpdatesRoutes.post(
  '/',
  validateBody(submitUpdateSchema),
  performanceController.submitUpdate,
);
workUpdatesRoutes.get('/late', performanceController.latePending);
workUpdatesRoutes.post(
  '/:id/late-decision',
  validateBody(decideLateSchema),
  performanceController.decideLate,
);
