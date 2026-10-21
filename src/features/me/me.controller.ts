import type { Request, Response } from 'express';
import createError from 'http-errors';
import { createMeRepository } from './me.repository.js';
import type { UpdateMeInput } from './me.schema.js';
import { createMeService } from './me.service.js';

const service = (req: Request) => createMeService({ repo: createMeRepository(req.db) });

export const meController = {
  getMe: async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw createError(401, 'Authentication required');
    res.json(await service(req).getMe(req.auth.employeeId));
  },

  updateMe: async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw createError(401, 'Authentication required');
    const input: UpdateMeInput = req.body;
    const me = await service(req).updateMe(req.auth.employeeId, req.auth.userId, input);
    req.log.info({ employeeId: req.auth.employeeId }, 'profile updated');
    res.json(me);
  },

  getMySalary: async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw createError(401, 'Authentication required');
    res.json(await service(req).getMySalary(req.auth.employeeId));
  },

  getMyAssets: async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw createError(401, 'Authentication required');
    res.json(await service(req).getMyAssets(req.auth.employeeId));
  },

  getMyExit: async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw createError(401, 'Authentication required');
    res.json(await service(req).getMyExit(req.auth.employeeId));
  },

  getTeam: async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw createError(401, 'Authentication required');
    res.json(await service(req).getTeam(req.auth.employeeId));
  },
};
