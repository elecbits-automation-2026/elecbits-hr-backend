import type { Request, Response } from 'express';
import createError from 'http-errors';
import { createHiringRepository, type RequisitionStatus } from './hiring.repository.js';
import {
  REQUISITION_STATUSES,
  type CreateRequisitionInput,
  type DecideRequisitionInput,
  type AssignPositionInput,
  type AssignTaRmInput,
  type JdContent,
  type ScorecardContent,
  type UpdateRequisitionInput,
} from './hiring.schema.js';
import { createHiringService } from './hiring.service.js';
import { createSettingsRepository } from '../settings/index.js';

const service = (req: Request) =>
  createHiringService({
    repo: createHiringRepository(req.db),
    settings: createSettingsRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

const QUARTER = /^\d{4}-Q[1-4]$/;

/** The route says which document: /requisitions/:id/jd or /requisitions/:id/scorecard. */
const docKind = (req: Request): 'jd' | 'scorecard' =>
  req.path.includes('/scorecard') ? 'scorecard' : 'jd';

export const hiringController = {
  me: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).me(req.auth!.employeeId));
  },

  plan: async (req: Request, res: Response): Promise<void> => {
    const departmentId = String(req.query.departmentId ?? '');
    const quarter = String(req.query.quarter ?? '');
    if (!departmentId || !QUARTER.test(quarter)) {
      throw createError(400, 'departmentId and quarter (e.g. 2026-Q4) are required', {
        code: 'INVALID_QUERY',
      });
    }
    res.json(await service(req).plan(req.auth!.employeeId, departmentId, quarter));
  },

  list: async (req: Request, res: Response): Promise<void> => {
    const raw = req.query.status === undefined ? undefined : String(req.query.status);
    if (raw !== undefined && !(REQUISITION_STATUSES as readonly string[]).includes(raw)) {
      throw createError(400, 'Unknown status', { code: 'INVALID_STATUS' });
    }
    res.json(await service(req).list(raw as RequisitionStatus | undefined));
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateRequisitionInput = req.body;
    const r = await service(req).create(input, actor(req));
    req.log.info({ requisitionId: r.id }, 'requisition created');
    res.status(201).json(r);
  },

  update: async (req: Request, res: Response): Promise<void> => {
    const input: UpdateRequisitionInput = req.body;
    res.json(await service(req).update(req.params.id, input, actor(req)));
  },

  submit: async (req: Request, res: Response): Promise<void> => {
    const r = await service(req).submit(req.params.id, actor(req));
    req.log.info({ requisitionId: r.id, version: r.version }, 'requisition submitted');
    res.json(r);
  },

  unqueue: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).unqueue(req.params.id, actor(req)));
  },

  cancel: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).cancel(req.params.id, actor(req)));
  },

  approvals: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).approvals(req.auth!.employeeId));
  },

  decide: async (req: Request, res: Response): Promise<void> => {
    const input: DecideRequisitionInput = req.body;
    const r = await service(req).decide(req.params.id, input, actor(req));
    req.log.info(
      { requisitionId: r.id, decision: input.decision },
      'requisition decided',
    );
    res.json(r);
  },

  // ── Step C ──────────────────────────────────────────────────────────────

  saveDocument: async (req: Request, res: Response): Promise<void> => {
    const kind = docKind(req);
    const input: { content: JdContent | ScorecardContent } = req.body;
    res.json(
      await service(req).saveDocument(req.params.id, kind, input.content, actor(req)),
    );
  },

  submitDocument: async (req: Request, res: Response): Promise<void> => {
    const r = await service(req).submitDocument(req.params.id, docKind(req), actor(req));
    req.log.info({ requisitionId: r.id, kind: docKind(req) }, 'ta document submitted');
    res.json(r);
  },

  reviews: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).reviews(req.auth!.employeeId));
  },

  decideDocument: async (req: Request, res: Response): Promise<void> => {
    const input: DecideRequisitionInput = req.body;
    const r = await service(req).decideDocument(req.params.id, input, actor(req));
    req.log.info(
      { documentId: req.params.id, decision: input.decision },
      'ta document decided',
    );
    res.json(r);
  },

  taRms: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).taRms(actor(req)));
  },

  assignTaRm: async (req: Request, res: Response): Promise<void> => {
    const input: AssignTaRmInput = req.body;
    const r = await service(req).assignTaRm(req.params.id, input, actor(req));
    req.log.info({ requisitionId: req.params.id }, 'line given to a TA RM');
    res.json(r);
  },

  assignPosition: async (req: Request, res: Response): Promise<void> => {
    const input: AssignPositionInput = req.body;
    const r = await service(req).assignPosition(req.params.id, input, actor(req));
    req.log.info({ positionId: req.params.id }, 'position assigned');
    res.json(r);
  },
};
