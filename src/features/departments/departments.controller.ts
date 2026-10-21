import type { Request, Response } from 'express';
import { createDepartmentsRepository } from './departments.repository.js';
import type { CreateDepartmentInput } from './departments.schema.js';
import { createDepartmentsService } from './departments.service.js';

const service = (req: Request) =>
  createDepartmentsService({ repo: createDepartmentsRepository(req.db) });

export const departmentsController = {
  list: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).list());
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateDepartmentInput = req.body;
    const department = await service(req).create(input);
    req.log.info({ departmentId: department.id }, 'department created');
    res.status(201).json(department);
  },
};
