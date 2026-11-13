import { raw, Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { onboardingController } from './onboarding.controller.js';
import { startJourneySchema, toggleTaskSchema } from './onboarding.schema.js';

/**
 * Onboarding journeys — mounted at /api/v1/onboarding.
 *
 *   GET  /mine                  -> 200 MyOnboarding (own journey; auto-creates for recent joiners; null otherwise)
 *   GET  /team-tasks/:owner     -> 200 OnboardingTeamTask[] (owner ops | payroll)
 *   GET  /team                  -> 200 OnboardingJourney[] (the RM's joiners — Onboarding → My team)
 *   POST /tasks/:id/toggle      -> 200 OnboardingJourney (tick with { note } / untick — the task's owner only)
 *   PUT  /tasks/:id/file        -> 200 OnboardingJourney (document step: raw PDF/JPG/PNG body, ?filename=; completes it)
 *   GET  /tasks/:id/file        -> 200 the file (the joiner, or HR reaching them)
 *   GET  /                      -> 200 OnboardingQueueRow[] (who is onboarding — hrbp.people read)
 *   GET  /employee/:employeeId  -> 200 OnboardingJourney (drill-in — hrbp.people read)
 *   POST /                      -> 201 OnboardingJourney (start by hand — hrbp.people update)
 *
 * No requireAccess on toggle: "may I tick this" depends on the TASK's owner
 * and the actor's relationship to the hire, so the service answers it.
 */
export const onboardingRoutes = Router();

onboardingRoutes.use(authenticate);

onboardingRoutes.get('/mine', onboardingController.mine);
// OPS / payroll joiner tasks (service-gated on ops.assets / pr.payroll, org).
onboardingRoutes.get('/team-tasks/:owner', onboardingController.teamTasks);
onboardingRoutes.get('/team', onboardingController.team);
onboardingRoutes.post(
  '/tasks/:id/toggle',
  validateBody(toggleTaskSchema),
  onboardingController.toggleTask,
);
// Document steps: raw file body (like leave certificates); the upload completes the step.
onboardingRoutes.put(
  '/tasks/:id/file',
  raw({ type: () => true, limit: '10mb' }),
  onboardingController.uploadTaskFile,
);
onboardingRoutes.get('/tasks/:id/file', onboardingController.taskFile);
onboardingRoutes.get('/', requireAccess('hrbp.people', 'read'), onboardingController.queue);
onboardingRoutes.get(
  '/employee/:employeeId',
  requireAccess('hrbp.people', 'read'),
  onboardingController.forEmployee,
);
onboardingRoutes.post(
  '/',
  requireAccess('hrbp.people', 'update'),
  validateBody(startJourneySchema),
  onboardingController.start,
);
