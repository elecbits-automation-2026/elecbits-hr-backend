import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { departments } from './departments.js';
import { employees } from './employees.js';
import { bytea } from './policies.js';
import {
  approvalDecisionEnum,
  applicationStageEnum,
  approvalSubjectEnum,
  approverRoleEnum,
  bgvStatusEnum,
  candidateDocStatusEnum,
  candidateSourceEnum,
  hiringPriorityEnum,
  offerStatusEnum,
  interviewModeEnum,
  interviewRecommendationEnum,
  taActivityKindEnum,
  taActivityOutcomeEnum,
  interviewRoundEnum,
  interviewSlotStatusEnum,
  positionStatusEnum,
  requisitionStatusEnum,
  taDocumentKindEnum,
  taDocumentStatusEnum,
} from './enums.js';

/** The `ta` schema: Talent Acquisition (hiring), built step by step (TA design). */
export const taSchema = pgSchema('ta');

/**
 * A department's hiring plan for one quarter — the sheet the head fills.
 * Only a container: each line (requisition) is approved on its own. Created
 * the first time a line is added. Belongs to the DEPARTMENT, not the head,
 * so a new or acting head picks up everything pending.
 */
export const hiringPlans = taSchema.table(
  'hiring_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    /** 'YYYY-Qn' — the quarter the hires are for. */
    quarter: text('quarter').notNull(),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('hiring_plans_dept_quarter_uq').on(t.departmentId, t.quarter)],
);

/**
 * One line of a plan: "2 × Hardware Engineer". `version` goes up when a
 * returned line is edited — approvals are recorded per version, so an edit
 * resets everyone (TA design). `planId` is null for an urgent line (Step E).
 */
/** Numbers the readable Hiring Request IDs (HR-<quarter>-0001, …). */
export const requisitionCodeSeq = taSchema.sequence('requisition_code_seq');

export const requisitions = taSchema.table(
  'requisitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id').references(() => hiringPlans.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    /**
     * The readable Hiring Request ID, e.g. HR-2027Q1-0007 (TA workflow deck,
     * 2026-10-27): set at creation from `ta.requisition_code_seq`.
     */
    requestCode: text('request_code').unique(),
    roleTitle: text('role_title').notNull(),
    quantity: integer('quantity').notNull(),
    notes: text('notes'),
    // Request details from the TA workflow deck (2026-10-27): required by the
    // API on new lines; null only on lines made before.
    reason: text('reason'),
    targetJoiningOn: date('target_joining_on'),
    location: text('location'),
    reportingManagerId: uuid('reporting_manager_id').references(() => employees.id),
    priority: hiringPriorityEnum('priority').notNull().default('normal'),
    employmentType: text('employment_type'),
    /**
     * The head's budget for ONE hire (2026-10-26). No longer asked or shown
     * (learner, 2026-10-27); kept as history.
     */
    budgetMin: numeric('budget_min', { precision: 12, scale: 2 }),
    budgetMax: numeric('budget_max', { precision: 12, scale: 2 }),
    version: integer('version').notNull().default(1),
    status: requisitionStatusEnum('status').notNull().default('draft'),
    urgent: boolean('urgent').notNull().default(false),
    /** Urgent lines (Step E): the department head who asked; TA created the line. */
    urgentRequestedBy: uuid('urgent_requested_by').references(() => employees.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => employees.id),
    submittedBy: uuid('submitted_by').references(() => employees.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** Why the last rejection sent it back (cleared on resubmit). */
    returnReason: text('return_reason'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /**
     * The TA RM Admin gave this line to (a TA-batch holder with reports). They
     * hand its positions to their team, validate shortlists and decide the hire.
     */
    taRmId: uuid('ta_rm_id').references(() => employees.id),
    taRmAssignedAt: timestamp('ta_rm_assigned_at', { withTimezone: true }),
    taRmAssignedBy: uuid('ta_rm_assigned_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('requisitions_quantity_ck', sql`${t.quantity} BETWEEN 1 AND 50`),
    check(
      'requisitions_budget_ck',
      sql`${t.budgetMin} IS NULL OR (${t.budgetMin} > 0 AND ${t.budgetMax} >= ${t.budgetMin})`,
    ),
    index('requisitions_ta_rm_idx').on(t.taRmId),
    index('requisitions_status_idx').on(t.status),
    index('requisitions_plan_idx').on(t.planId),
  ],
);

/** Which interview rounds a line uses, and who the head named to conduct each. */
export const requisitionRounds = taSchema.table(
  'requisition_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => requisitions.id),
    round: interviewRoundEnum('round').notNull(),
    /** Null = not named yet (HR rounds default to the recruiter later). */
    interviewerId: uuid('interviewer_id').references(() => employees.id),
  },
  (t) => [uniqueIndex('requisition_rounds_uq').on(t.requisitionId, t.round)],
);

/**
 * Every approve / reject on a TA subject, for the VERSION it was given on.
 * Append-only: older versions' rows stay as the revision history. One row
 * per role per version — the unique index stops a double decision.
 */
export const taApprovals = taSchema.table(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectKind: approvalSubjectEnum('subject_kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    version: integer('version').notNull(),
    role: approverRoleEnum('role').notNull(),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => employees.id),
    decision: approvalDecisionEnum('decision').notNull(),
    reason: text('reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ta_approvals_uq').on(t.subjectKind, t.subjectId, t.version, t.role),
    check(
      'ta_approvals_reason_ck',
      sql`${t.decision} = 'approve' OR coalesce(btrim(${t.reason}), '') <> ''`,
    ),
  ],
);

