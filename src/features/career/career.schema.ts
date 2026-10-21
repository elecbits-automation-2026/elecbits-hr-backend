import { z } from '../../shared/zod.js';

const LEVEL = z.enum(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);

export const bandSchema = z
  .object({
    code: LEVEL,
    name: z.string(),
    next: LEVEL.nullable(),
    expects: z.string(),
  })
  .openapi('Band');

export const careerTrackSchema = z
  .object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    bandCode: LEVEL,
    targetBand: LEVEL,
    note: z.string().nullable(),
    openedByName: z.string().nullable(),
    status: z.enum(['open', 'met', 'closed']),
    closeReason: z.string().nullable(),
    closedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('CareerTrack');

export const levelChangeSchema = z
  .object({
    from: LEVEL,
    to: LEVEL,
    at: z.string().datetime(),
    byName: z.string().nullable(),
    /** The roadmap this change fulfilled, if one was open. */
    trackId: z.string().uuid().nullable(),
  })
  .openapi('LevelChange');

export const trackNoteSchema = z
  .object({
    id: z.string().uuid(),
    body: z.string(),
    authorName: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('CareerTrackNote');

/** Why the employee may (not) ask for the conversation themselves. */
export const selfRequestSchema = z
  .object({
    allowed: z.boolean(),
    /** Plain-language reasons it is blocked; empty when allowed. */
    blockers: z.array(z.string()),
    inBandSince: z.string().nullable(),
    lastQuarter: z.object({ name: z.string(), attainment: z.number().int().nullable() }),
  })
  .openapi('CareerSelfRequest');

/** Evidence is DERIVED from the record, never typed in. */
export const myCareerSchema = z
  .object({
    ladder: z.array(bandSchema),
    current: LEVEL,
    next: LEVEL.nullable(),
    evidence: z.object({
      /** Days with a punch in the last 30. */
      punchedDays30: z.number().int(),
      /** Approved recognitions, all time. */
      recognitions: z.number().int(),
      /** Appreciation notes received, all time. */
      appreciationNotes: z.number().int(),
      /** This quarter's weighted goal attainment; null with no goals. */
      quarter: z.object({ name: z.string(), attainment: z.number().int().nullable() }),
    }),
    track: careerTrackSchema.nullable(),
    notes: z.array(trackNoteSchema),
    history: z.array(levelChangeSchema),
    selfRequest: selfRequestSchema,
  })
  .openapi('MyCareer');

/** One person's career, for their RM or HR (the person sheet). */
export const personCareerSchema = z
  .object({
    current: LEVEL,
    next: LEVEL.nullable(),
    track: careerTrackSchema.nullable(),
    notes: z.array(trackNoteSchema),
    history: z.array(levelChangeSchema),
  })
  .openapi('PersonCareer');

export const addTrackNoteSchema = z
  .object({ body: z.string().trim().min(2).max(2000) })
  .strict()
  .openapi('AddCareerTrackNote');

export const openTrackSchema = z
  .object({
    employeeId: z.string().uuid(),
    /** Only ever the band directly above — anything else is refused. */
    targetBand: LEVEL.optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .openapi('OpenCareerTrack');

export const closeTrackSchema = z
  .object({
    outcome: z.enum(['met', 'closed']),
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('CloseCareerTrack');

export const teamCareerRowSchema = z
  .object({
    employee: z.object({ id: z.string().uuid(), name: z.string(), employeeCode: z.string() }),
    level: LEVEL,
    recognitions: z.number().int(),
    /** Last approved recognition, if any — feeds "due a conversation". */
    lastRecognizedAt: z.string().datetime().nullable(),
    track: careerTrackSchema.nullable(),
  })
  .openapi('TeamCareerRow');

export type BandDto = z.infer<typeof bandSchema>;
export type CareerTrackDto = z.infer<typeof careerTrackSchema>;
export type MyCareerDto = z.infer<typeof myCareerSchema>;
export type PersonCareerDto = z.infer<typeof personCareerSchema>;
export type LevelChangeDto = z.infer<typeof levelChangeSchema>;
export type TrackNoteDto = z.infer<typeof trackNoteSchema>;
export type AddTrackNoteInput = z.infer<typeof addTrackNoteSchema>;
export type OpenTrackInput = z.infer<typeof openTrackSchema>;
export type CloseTrackInput = z.infer<typeof closeTrackSchema>;
export type TeamCareerRowDto = z.infer<typeof teamCareerRowSchema>;
