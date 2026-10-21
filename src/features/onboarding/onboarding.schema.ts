import { z } from '../../shared/zod.js';

export const ONBOARDING_PHASES = ['before_start', 'week_one', 'first_30'] as const;
export const TASK_OWNERS = ['employee', 'hr', 'manager', 'admin', 'ops', 'payroll'] as const;

/** OPS / payroll: the joiner tasks waiting on their team. */
export const teamTaskSchema = z
  .object({
    taskId: z.string().uuid(),
    title: z.string(),
    done: z.boolean(),
    // Done by the system: the kit is all held / salary + bank are on record.
    autoDone: z.boolean(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
      designation: z.string().nullable(),
      dateOfJoining: z.string().nullable(),
    }),
  })
  .openapi('OnboardingTeamTask');

export type TeamTaskDto = z.infer<typeof teamTaskSchema>;

/** HR starts a journey by hand (rehires, or joiners older than the window). */
export const startJourneySchema = z
  .object({
    employeeId: z.string().uuid(),
    /** Defaults to the employee's joining date, else today. */
    startedOn: z.string().date().optional(),
  })
  .strict()
  .openapi('StartOnboarding');

export const onboardingTaskSchema = z
  .object({
    id: z.string().uuid(),
    seq: z.number().int(),
    phase: z.enum(ONBOARDING_PHASES),
    taskKey: z.string(),
    title: z.string(),
    owner: z.enum(TASK_OWNERS),
    /** Set on policy tasks — completed via the policy ack, never ticked. */
    policyCode: z.string().nullable(),
    policyId: z.string().uuid().nullable(),
    done: z.boolean(),
    doneAt: z.string().datetime().nullable(),
    doneByName: z.string().nullable(),
  })
  .openapi('OnboardingTask');

export const journeySchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    startedOn: z.string(),
    dueOn: z.string(),
    status: z.enum(['open', 'done']),
    progress: z.object({ done: z.number().int(), total: z.number().int() }),
    tasks: z.array(onboardingTaskSchema),
  })
  .openapi('OnboardingJourney');

/** The caller's own journey — null when onboarding does not apply to them. */
export const myJourneySchema = journeySchema.nullable().openapi('MyOnboarding');

export const queueRowSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    startedOn: z.string(),
    dueOn: z.string(),
    status: z.enum(['open', 'done']),
    progress: z.object({ done: z.number().int(), total: z.number().int() }),
    /** Days until dueOn; negative = overdue. */
    daysLeft: z.number().int(),
  })
  .openapi('OnboardingQueueRow');

export type StartJourneyInput = z.infer<typeof startJourneySchema>;
export type OnboardingTaskDto = z.infer<typeof onboardingTaskSchema>;
export type JourneyDto = z.infer<typeof journeySchema>;
export type QueueRowDto = z.infer<typeof queueRowSchema>;