/**
 * One seat of an approved line ("Hardware Engineer #2"): its own recruiter,
 * progress and outcome. Created with the approval; opens once ITS OWN JD
 * and scorecard (written by its recruiter) are both approved. The recruiter is assigned through a goal
 * (`org.goals.position_id`) whose progress the position drives.
 */
export const positions = taSchema.table(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => requisitions.id),
    /** 1..quantity within the line. */
    number: integer('number').notNull(),
    status: positionStatusEnum('status').notNull().default('awaiting_docs'),
    recruiterId: uuid('recruiter_id').references(() => employees.id),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    /** TA ownership (workflow deck, 2026-10-27): copied from the line, set by the TA RM. */
    priority: hiringPriorityEnum('priority').notNull().default('normal'),
    expectedCloseOn: date('expected_close_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('positions_req_number_uq').on(t.requisitionId, t.number)],
);

/**
 * A position's JD and scorecard — one of each, written by the position's
 * recruiter (learner, 2026-10-27; was one per line). Each is reviewed on its
 * own by the line's TA RM + the department head, any order (the dept head
 * alone when the TA RM is the recruiter); approvals sit in `ta.approvals`
 * per version, so a returned document's edit resets them. `requisition_id`
 * is kept for joins. `content` is the JD fields, or the scorecard.
 */
