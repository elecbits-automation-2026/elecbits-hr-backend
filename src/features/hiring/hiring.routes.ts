import { raw, Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { candidatesController } from './candidates.controller.js';
import {
  addApplicationSchema,
  createCandidateSchema,
  endApplicationSchema,
  endInterviewSlotSchema,
  logActivitySchema,
  nextActionSchema,
  scheduleInterviewSchema,
  updateCandidateSchema,
  submitScoreSchema,
  swapInterviewerSchema,
} from './candidates.schema.js';
import { hireController } from './hire.controller.js';
import {
  addCandidateDocumentSchema,
  endOfferSchema,
  folderLinkSchema,
  markHiredSchema,
  offerDraftSchema,
  returnOfferSchema,
  setCandidateDocumentSchema,
} from './hire.schema.js';
import { hiringController } from './hiring.controller.js';
import { reportsController } from './reports.controller.js';
import {
  addSourceSchema,
  assignPositionSchema,
  assignTaRmSchema,
  createRequisitionSchema,
  decideRequisitionSchema,
  saveJdSchema,
  saveScorecardSchema,
  updateRequisitionSchema,
} from './hiring.schema.js';

/**
 * Hiring (TA Steps B–C) — mounted at /api/v1/hiring. Heads and approvers act
 * through their SEATS (checked in the service); TA's own work is the ta.hiring grant.
 *
 *   GET  /me                          -> 200 HiringMe       departments I head, approver roles,
 *                                                           the quarter being planned + its deadline
 *   GET  /plan?departmentId&quarter   -> 200 HiringPlan     (the department's head)
 *   POST /requisitions                -> 201 Requisition    add a line (head)
 *   PATCH /requisitions/:id           -> 200 Requisition    edit a draft / returned line (head)
 *   POST /requisitions/:id/submit     -> 200 Requisition    draft → queued for the quarter;
 *                                                           returned → straight to approvers (head)
 *   POST /requisitions/:id/unqueue    -> 200 Requisition    queued → draft, before the deadline (head)
 *   POST /requisitions/:id/cancel     -> 200 Requisition    (head)
 *   GET  /approvals                   -> 200 Requisition[]  waiting for my decision
 *   POST /requisitions/:id/decide     -> 200 Requisition    approve / reject (approver)
 *   GET  /requisitions?status         -> 200 Requisition[]  every line (ta.hiring read)
 *   GET  /board                       -> 200 HiringBoard    live lines + their candidates (ta.hiring read)
 *   GET  /report?from&to, /pending-actions (TA); GET /tracker?view=internal|external
 *   GET  /reviews                     -> 200 DocumentReview[]  JDs / scorecards waiting for me
 *   PUT  /positions/:id/jd|scorecard        -> 200 Requisition  write (the position's recruiter)
 *   POST /positions/:id/jd|scorecard/submit -> 200 Requisition  send for review (its recruiter)
 *   POST /documents/:id/decide        -> 200 Requisition    review (line TA RM / dept head)
 *   GET  /ta-rms                      -> 200 TaRmOption[]   Admin: TA-batch holders with reports
 *   POST /requisitions/:id/assign-ta  -> 200 Requisition    Admin gives the line to a TA RM
 *   GET  /recruiters                  -> 200 RecruiterOption[]  my reports in the TA batch
 *   POST /positions/:id/sources       -> 201 Requisition    log an activated sourcing channel
 *   POST /positions/:id/assign        -> 200 Requisition    line's TA RM → a TA-batch report, via a goal
 *   Step D — candidates (ta.hiring): GET/POST /candidates, GET /candidates/match, GET /candidates/:id,
 *     PUT|GET /candidates/:id/cv, GET|POST /positions/:id/applications,
 *     POST /applications/:id/start-interviews (round 1 = screening opens) | informed | reject | withdraw,
 *     PUT /requisitions/:id/rounds/:round/interviewer;
 *   PATCH /candidates/:id (profile), PUT /applications/:id/next-action,
 *     GET|POST /applications/:id/activities (calls, emails… — recruiter / TA RM);
 *   POST /applications/:id/rounds/:round/schedule[/end] (recruiter / TA RM: when + how);
 *   interviewers: GET /interviews/mine, POST /applications/:id/rounds/:round/score
 *   Offer (2026-10-27): GET|POST /applications/:id/documents, PUT …/documents/:docId, PUT …/folder,
 *     PUT …/offer-letter (draft), PUT …/offer-draft, POST …/offer/submit → the HR Head:
 *     GET /offers/pending, PUT …/signed-offer, POST …/offer/approve | …/offer/return;
 *     TA: POST …/offer (share) | offer-declined | withdraw-offer | hire | no-show; HRBP: POST …/joined
 *   (Urgent hiring is offline for now: HR adds the person via HR → People.)
 */
export const hiringRoutes = Router();

hiringRoutes.use(authenticate);

hiringRoutes.get('/me', hiringController.me);
hiringRoutes.get('/plan', hiringController.plan);
hiringRoutes.get('/approvals', hiringController.approvals);
hiringRoutes.get(
  '/requisitions',
  requireAccess('ta.hiring', 'read', { orgOnly: true }),
  hiringController.list,
);
hiringRoutes.get(
  '/board',
  requireAccess('ta.hiring', 'read', { orgOnly: true }),
  hiringController.board,
);
// Reports + trackers (workflow deck slides 13–16).
hiringRoutes.get(
  '/report',
  requireAccess('ta.hiring', 'read', { orgOnly: true }),
  reportsController.report,
);
hiringRoutes.get(
  '/pending-actions',
  requireAccess('ta.hiring', 'read', { orgOnly: true }),
  reportsController.pendingActions,
);
// TA gets either view; a dept head the external view of their departments (service).
hiringRoutes.get('/tracker', reportsController.tracker);
hiringRoutes.post(
  '/requisitions',
  validateBody(createRequisitionSchema),
  hiringController.create,
);
hiringRoutes.patch(
  '/requisitions/:id',
  validateBody(updateRequisitionSchema),
  hiringController.update,
);
hiringRoutes.post('/requisitions/:id/submit', hiringController.submit);
hiringRoutes.post('/requisitions/:id/unqueue', hiringController.unqueue);
hiringRoutes.post('/requisitions/:id/cancel', hiringController.cancel);
hiringRoutes.post(
  '/requisitions/:id/decide',
  validateBody(decideRequisitionSchema),
  hiringController.decide,
);

// ── Step C: JD + scorecard per position (its recruiter writes; TA RM + dept head review) ──
const taWrites = requireAccess('ta.hiring', 'create', { orgOnly: true });
hiringRoutes.get('/reviews', hiringController.reviews);
hiringRoutes.put(
  '/positions/:id/jd',
  taWrites,
  validateBody(saveJdSchema),
  hiringController.saveDocument,
);
hiringRoutes.put(
  '/positions/:id/scorecard',
  taWrites,
  validateBody(saveScorecardSchema),
  hiringController.saveDocument,
);
hiringRoutes.post(
  '/positions/:id/jd/submit',
  taWrites,
  hiringController.submitDocument,
);
hiringRoutes.post(
  '/positions/:id/scorecard/submit',
  taWrites,
  hiringController.submitDocument,
);
hiringRoutes.post(
  '/documents/:id/decide',
  validateBody(decideRequisitionSchema),
  hiringController.decideDocument,
);
// Admin gives an approved line to a TA RM (checked in the service).
hiringRoutes.get('/ta-rms', hiringController.taRms);
hiringRoutes.post(
  '/requisitions/:id/assign-ta',
  validateBody(assignTaRmSchema),
  hiringController.assignTaRm,
);
// Sourcing channels activated for a position (its recruiter / the line's TA RM).
hiringRoutes.post(
  '/positions/:id/sources',
  requireAccess('ta.hiring', 'create', { orgOnly: true }),
  validateBody(addSourceSchema),
  hiringController.addSource,
);
// Who the caller can give a position to (their TA-batch reports; empty for most).
hiringRoutes.get('/recruiters', hiringController.recruiters);
hiringRoutes.post(
  '/positions/:id/assign',
  validateBody(assignPositionSchema),
  hiringController.assignPosition,
);

// ── Step D: candidates, talent pool, applications, interviews ─────────────
const taReads = requireAccess('ta.hiring', 'read', { orgOnly: true });
const taUpdates = requireAccess('ta.hiring', 'update', { orgOnly: true });
hiringRoutes.get('/candidates', taReads, candidatesController.list);
hiringRoutes.get('/candidates/match', taReads, candidatesController.matches);
hiringRoutes.get('/candidates/:id', taReads, candidatesController.get);
hiringRoutes.post(
  '/candidates',
  taWrites,
  validateBody(createCandidateSchema),
  candidatesController.create,
);
hiringRoutes.patch(
  '/candidates/:id',
  requireAccess('ta.hiring', 'update', { orgOnly: true }),
  validateBody(updateCandidateSchema),
  candidatesController.update,
);
// Live progress on an application: next action + contacts (recruiter / TA RM).
hiringRoutes.put(
  '/applications/:id/next-action',
  requireAccess('ta.hiring', 'update', { orgOnly: true }),
  validateBody(nextActionSchema),
  candidatesController.setNextAction,
);
hiringRoutes.get(
  '/applications/:id/activities',
  requireAccess('ta.hiring', 'read', { orgOnly: true }),
  candidatesController.activities,
);
hiringRoutes.post(
  '/applications/:id/activities',
  requireAccess('ta.hiring', 'update', { orgOnly: true }),
  validateBody(logActivitySchema),
  candidatesController.logActivity,
);
// The CV: raw file body, like leave certificates. Opening it is TA or the
// candidate's interviewers (checked in the service).
hiringRoutes.put(
  '/candidates/:id/cv',
  taWrites,
  raw({ type: () => true, limit: '10mb' }),
  candidatesController.uploadCv,
);
hiringRoutes.get('/candidates/:id/cv', candidatesController.cv);
hiringRoutes.get('/positions/:id/applications', taReads, candidatesController.pipeline);
hiringRoutes.post(
  '/positions/:id/applications',
  taWrites,
  validateBody(addApplicationSchema),
  candidatesController.apply,
);
// Shortlist validation is the line's TA RM's (checked in the service).
hiringRoutes.post(
  '/applications/:id/informed',
  requireAccess('ta.hiring', 'update', { orgOnly: true }),
  candidatesController.informed,
);
hiringRoutes.post(
  '/applications/:id/start-interviews',
  taUpdates,
  candidatesController.startInterviews,
);
hiringRoutes.post(
  '/applications/:id/reject',
  taUpdates,
  validateBody(endApplicationSchema),
  candidatesController.reject,
);
hiringRoutes.post(
  '/applications/:id/withdraw',
  taUpdates,
  validateBody(endApplicationSchema),
  candidatesController.withdraw,
);
hiringRoutes.put(
  '/requisitions/:id/rounds/:round/interviewer',
  taUpdates,
  validateBody(swapInterviewerSchema),
  candidatesController.swapInterviewer,
);
// The position's recruiter / line's TA RM schedules each round (checked in the service).
hiringRoutes.post(
  '/applications/:id/rounds/:round/schedule',
  taUpdates,
  validateBody(scheduleInterviewSchema),
  candidatesController.schedule,
);
hiringRoutes.post(
  '/applications/:id/rounds/:round/schedule/end',
  taUpdates,
  validateBody(endInterviewSlotSchema),
  candidatesController.endSlot,
);
// Scoring is the round's interviewer's (a relationship, checked in the service).
hiringRoutes.get('/interviews/mine', candidatesController.myInterviews);
hiringRoutes.post(
  '/applications/:id/rounds/:round/score',
  validateBody(submitScoreSchema),
  candidatesController.score,
);

// ── Documents, HR Head-approved offer, hire, joining (2026-10-27) ──────────
hiringRoutes.get('/applications/:id/documents', taReads, hireController.documents);
hiringRoutes.post(
  '/applications/:id/documents',
  taUpdates,
  validateBody(addCandidateDocumentSchema),
  hireController.addDocument,
);
hiringRoutes.put(
  '/applications/:id/documents/:docId',
  taUpdates,
  validateBody(setCandidateDocumentSchema),
  hireController.setDocument,
);
hiringRoutes.put(
  '/applications/:id/folder',
  taUpdates,
  validateBody(folderLinkSchema),
  hireController.setFolder,
);
hiringRoutes.put(
  '/applications/:id/offer-letter',
  taWrites,
  raw({ type: () => true, limit: '10mb' }),
  hireController.uploadOfferLetter,
);
// The HR Head (not necessarily TA) reads both letters while approving — checked in the service.
hiringRoutes.get('/applications/:id/offer-letter', hireController.offerLetter);
hiringRoutes.put(
  '/applications/:id/offer-draft',
  taUpdates,
  validateBody(offerDraftSchema),
  hireController.saveOfferDraft,
);
hiringRoutes.post('/applications/:id/offer/submit', taUpdates, hireController.submitOffer);
// The HR Head approves and signs (a relationship — the hiring HR department's head).
hiringRoutes.get('/offers/pending', hireController.pendingOffers);
hiringRoutes.put(
  '/applications/:id/signed-offer',
  raw({ type: () => true, limit: '10mb' }),
  hireController.uploadSignedLetter,
);
hiringRoutes.get('/applications/:id/signed-offer', hireController.signedLetter);
hiringRoutes.post('/applications/:id/offer/approve', hireController.approveOffer);
hiringRoutes.post(
  '/applications/:id/offer/return',
  validateBody(returnOfferSchema),
  hireController.returnOffer,
);
hiringRoutes.post('/applications/:id/offer', taUpdates, hireController.shareOffer);
hiringRoutes.post(
  '/applications/:id/offer-declined',
  taUpdates,
  validateBody(endOfferSchema),
  hireController.declined,
);
hiringRoutes.post(
  '/applications/:id/withdraw-offer',
  taUpdates,
  validateBody(endOfferSchema),
  hireController.withdrawOffer,
);
hiringRoutes.post(
  '/applications/:id/hire',
  taUpdates,
  validateBody(markHiredSchema),
  hireController.markHired,
);
// HRBP confirms the actual joining (checked in the service).
hiringRoutes.post('/applications/:id/joined', hireController.confirmJoined);
hiringRoutes.post(
  '/applications/:id/no-show',
  taUpdates,
  validateBody(endOfferSchema),
  hireController.noShow,
);
