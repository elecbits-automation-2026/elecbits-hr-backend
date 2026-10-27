import { raw, Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { candidatesController } from './candidates.controller.js';
import {
  addApplicationSchema,
  createCandidateSchema,
  endApplicationSchema,
  submitScoreSchema,
  swapInterviewerSchema,
} from './candidates.schema.js';
import { hireController } from './hire.controller.js';
import {
  bgvSchema,
  decideHireSchema,
  endOfferSchema,
  makeOfferSchema,
  markHiredSchema,
} from './hire.schema.js';
import { hiringController } from './hiring.controller.js';
import {
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
 *   GET  /reviews                     -> 200 DocumentReview[]  JDs / scorecards waiting for me
 *   PUT  /requisitions/:id/jd|scorecard        -> 200 Requisition  write (ta.hiring create)
 *   POST /requisitions/:id/jd|scorecard/submit -> 200 Requisition  send for review (ta.hiring create)
 *   POST /documents/:id/decide        -> 200 Requisition    review (dept head / Admin)
 *   GET  /ta-rms                      -> 200 TaRmOption[]   Admin: TA-batch holders with reports
 *   POST /requisitions/:id/assign-ta  -> 200 Requisition    Admin gives the line to a TA RM
 *   POST /positions/:id/assign        -> 200 Requisition    line's TA RM → a direct report, via a goal
 *   Step D — candidates (ta.hiring): GET/POST /candidates, GET /candidates/match, GET /candidates/:id,
 *     PUT|GET /candidates/:id/cv, GET|POST /positions/:id/applications,
 *     POST /applications/:id/shortlist (line's TA RM) | start-interviews | reject | withdraw,
 *     PUT /requisitions/:id/rounds/:round/interviewer;
 *   interviewers: GET /interviews/mine, POST /applications/:id/rounds/:round/score
 *   Step E — POST /applications/:id/send-for-decision; deciders: GET /decisions,
 *     POST /applications/:id/decide; TA: PUT|GET /applications/:id/offer-letter,
 *     POST /applications/:id/offer | bgv | offer-declined | withdraw-offer | hire | no-show
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

// ── Step C: JD + scorecard (TA writes; dept head + Admin review), positions ──
const taWrites = requireAccess('ta.hiring', 'create', { orgOnly: true });
hiringRoutes.get('/reviews', hiringController.reviews);
hiringRoutes.put(
  '/requisitions/:id/jd',
  taWrites,
  validateBody(saveJdSchema),
  hiringController.saveDocument,
);
hiringRoutes.put(
  '/requisitions/:id/scorecard',
  taWrites,
  validateBody(saveScorecardSchema),
  hiringController.saveDocument,
);
hiringRoutes.post(
  '/requisitions/:id/jd/submit',
  taWrites,
  hiringController.submitDocument,
);
hiringRoutes.post(
  '/requisitions/:id/scorecard/submit',
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
hiringRoutes.post('/applications/:id/shortlist', candidatesController.shortlist);
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
// Scoring is the round's interviewer's (a relationship, checked in the service).
hiringRoutes.get('/interviews/mine', candidatesController.myInterviews);
hiringRoutes.post(
  '/applications/:id/rounds/:round/score',
  validateBody(submitScoreSchema),
  candidatesController.score,
);

// ── Step E: final decision, offer, BGV, hire ──────────────────────────────
hiringRoutes.post(
  '/applications/:id/send-for-decision',
  taUpdates,
  hireController.sendForDecision,
);
// The four deciders act through seats / the Admin account (checked in the service).
hiringRoutes.get('/decisions', hireController.pendingDecisions);
hiringRoutes.post(
  '/applications/:id/decide',
  validateBody(decideHireSchema),
  hireController.decide,
);
hiringRoutes.put(
  '/applications/:id/offer-letter',
  taWrites,
  raw({ type: () => true, limit: '10mb' }),
  hireController.uploadOfferLetter,
);
hiringRoutes.get('/applications/:id/offer-letter', taReads, hireController.offerLetter);
hiringRoutes.post(
  '/applications/:id/offer',
  taUpdates,
  validateBody(makeOfferSchema),
  hireController.makeOffer,
);
hiringRoutes.post(
  '/applications/:id/bgv',
  taUpdates,
  validateBody(bgvSchema),
  hireController.setBgv,
);
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
hiringRoutes.post(
  '/applications/:id/no-show',
  taUpdates,
  validateBody(endOfferSchema),
  hireController.noShow,
);
