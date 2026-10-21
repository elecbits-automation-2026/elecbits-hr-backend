import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { onboardingController } from './onboarding.controller.js';
import { startJourneySchema } from './onboarding.schema.js';

/**
 * Onboarding journeys — mounted at /api/v1/onboarding.
 *
 *   GET  /mine                  -> 200 MyOnboarding (own journey; auto-creates for recent joiners; null otherwise)
 *   GET  /team-tasks/:owner     -> 200 OnboardingTeamTask[] (owner ops | payroll)
 *   POST /tasks/:id/toggle      -> 200 OnboardingJourney (tick/untick — owner-gated in the service)
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
onboardingRoutes.post('/tasks/:id/toggle', onboardingController.toggleTask);
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
