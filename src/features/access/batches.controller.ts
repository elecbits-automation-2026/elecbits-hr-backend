import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createBatchesRepository } from './batches.repository.js';
import type { AssignBatchInput, UpsertBatchInput } from './batches.schema.js';
import { createBatchesService } from './batches.service.js';

const service = (req: Request) =>
  createBatchesService({ repo: createBatchesRepository(req.db) });

export const batchesController = {
  list: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).list());
  },

  modules: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).modules());
  },

  create: async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw createError(401, 'Authentication required');
    const input: UpsertBatchInput = req.body;
    const batch = await service(req).create(input, {
      actorUserId: req.auth.userId,
      actorEmployeeId: req.auth.employeeId,
    });
    req.log.info({ batchId: batch.id, name: batch.name }, 'batch created');
    res.status(201).json(batch);
  },

  update: async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw createError(401, 'Authentication required');
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid batch id');
    const input: UpsertBatchInput = req.body;
    const batch = await service(req).update(id, input, {
      actorUserId: req.auth.userId,
      actorEmployeeId: req.auth.employeeId,
    });
    // Edits apply live to every holder — worth a log line beside the audit row (§10).
    req.log.info({ batchId: id, grants: input.grants.length }, 'batch updated');
    res.json(batch);
  },

  holders: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid batch id');
    res.json(await service(req).holders(id));
  },

  assign: async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw createError(401, 'Authentication required');
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid batch id');
    const { employeeId }: AssignBatchInput = req.body;
    await service(req).assign(id, employeeId, {
      actorUserId: req.auth.userId,
      actorEmployeeId: req.auth.employeeId,
    });
    // Access changes are the audit log's reason to exist (§10).
    req.log.info({ batchId: id, employeeId, by: req.auth.employeeId }, 'batch assigned');
    res.status(204).end();
  },

  revoke: async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw createError(401, 'Authentication required');
    const { id, employeeId } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid batch id');
    if (!isUuid(employeeId)) throw createError(400, 'Invalid employee id');
    await service(req).revoke(id, employeeId, {
      actorUserId: req.auth.userId,
      actorEmployeeId: req.auth.employeeId,
    });
    req.log.info({ batchId: id, employeeId, by: req.auth.employeeId }, 'batch revoked');
    res.status(204).end();
  },
};