export const taDocuments = taSchema.table(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => requisitions.id),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id),
    kind: taDocumentKindEnum('kind').notNull(),
    version: integer('version').notNull().default(1),
    status: taDocumentStatusEnum('status').notNull().default('draft'),
    content: jsonb('content').notNull(),
    writtenBy: uuid('written_by')
      .notNull()
      .references(() => employees.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    returnReason: text('return_reason'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ta_documents_position_kind_uq').on(t.positionId, t.kind)],
);

/**
 * The PERSON (TA Step D): one row however many positions they are considered
 * for — the talent pool. Kept 6 months after the last consideration
 * (`retain_until`, restarted on every new application), then anonymised by a
 * job (Step F): name, contact and CV go, the row and its counts stay.
 * `consent_at` records the candidate agreeing to be kept.
 */
/** Numbers the readable candidate IDs (C-000001, …). */
export const candidateCodeSeq = taSchema.sequence('candidate_code_seq');

export const candidates = taSchema.table(
  'candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Lower-cased; null once anonymised. */
    email: text('email'),
    phone: text('phone'),
    source: candidateSourceEnum('source').notNull(),
    /** The employee who referred them (source = referral). */
    referredBy: uuid('referred_by').references(() => employees.id),
    notes: text('notes'),
    /** Readable candidate ID, e.g. C-000123 — stable from the first entry. */
    candidateCode: text('candidate_code').unique(),
    // Candidate tracker (TA workflow deck, 2026-10-27).
    currentCompany: text('current_company'),
    designation: text('designation'),
    location: text('location'),
    noticeDays: integer('notice_days'),
    currentCtc: numeric('current_ctc', { precision: 12, scale: 2 }),
    expectedCtc: numeric('expected_ctc', { precision: 12, scale: 2 }),
    availableFrom: date('available_from'),
    /**
     * For the scorecard summary (learner, 2026-10-27): required by the API
     * for every new candidate; null only on candidates added before.
     */
    education: text('education'),
    experienceYears: numeric('experience_years', { precision: 4, scale: 1 }),
    consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
    retainUntil: date('retain_until').notNull(),
    anonymisedAt: timestamp('anonymised_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The duplicate arbiter: one live candidate per email.
    uniqueIndex('candidates_email_uq')
      .on(t.email)
      .where(sql`${t.email} IS NOT NULL`),
    index('candidates_phone_idx').on(t.phone),
  ],
);

/** The candidate's CV — one current file (replaced on re-upload), like leave certificates. */
export const candidateCvs = taSchema.table('candidate_cvs', {
  candidateId: uuid('candidate_id')
    .primaryKey()
    .references(() => candidates.id),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  data: bytea('data').notNull(),
  uploadedBy: uuid('uploaded_by')
    .notNull()
    .references(() => employees.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A candidate for ONE position (TA Step D) — the "living form" of the TA
 * design: stage, who validated the shortlist, why it ended. One per
 * candidate per position; reusing a pool candidate makes a new one.
 */
export const applications = taSchema.table(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidates.id),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id),
    stage: applicationStageEnum('stage').notNull().default('sourced'),
    /** What happens next, who does it, by when (workflow deck: live progress). */
    nextAction: text('next_action'),
    nextActionOwnerId: uuid('next_action_owner_id').references(() => employees.id),
    nextActionDue: date('next_action_due'),
    /**
     * Rounds run one after another (learner, 2026-10-27): the round open now —
     * only it can be scheduled and scored; a pass opens the next.
     */
    currentRound: interviewRoundEnum('current_round'),
    /** The rejection record: in which round, by whom, and when the candidate was told. */
    rejectedRound: interviewRoundEnum('rejected_round'),
    rejectedBy: uuid('rejected_by').references(() => employees.id),
    informedAt: timestamp('informed_at', { withTimezone: true }),
    shortlistedBy: uuid('shortlisted_by').references(() => employees.id),
    shortlistedAt: timestamp('shortlisted_at', { withTimezone: true }),
    interviewsStartedAt: timestamp('interviews_started_at', { withTimezone: true }),
    /** Why it was rejected / withdrawn. */
    outcomeReason: text('outcome_reason'),
    // ── Step E: decision, offer, BGV, hire ──
    decisionStartedAt: timestamp('decision_started_at', { withTimezone: true }),
    selectedAt: timestamp('selected_at', { withTimezone: true }),
    /** Annual CTC offered (₹), negotiated in the HR final round. */
    offeredCtc: numeric('offered_ctc', { precision: 12, scale: 2 }),
    joiningDate: date('joining_date'),
    offeredAt: timestamp('offered_at', { withTimezone: true }),
    /**
     * HR Head offer approval (workflow deck, 2026-10-27): TA drafts the terms,
     * the HR Head approves and uploads the signed letter, then TA shares it.
     * Changing approved terms sends them back for approval.
     */
    offerTerms: text('offer_terms'),
    offerStatus: offerStatusEnum('offer_status'),
    offerReturnReason: text('offer_return_reason'),
    offerApprovedBy: uuid('offer_approved_by').references(() => employees.id),
    offerApprovedAt: timestamp('offer_approved_at', { withTimezone: true }),
    /** The candidate's document folder (Candidate ID + Name), linked from the profile. */
    folderLink: text('folder_link'),
    /** HRBP confirmed the person actually joined. */
    joinedConfirmedBy: uuid('joined_confirmed_by').references(() => employees.id),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    bgvStatus: bgvStatusEnum('bgv_status').notNull().default('not_started'),
    bgvNotes: text('bgv_notes'),
    bgvUpdatedAt: timestamp('bgv_updated_at', { withTimezone: true }),
    /** The employee record Mark hired created. */
    employeeId: uuid('employee_id').references(() => employees.id),
    hiredAt: timestamp('hired_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('applications_candidate_position_uq').on(t.candidateId, t.positionId),
    index('applications_position_idx').on(t.positionId),
  ],
);

/**
 * One interviewer's scores for one round of one application: each scorecard
 * criterion 1–5, a recommendation and notes. FINAL once written — one row per
 * (application, round), no updates.
 */
export const interviewScores = taSchema.table(
  'interview_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id),
    round: interviewRoundEnum('round').notNull(),
    interviewerId: uuid('interviewer_id')
      .notNull()
      .references(() => employees.id),
    /** [{ criterion, score 1–5 }] — the round's scorecard criteria at the time. */
    scores: jsonb('scores').notNull(),
    recommendation: interviewRecommendationEnum('recommendation').notNull(),
    notes: text('notes'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('interview_scores_app_round_uq').on(t.applicationId, t.round)],
);

/**
 * The offer letter (TA Step E) — made outside the HRMS for now and uploaded
 * here, one current file per application (replaced on re-upload).
 */
export const offerLetters = taSchema.table('offer_letters', {
  applicationId: uuid('application_id')
    .primaryKey()
    .references(() => applications.id),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  data: bytea('data').notNull(),
  uploadedBy: uuid('uploaded_by')
    .notNull()
    .references(() => employees.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * When a round of an application happens (learner, 2026-10-27): the
 * position's recruiter (or the line's TA RM) schedules it with the round's
 * interviewer, who sees it on My interviews. One live (scheduled) slot per
 * round; rescheduling moves it, cancelling ends it, scoring marks it done.
 * Rows are kept as history.
 */
export const interviewSlots = taSchema.table(
  'interview_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id),
    round: interviewRoundEnum('round').notNull(),
    interviewerId: uuid('interviewer_id')
      .notNull()
      .references(() => employees.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    durationMin: integer('duration_min').notNull().default(60),
    mode: interviewModeEnum('mode').notNull(),
    /** Room / address for in person, the meeting link for video, the number for phone. */
    location: text('location'),
    status: interviewSlotStatusEnum('status').notNull().default('scheduled'),
    /** Why it was cancelled / marked no-show. */
    endReason: text('end_reason'),
    scheduledBy: uuid('scheduled_by')
      .notNull()
      .references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('interview_slots_live_uq')
      .on(t.applicationId, t.round)
      .where(sql`${t.status} = 'scheduled'`),
    index('interview_slots_interviewer_idx').on(t.interviewerId, t.startsAt),
    check('interview_slots_duration_ck', sql`${t.durationMin} BETWEEN 15 AND 480`),
  ],
);

/**
 * Where a position is being sourced (workflow deck step 6): each channel the
 * recruiter activated — portal, referral drive, outreach — with the date and
 * the SPOC. Kept as history.
 */
export const sourceActivations = taSchema.table(
  'source_activations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id),
    channel: candidateSourceEnum('channel').notNull(),
    activatedOn: date('activated_on').notNull(),
    spocId: uuid('spoc_id')
      .notNull()
      .references(() => employees.id),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('source_activations_position_idx').on(t.positionId)],
);

/**
 * Every contact with a candidate on an application (workflow deck: daily
 * update, "calls done") — calls, emails, WhatsApp, meetings and how they went.
 * Append-only.
 */
export const taActivities = taSchema.table(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id),
    kind: taActivityKindEnum('kind').notNull(),
    outcome: taActivityOutcomeEnum('outcome').notNull(),
    notes: text('notes'),
    happenedAt: timestamp('happened_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => employees.id),
  },
  (t) => [index('activities_application_idx').on(t.applicationId, t.happenedAt)],
);

/** The offer letter as signed by the HR Head — what TA shares with the candidate. */
export const signedOfferLetters = taSchema.table('signed_offer_letters', {
  applicationId: uuid('application_id')
    .primaryKey()
    .references(() => applications.id),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  data: bytea('data').notNull(),
  uploadedBy: uuid('uploaded_by')
    .notNull()
    .references(() => employees.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Documents asked of a candidate once every round passed (workflow deck
 * steps 13–14): a checklist of requested / received / not applicable. The
 * files themselves live in the candidate's folder (`applications.folder_link`).
 */
export const applicationDocuments = taSchema.table(
  'application_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id),
    name: text('name').notNull(),
    status: candidateDocStatusEnum('status').notNull().default('requested'),
    updatedBy: uuid('updated_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('application_documents_uq').on(t.applicationId, t.name)],
);
