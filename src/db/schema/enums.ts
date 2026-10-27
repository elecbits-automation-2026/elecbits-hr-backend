import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Shared Postgres enums. Kept in one file so a value list is defined exactly
 * once and the TS unions in shared/constants stay in step with the DB.
 *
 * The permission shape is the design doc's `(module, action, scope)` tuple
 * (§3.1); everything else models statuses of the flows built on top of it.
 */

// CRUD actions a grant can carry (§3.1).
export const actionEnum = pgEnum('action', ['create', 'read', 'update', 'delete']);

// How far a grant reaches (§3.1). `team` = whole reporting subtree, derived at
// query time from `reports_to`; `dept` = department incl. sub-departments.
export const scopeEnum = pgEnum('scope', ['me', 'team_direct', 'team', 'dept', 'org']);

// Seniority levels L1–L6 (§2.3). A level suggests defaults; it never grants
// access by itself (§2.3 design rule).
export const levelEnum = pgEnum('level', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);

// Deactivate, never delete (§10): leavers become `inactive`, rows stay.
export const employeeStatusEnum = pgEnum('employee_status', [
  'invited', // HRBP created the record; the person has not claimed it yet (§5.4)
  'active',
  'exiting', // resignation submitted, clearances in flight (§8)
  'inactive',
]);

// Grant-request lifecycle (§5.5). "approved_narrower" records that the Owner
// granted less than was asked for — the items table holds what was granted.
export const requestStatusEnum = pgEnum('request_status', [
  'pending',
  'approved',
  'approved_narrower',
  'declined',
  'cancelled', // pending requests are cancelled on exit (§8)
]);

// Leave types per the Attendance/Leave policy v1. `casual` is retired (kept
// for historical rows); earned and menstrual accrue monthly.
export const leaveTypeEnum = pgEnum('leave_type', [
  'casual',
  'sick',
  'earned',
  'unpaid',
  'menstrual',
  'vacation_family',
  'compassionate',
]);

// A leave is whole days, or one half of a single day.
export const leaveDayPartEnum = pgEnum('leave_day_part', [
  'full',
  'first_half',
  'second_half',
]);

// Dual approval: RM + HRBP in any order. One in -> partially_approved; both ->
// approved. declined/cancelled are terminal.
export const leaveStatusEnum = pgEnum('leave_status', [
  'pending',
  'partially_approved',
  'approved',
  'declined',
  'cancelled',
]);

// Where a punch came from: the office IP list, anywhere else (flagged unless
// WFH-approved), or written by an approved regularization.
/** Feedback notes (manager → report): praise or a concern, never auto-sent. */
export const feedbackTypeEnum = pgEnum('feedback_type', ['appreciation', 'concern']);

// Policy library groupings — display order follows this list.
export const policyCategoryEnum = pgEnum('policy_category', [
  'conduct',
  'handbook',
  'performance',
  'time',
  'culture',
  'other',
]);

// Onboarding: three phases anchored to the joining date (-7 / 0 / +30 days).
export const onboardingPhaseEnum = pgEnum('onboarding_phase', [
  'before_start',
  'week_one',
  'first_30',
]);

// Who a checklist task WAITS ON — only that owner (or HR) can tick it, so an
// employee can never tick their own background check.
export const onboardingTaskOwnerEnum = pgEnum('onboarding_task_owner', [
  'employee',
  'hr',
  'manager',
  'admin',
  // Close-out: the joiner hand-off reaches OPS (kit) and payroll (salary + bank).
  'ops',
  'payroll',
]);

export const onboardingStatusEnum = pgEnum('onboarding_status', ['open', 'done']);

// A nomination needs one approval (RM-or-HR) before it reaches the board —
// unlike the source tool, nothing publishes itself.
export const recognitionStatusEnum = pgEnum('recognition_status', [
  'pending',
  'approved',
  'declined',
]);

// A career track is an OPEN CONVERSATION about the next band, never a
// promotion record: `met` closes it well, `closed` just ends it.
export const careerTrackStatusEnum = pgEnum('career_track_status', ['open', 'met', 'closed']);

export const attendanceSourceEnum = pgEnum('attendance_source', [
  'office',
  'remote',
  'regularized',
]);

// Why someone needs to punch from outside the office zone — all three go
// through the same RM-approved request.
export const remoteWorkTypeEnum = pgEnum('remote_work_type', [
  'wfh',
  'client_visit',
  'remote',
]);

// Request lifecycle for attendance requests. Regularizations stay
// single-approver (RM); remote-work requests are DUAL (RM + HR, any order) —
// partially_approved marks one of two slots filled.
export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'partially_approved',
  'approved',
  'declined',
  'cancelled',
]);

// Payroll run lifecycle: finalizing locks the numbers and publishes payslips
// to employees; paid is terminal.
export const payrollRunStatusEnum = pgEnum('payroll_run_status', [
  'draft',
  'finalized',
  'paid',
]);

