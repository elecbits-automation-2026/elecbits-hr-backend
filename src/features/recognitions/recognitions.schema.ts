import {
  CITATION_MAX_LENGTH,
  CITATION_MIN_LENGTH,
} from '../../shared/constants/constants.js';
import { z } from '../../shared/zod.js';

/** An award-catalog key (settings awards.catalog) — HR may add new ones. */
export const awardKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,30}$/, 'Unknown award type');

/**
 * A nomination: the citation IS the award. A manager nominates their own
 * reports; a TEAM award (catalog entry with team: true) may name several, the
 * value split equally. The citation is CITATION_MIN_LENGTH–CITATION_MAX_LENGTH
 * characters (fixed, not a setting).
 */
export const createRecognitionSchema = z
  .object({
    employeeIds: z.array(z.string().uuid()).min(1).max(25),
    type: awardKeySchema,
    citation: z
      .string()
      .trim()
      .min(
        CITATION_MIN_LENGTH,
        `Write at least ${CITATION_MIN_LENGTH} characters — they will read this`,
      )
      .max(CITATION_MAX_LENGTH),
  })
  .strict()
  .openapi('CreateRecognition');

export const decideRecognitionSchema = z
  .object({
    decision: z.enum(['approve', 'decline']),
    /** Mandatory on decline — the nominator sees it. */
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine((v) => v.decision !== 'decline' || v.reason !== undefined, {
    message: 'Declining needs a reason the nominator will see',
    path: ['reason'],
  })
  .openapi('DecideRecognition');

const personRef = z.object({ id: z.string().uuid(), name: z.string() });

export const recognitionSchema = z
  .object({
    id: z.string().uuid(),
    /** The recipient of THIS row; a team award lists everyone in `recipients`. */
    employee: personRef,
    recipients: z.array(personRef),
    /** Set on a team award — every recipient's row shares it. */
    groupId: z.string().uuid().nullable(),
    type: z.string(),
    /** Snapshot of the catalog name at nomination. */
    awardName: z.string(),
    citation: z.string(),
    /** This recipient's share (a team award's total is split equally). */
    valueInr: z.number().int(),
    nominatedBy: personRef,
    status: z.enum(['pending', 'approved', 'declined']),
    cycle: z.string().nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('Recognition');

/** The public board: approved awards only, ranked by count then value. */
export const boardSchema = z
  .object({
    ranking: z.array(
      z.object({
        employee: personRef,
        count: z.number().int(),
        totalInr: z.number().int(),
        /** Award key -> how many of that type. */
        byType: z.record(z.string(), z.number().int()),
      }),
    ),
    recent: z.array(recognitionSchema),
    /** Award key -> display name, for the per-type badges. */
    typeNames: z.record(z.string(), z.string()),
  })
  .openapi('RecognitionBoard');

/** The nomination picker: the caller's own reports (HR: also the top people). */
export const directoryEntrySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    employeeCode: z.string(),
    designation: z.string().nullable(),
  })
  .openapi('DirectoryEntry');

/** One award type as nominators see it. */
export const catalogEntrySchema = z
  .object({
    key: z.string(),
    name: z.string(),
    cadence: z.enum(['any', 'monthly', 'quarterly']),
    valueInr: z.number().int(),
    /** May name several recipients; the value is split equally. */
    team: z.boolean(),
  })
  .openapi('AwardCatalogEntry');

export type CreateRecognitionInput = z.infer<typeof createRecognitionSchema>;
export type DecideRecognitionInput = z.infer<typeof decideRecognitionSchema>;
export type RecognitionDto = z.infer<typeof recognitionSchema>;
export type BoardDto = z.infer<typeof boardSchema>;
export type DirectoryEntryDto = z.infer<typeof directoryEntrySchema>;
export type CatalogEntryDto = z.infer<typeof catalogEntrySchema>;
