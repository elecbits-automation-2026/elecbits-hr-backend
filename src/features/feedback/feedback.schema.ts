import { z } from '../../shared/zod.js';

/**
 * Feedback notes (§insights phase C): drafted from evidence by the system,
 * reviewed and SENT BY A HUMAN — appreciation or concern, author → recipient.
 */
export const createFeedbackSchema = z
  .object({
    employeeId: z.string().uuid(),
    type: z.enum(['appreciation', 'concern']),
    body: z.string().trim().min(3).max(2000),
    // The insight the draft came from, human-readable — answers "why?".
    evidence: z.string().max(500).optional(),
  })
  .strict()
  .openapi('CreateFeedback');

export const feedbackNoteSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({ id: z.string().uuid(), name: z.string() }),
    author: z.object({ id: z.string().uuid(), name: z.string() }),
    type: z.enum(['appreciation', 'concern']),
    body: z.string(),
    evidence: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('FeedbackNote');

/**
 * One person's notes history for their manager or HR: type, date and sender
 * for every note; the body only where the viewer wrote it — a note stays
 * between its sender and its recipient (Phase 4).
 */
export const noteHistorySchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(['appreciation', 'concern']),
    author: z.object({ id: z.string().uuid(), name: z.string() }),
    body: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('FeedbackNoteHistory');

export type NoteHistoryDto = z.infer<typeof noteHistorySchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export type FeedbackNoteDto = z.infer<typeof feedbackNoteSchema>;