// A post-finalize correction waits (pending) for the next run to finalize,
// which carries it (applied); PR may cancel it while it is still pending.
export const payslipCorrectionStatusEnum = pgEnum('payslip_correction_status', [
  'pending',
  'applied',
  'cancelled',
]);

// A reimbursement claim: the RM, then Payroll (self-governed / no-RM people
// skip the RM step); approved claims ride on the next payroll run and turn
// `paid` when it finalizes.
export const reimbursementStatusEnum = pgEnum('reimbursement_status', [
  'pending_rm',
  'pending_payroll',
  'approved',
  'paid',
  'declined',
  'cancelled',
]);

// CGP goal categories (Performance & Appraisal Policy §6/§8): the quarter
// score weighs Fundamental 50%, Corporate 25%, General 25%.
export const goalCategoryEnum = pgEnum('goal_category', ['fundamental', 'corporate', 'general']);

// Batch 4 — concerns: three policy tracks (Dispute Resolution Framework,
// Equal Opportunity / anti-bullying complaints, Whistleblower). POSH is never
// stored: it belongs to the Internal Committee.
export const concernTrackEnum = pgEnum('concern_track', ['dispute', 'complaint', 'whistleblower']);
export const concernStatusEnum = pgEnum('concern_status', [
  'open',
  'acknowledged',
  'investigating',
  'decided',
  'resolved',
  'closed',
  'declined',
]);
export const concernNoteKindEnum = pgEnum('concern_note_kind', ['note', 'reply', 'decision', 'system']);
export const openDoorBookingStatusEnum = pgEnum('open_door_booking_status', [
  'booked',
  'done',
  'cancelled',
  'no_show',
]);
// A session asked for when no published slot suits (test-pass fix
// 2026-10-22): the host offers a time (→ offered, a booked 1-seat slot) or
// declines; the requester may withdraw while it waits.
export const openDoorRequestStatusEnum = pgEnum('open_door_request_status', [
  'requested',
  'offered',
  'declined',
  'cancelled',
]);

// OPS asset manager (user decisions 2026-10-15). An asset always sits in a
// punch zone; `assigned` means a person also holds it. Scrapped / gifted /
// lost are final. "Off premises" is not a status — it is an approved gate pass.
export const assetStatusEnum = pgEnum('asset_status', [
  'assigned',
  'idle',
  'in_use_shared', // in use at the zone, nobody's (router, printer)
  'needs_repair',
  'scrapped',
  'gifted',
  'lost',
]);

export const assetConditionEnum = pgEnum('asset_condition', [
  'new',
  'good',
  'fair',
  'damaged',
]);

// `lab` categories are lent with a due date (lab equipment, products, samples).
export const assetCategoryKindEnum = pgEnum('asset_category_kind', ['equipment', 'lab']);

// What an employee can ask OPS for. Requests land in the shared OPS queue.
export const assetRequestTypeEnum = pgEnum('asset_request_type', [
  'new',
  'upgrade',
  'replacement',
  'repair',
  'return',
]);

export const assetRequestStatusEnum = pgEnum('asset_request_status', [
  'open',
  'in_progress',
  'fulfilled',
  'declined',
]);

// OPS approval lets the item leave (no separate gate check-out); overdue is
// derived from return_on, never stored.
export const gatePassStatusEnum = pgEnum('gate_pass_status', [
  'requested',
  'approved',
  'declined',
  'returned',
]);

export const assetIncidentKindEnum = pgEnum('asset_incident_kind', [
  'damage',
  'loss',
  'theft',
]);

// Stock ledger rows. Quantities are signed: in / transfer_in add, issue /
// transfer_out subtract, adjust is either way (a recount).
export const stockMovementKindEnum = pgEnum('stock_movement_kind', [
  'in',
  'issue',
  'transfer_out',
  'transfer_in',
  'adjust',
]);

// Exit module (user decisions 2026-10-16): a resignation, or a termination
// HR starts. Relieved = past the last working day, login off; settled = the
// F&F rode a finalized payroll run.
export const exitKindEnum = pgEnum('exit_kind', ['resignation', 'termination']);
export const exitStatusEnum = pgEnum('exit_status', [
  'submitted',
  'accepted',
  'relieved',
  'settled',
  'withdrawn',
  'cancelled',
]);
export const exitClearanceKindEnum = pgEnum('exit_clearance_kind', [
  'hr',
  'manager',
  'ops',
  'payroll',
]);
// Short notice: HR waives it (with a reason) or recovers it on Basic in F&F.
export const noticeShortfallActionEnum = pgEnum('notice_shortfall_action', [
  'waive',
  'recover',
]);
// Termination: serve the notice, or leave earlier with it paid in lieu.
export const terminationModeEnum = pgEnum('termination_mode', ['serve', 'pay_in_lieu']);

