import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createPoliciesRepository } from './policies.repository.js';
import type { CreatePolicyInput, UpdatePolicyInput } from './policies.schema.js';
import { createPoliciesService } from './policies.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createPoliciesService({ repo: createPoliciesRepository(req.db) });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

/** HTTP layer only: read validated input, call the service, shape the response. */
export const policiesController = {
  list: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).list());
  },

  listForManagement: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).listForManagement());
  },

  retire: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid policy id');
    const policy = await service(req).retire(id, actor(req));
    req.log.info({ code: policy.code }, 'policy retired');
    res.json(policy);
  },

  restore: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid policy id');
    const policy = await service(req).restore(id, actor(req));
    req.log.info({ code: policy.code }, 'policy restored');
    res.json(policy);
  },

  mine: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).mine(req.auth!.employeeId));
  },

  acknowledge: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid policy id');
    const ack = await service(req).acknowledge(id, actor(req));
    req.log.info({ policyId: id, version: ack.version }, 'policy acknowledged');
    res.status(201).json(ack);
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreatePolicyInput = req.body;
    const policy = await service(req).create(input, actor(req));
    req.log.info({ code: policy.code, version: policy.version }, 'policy created');
    res.status(201).json(policy);
  },

  update: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid policy id');
    const input: UpdatePolicyInput = req.body;
    res.json(await service(req).update(id, input, actor(req)));
  },

  tracker: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).tracker());
  },

  document: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid policy id');
    const doc = await service(req).document(id);
    res.setHeader('Content-Type', doc.contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${doc.fileName.replaceAll('"', '')}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(doc.data);
  },

  uploadDocument: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid policy id');
    const fileName = String(req.query.filename ?? 'policy.pdf').slice(0, 200);
    const contentType = req.headers['content-type'] ?? 'application/pdf';
    if (!Buffer.isBuffer(req.body)) {
      throw createError(422, 'Send the file as the raw request body', {
        code: 'NOT_A_FILE',
      });
    }
    const policy = await service(req).uploadDocument(
      id,
      { fileName, contentType, data: req.body },
      actor(req),
    );
    req.log.info(
      { policyId: id, fileName, bytes: req.body.length },
      'policy document stored',
    );
    res.json(policy);
  },
};
