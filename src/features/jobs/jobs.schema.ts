import { z } from '../../shared/zod.js';

export const jobSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    schedule: z.string(),
  })
  .openapi('BackgroundJob');

export const jobRunSchema = z
  .object({
    id: z.string().uuid(),
    job: z.string(),
    /** A date for a scheduled run, manual-… for "run now". */
    runKey: z.string(),
    status: z.enum(['running', 'succeeded', 'failed']),
    attempts: z.number().int(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    /** e.g. { waiting: 9, reminded: 6, leave: 2, … } */
    summary: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable(),
  })
  .openapi('BackgroundJobRun');

export const jobsOverviewSchema = z
  .object({
    schedulerEnabled: z.boolean(),
    jobs: z.array(jobSchema),
    runs: z.array(jobRunSchema),
  })
  .openapi('BackgroundJobsOverview');

export type JobDto = z.infer<typeof jobSchema>;
export type JobRunDto = z.infer<typeof jobRunSchema>;