// Probation decision (close-out): pending → recommended (by the RM) →
// confirmed (HR, or automatically 7 days after the date) | ended (HR).
export const probationStatusEnum = pgEnum('probation_status', [
  'pending',
  'recommended',
  'confirmed',
  'ended',
]);
export const probationOutcomeEnum = pgEnum('probation_outcome', ['confirm', 'end']);

// Loans & advances (close-out): payroll records them; an advance is a
// one-month loan. Closed = repaid (or settled outside payroll);
// recovered_at_exit = the balance went into the F&F.
export const loanKindEnum = pgEnum('loan_kind', ['loan', 'advance']);
export const loanStatusEnum = pgEnum('loan_status', ['active', 'closed', 'recovered_at_exit']);
export const loanRepaymentKindEnum = pgEnum('loan_repayment_kind', ['emi', 'fnf', 'outside']);

// PIP (close-out): pending_hr → active → passed | not_passed; HR may decline
// (cancelled); extension keeps it active with a later end date.
export const pipStatusEnum = pgEnum('pip_status', [
  'pending_hr',
  'active',
  'passed',
  'not_passed',
  'cancelled',
]);
export const pipCheckinRatingEnum = pgEnum('pip_checkin_rating', [
  'on_track',
  'at_risk',
  'off_track',
]);

// Seats (TA groundwork): positions HR assigns to a person — a relationship,
// never a grant. `dept_head` is per department; `vp_hr_head` is the company-wide VP seat (key kept from before).
// `ta_head` is retired (Admin gives each hiring line to a TA RM instead).
export const seatEnum = pgEnum('seat', ['dept_head', 'vp_hr_head', 'ta_head']);

// TA hiring (Step B). A requisition is one line of a department's quarterly
// hiring plan: draft → submitted → approved | returned (edit = new version)
// → submitted …; cancelled by the head at any point before approval.
export const requisitionStatusEnum = pgEnum('requisition_status', [
  'draft',
  // Submitted by the head, waiting for the quarter's deadline — then all of a
  // quarter's queued lines go to the approvers together.
  'queued',
  'submitted',
  'returned',
  'approved',
  'cancelled',
]);
// The TA doc's five interview rounds; the head picks which apply.
export const interviewRoundEnum = pgEnum('interview_round', [
  'hr',
  'technical',
  'practical',
  'managerial',
  'hr_final',
]);
// Who approves: a hiring line — the HR department's head and the Admin (Owner)
// account; a JD or scorecard — the line's department head and Admin; a hire —
// those plus the line's TA RM. `ta_head` is the retired seat, kept for history.
export const approverRoleEnum = pgEnum('approver_role', [
  'ta_head',
  'hr_head',
  'admin',
  'dept_head',
  'ta_rm',
]);
// What an approval is about — later TA steps add their documents and decisions.
export const approvalSubjectEnum = pgEnum('approval_subject', [
  'requisition',
  'jd',
  'scorecard',
  'hire',
]);
export const approvalDecisionEnum = pgEnum('approval_decision', ['approve', 'reject']);

// TA Step C. A position is one seat of an approved line: it waits for its JD
// and scorecard, then opens for sourcing → interviewing → offer → filled.
export const positionStatusEnum = pgEnum('position_status', [
  'awaiting_docs',
  'open',
  'interviewing',
  'offer',
  'filled',
  'cancelled',
]);
export const taDocumentKindEnum = pgEnum('ta_document_kind', ['jd', 'scorecard']);
// draft → in_review → approved | returned (edit = new version) → in_review …
export const taDocumentStatusEnum = pgEnum('ta_document_status', [
  'draft',
  'in_review',
  'returned',
  'approved',
]);

// TA Step D. Where a candidate came from (jobs are posted by hand; the HRMS
// only records the source).
export const candidateSourceEnum = pgEnum('candidate_source', [
  'naukri',
  'linkedin',
  'internshala',
  'careers_page',
  'agency',
  'campus',
  'social',
  'referral',
  'internal',
  'other',
]);
// A candidate for ONE position: sourced → shortlisted (TA head) → interviewing
// → interviewed (every round scored) → decision (the four approve; Step E) →
// selected → offered → hired. Ends: rejected, withdrawn, offer_declined,
// offer_withdrawn (e.g. failed BGV), no_show (backed out before joining).
export const applicationStageEnum = pgEnum('application_stage', [
  'sourced',
  'shortlisted',
  'interviewing',
  'interviewed',
  'decision',
  'selected',
  'offered',
  'hired',
  'offer_declined',
  'offer_withdrawn',
  'no_show',
  'rejected',
  'withdrawn',
]);
export const interviewRecommendationEnum = pgEnum('interview_recommendation', [
  'hire',
  'no_hire',
]);
// Background verification with the previous employer (TA Step E), in parallel with the offer.
export const bgvStatusEnum = pgEnum('bgv_status', ['not_started', 'in_progress', 'clear', 'failed']);
