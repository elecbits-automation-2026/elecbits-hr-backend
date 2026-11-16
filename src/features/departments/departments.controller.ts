import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createSeatsRepository, createSeatsService } from '../seats/index.js';
import { createSettingsRepository } from '../settings/index.js';
import { createDepartmentsRepository } from './departments.repository.js';
import type {
  AddMemberInput,
  CreateDepartmentInput,
  SetHeadInput,
  SetLeadInput,
  UpdateDepartmentInput,
} from './departments.schema.js';
import { createDepartmentsService } from './departments.service.js';

const service = (req: Request) =>
  createDepartmentsService({
    repo: createDepartmentsRepository(req.db),
    seats: createSeatsService({ repo: createSeatsRepository(req.db) }),
    settings: createSettingsRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

const idParam = (req: Request, name = 'id'): string => {
  const id = req.params[name];
  if (!isUuid(id)) throw createError(400, 'Invalid id');
  return id;
};

export const departmentsController = {
  list: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).list());
  },

  memberships: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).memberships());
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateDepartmentInput = req.body;
    const department = await service(req).create(input, actor(req));
    req.log.info({ departmentId: department.id }, 'department created');
    res.status(201).json(department);
  },

  update: async (req: Request, res: Response): Promise<void> => {
    const input: UpdateDepartmentInput = req.body;
    const department = await service(req).update(idParam(req), input, actor(req));
    req.log.info({ departmentId: department.id }, 'department updated');
    res.json(department);
  },

  setHead: async (req: Request, res: Response): Promise<void> => {
    const input: SetHeadInput = req.body;
    const department = await service(req).setHead(idParam(req), input, actor(req));
    req.log.info({ departmentId: department.id }, 'department head set');
    res.json(department);
  },

  clearHead: async (req: Request, res: Response): Promise<void> => {
    const department = await service(req).clearHead(idParam(req), actor(req));
    req.log.info({ departmentId: department.id }, 'department head cleared');
    res.json(department);
  },

  addMember: async (req: Request, res: Response): Promise<void> => {
    const input: AddMemberInput = req.body;
    res.status(201).json(await service(req).addMember(idParam(req), input, actor(req)));
  },

  removeMember: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).removeMember(idParam(req, 'membershipId'), actor(req)));
  },

  setLead: async (req: Request, res: Response): Promise<void> => {
    const input: SetLeadInput = req.body;
    res.json(await service(req).setLead(idParam(req), input, actor(req)));
  },
};
