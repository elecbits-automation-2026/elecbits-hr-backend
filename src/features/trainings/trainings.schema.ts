import { z } from '../../shared/zod.js';

export const TRAINING_STREAMS = [
  'compliance',
  'leadership',
  'company',
  'functional',
] as const;
export const TRAINING_STATUSES = ['assigned', 'completed', 'cancelled'] as const;

const personRef = z.object({ id: z.string().uuid(), name: z.string() });

export const trainingSchema = z
  .object({
    id: z.string().uuid(),
    employee: personRef.extend({ department: z.string().nullable() }),
    title: z.string(),
    stream: z.enum(TRAINING_STREAMS),
    description: z.string().nullable(),
    link: z.string().nullable(),
    dueOn: z.string().nullable(),
    status: z.enum(TRAINING_STATUSES),
    /** Assigned, past its due date. */
    overdue: z.boolean(),
    assignedBy: personRef,
    assignedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    completionNote: z.string().nullable(),
    cancelledAt: z.string().datetime().nullable(),
    certificate: z
      .object({ fileName: z.string(), sizeBytes: z.number().int() })
      .nullable(),
  })
  .openapi('Training');

export const assignTrainingSchema = z
  .object({
    /** One person or many (HR); a manager only their own reports. */
    employeeIds: z.array(z.string().uuid()).min(1).max(500),
    title: z.string().trim().min(3).max(120),
    stream: z.enum(TRAINING_STREAMS),
    description: z.string().trim().max(1000).optional(),
    link: z.string().trim().url().max(500).optional(),
    dueOn: z.string().date().optional(),
  })
  .strict()
  .openapi('AssignTraining');

export const completeTrainingSchema = z
  .object({ note: z.string().trim().max(1000).optional() })
  .strict()
  .openapi('CompleteTraining');

export const assignResultSchema = z
  .object({
    assigned: z.number().int(),
    /** People skipped: already have an open training with this title. */
    skipped: z.array(personRef),
  })
  .openapi('AssignTrainingResult');

export type TrainingStream = (typeof TRAINING_STREAMS)[number];
export type TrainingDto = z.infer<typeof trainingSchema>;
export type AssignTrainingInput = z.infer<typeof assignTrainingSchema>;
export type CompleteTrainingInput = z.infer<typeof completeTrainingSchema>;
export type AssignResultDto = z.infer<typeof assignResultSchema>;
