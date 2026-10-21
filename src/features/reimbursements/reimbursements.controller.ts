import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createReimbursementsRepository } from './reimbursements.repository.js';
import type {
  CreateClaimInput,
  DecideClaimInput,
  ReimbursementClaimDto,
} from './reimbursements.schema.js';
import { createReimbursementsService } from './reimbursements.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createReimbursementsService({
    repo: createReimbursementsRepository(req.db),
    authz: createAuthzRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

const requireId = (req: Request): string => {
  const { id } = req.params;
  if (!isUuid(id)) throw createError(400, 'Invalid claim id');
  return id;
};

const STATUSES = new Set<ReimbursementClaimDto['status']>([
  'pending_rm',
  'pending_payroll',
  'approved',
  'paid',
  'declined',
  'cancelled',
]);

/** HTTP layer only: read validated input, call the service, shape the response. */
export const reimbursementsController = {
  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(req.auth!.employeeId));
  },

  team: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).forRm(req.auth!.employeeId));
  },

  queue: async (req: Request, res: Response): Promise<void> => {
    const raw = typeof req.query.status === 'string' ? req.query.status.split(',') : [];
    const statuses = raw.filter((s): s is ReimbursementClaimDto['status'] =>
      STATUSES.has(s as ReimbursementClaimDto['status']),
    );
    res.json(await service(req).queue(statuses));
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateClaimInput = req.body;
    const claim = await service(req).create(input, actor(req));
    req.log.info({ claim: claim.id, status: claim.status }, 'reimbursement claimed');
    res.status(201).json(claim);
  },

  decide: async (req: Request, res: Response): Promise<void> => {
    const input: DecideClaimInput = req.body;
    const claim = await service(req).decide(requireId(req), input, actor(req));
    req.log.info({ claim: claim.id, status: claim.status }, 'reimbursement decided');
    res.json(claim);
  },

  cancel: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).cancel(requireId(req), actor(req)));
  },

  uploadReceipt: async (req: Request, res: Response): Promise<void> => {
    const id = requireId(req);
    if (!Buffer.isBuffer(req.body))
      throw createError(400, 'Send the file as the request body');
    const fileName = String(req.query.filename ?? 'receipt').slice(0, 200);
    const out = await service(req).uploadReceipt(
      id,
      { fileName, contentType: req.headers['content-type'] ?? '', data: req.body },
      actor(req),
    );
    req.log.info({ claim: id, bytes: req.body.length }, 'claim receipt stored');
    res.json(out);
  },

  receipt: async (req: Request, res: Response): Promise<void> => {
    const file = await service(req).receipt(requireId(req), req.auth!.employeeId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${file.fileName.replaceAll('"', '')}"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.data);
  },
};
