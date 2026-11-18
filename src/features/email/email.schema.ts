import { z } from '../../shared/zod.js';

/** The Admin card on the Jobs page: is email on, what waits, what failed. */
export const emailStatusSchema = z
  .object({
    /** The Admin switch (settings email.delivery). */
    enabled: z.boolean(),
    /** log = written to the server log only; gmail = really sent. */
    driver: z.enum(['log', 'gmail']),
    from: z.string(),
    replyTo: z.string().nullable(),
    /** Set while testing: every email goes to this one address instead. */
    redirectTo: z.string().nullable(),
    pending: z.number().int(),
    failed: z.number().int(),
    sentLastDay: z.number().int(),
    sentLast30Days: z.number().int(),
    recentFailures: z.array(
      z.object({
        id: z.string().uuid(),
        toAddress: z.string(),
        type: z.string(),
        subject: z.string(),
        attempts: z.number().int(),
        lastError: z.string().nullable(),
        createdAt: z.string().datetime(),
      }),
    ),
  })
  .openapi('EmailStatus');

export const emailRetrySchema = z
  .object({ requeued: z.number().int() })
  .openapi('EmailRetryResult');

export const emailTestSchema = z
  .object({ sentTo: z.string(), driver: z.enum(['log', 'gmail']) })
  .openapi('EmailTestResult');

export type EmailStatusDto = z.infer<typeof emailStatusSchema>;
