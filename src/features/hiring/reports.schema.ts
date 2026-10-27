import { z } from '../../shared/zod.js';

/** A period: from / to dates, both inclusive. */
export const reportPeriodQuery = z
  .object({ from: z.string().date(), to: z.string().date() })
  .refine((v) => v.from <= v.to, { message: '"from" must be on or before "to"', path: ['to'] });

/**
 * One role × SPOC row of the TA tracker (workflow deck slides 14–16), counted
 * by the deck's rules over the period: unique applications sourced; call
 * attempts and unique people called; screened = round 1 scored; interviews
 * aligned (scheduled) and held; offers shared, accepted, joined; rejected
 * and withdrawn kept apart; open next actions overdue today.
 */
export const reportRowSchema = z
  .object({
    positionId: z.string().uuid(),
    requestCode: z.string().nullable(),
    roleTitle: z.string(),
    positionNumber: z.number().int(),
    departmentName: z.string(),
    spocName: z.string().nullable(),
    sourced: z.number().int(),
    callAttempts: z.number().int(),
    callUnique: z.number().int(),
    screened: z.number().int(),
    aligned: z.number().int(),
    held: z.number().int(),
    offersShared: z.number().int(),
    accepted: z.number().int(),
    joined: z.number().int(),
    rejected: z.number().int(),
    withdrawn: z.number().int(),
    overdue: z.number().int(),
  })
  .openapi('HiringReportRow');

export const hiringReportSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    rows: z.array(reportRowSchema),
  })
  .openapi('HiringReport');

/** An open next action, for the pending / overdue list (by owner, due date). */
export const pendingActionSchema = z
  .object({
    applicationId: z.string().uuid(),
    candidateName: z.string(),
    candidateCode: z.string().nullable(),
    roleTitle: z.string(),
    positionNumber: z.number().int(),
    stage: z.string(),
    nextAction: z.string(),
    ownerName: z.string().nullable(),
    due: z.string().nullable(),
    overdue: z.boolean(),
  })
  .openapi('PendingAction');

export const TRACKER_VIEWS = ['internal', 'external'] as const;

/**
 * One candidate on one position, for the hiring trackers. The EXTERNAL view
 * (dept heads / leadership) leaves out contact details and CTC; the INTERNAL
 * view (TA / HR) has everything.
 */
export const trackerRowSchema = z
  .object({
    applicationId: z.string().uuid(),
    requestCode: z.string().nullable(),
    candidateCode: z.string().nullable(),
    candidateName: z.string(),
    roleTitle: z.string(),
    positionNumber: z.number().int(),
    departmentName: z.string(),
    spocName: z.string().nullable(),
    source: z.string(),
    stage: z.string(),
    currentRound: z.string().nullable(),
    experienceYears: z.number().nullable(),
    location: z.string().nullable(),
    noticeDays: z.number().int().nullable(),
    joiningDate: z.string().nullable(),
    scoreTotal: z.number().nullable(),
    addedOn: z.string(),
    // Internal view only (null in the external one):
    email: z.string().nullable(),
    phone: z.string().nullable(),
    currentCtc: z.number().nullable(),
    expectedCtc: z.number().nullable(),
    offeredCtc: z.number().nullable(),
  })
  .openapi('TrackerRow');

export type ReportRowDto = z.infer<typeof reportRowSchema>;
export type HiringReportDto = z.infer<typeof hiringReportSchema>;
export type PendingActionDto = z.infer<typeof pendingActionSchema>;
export type TrackerRowDto = z.infer<typeof trackerRowSchema>;
export type TrackerView = (typeof TRACKER_VIEWS)[number];
