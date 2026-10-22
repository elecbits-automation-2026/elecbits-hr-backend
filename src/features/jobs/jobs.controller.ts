import { pipServiceFor } from '../pip/index.js';
import { probationServiceFor } from '../probation/index.js';
import {
  createExitsFnf,
  createExitsRepository,
  createExitsService,
} from '../exits/index.js';
import { createOpsCustodyReader } from '../ops/index.js';
import { openDoorServiceFor } from '../open-door/index.js';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createConcernsRepository, createConcernsService } from '../concerns/index.js';
import { createSettingsRepository } from '../settings/index.js';
import { createJobsRepository } from './jobs.repository.js';
import { createJobsService } from './jobs.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createJobsService({
    repo: createJobsRepository(req.db),
    authz: createAuthzRepository(req.db),
    settings: createSettingsRepository(req.db),
    exits: createExitsService({
      repo: createExitsRepository(req.db),
      authz: createAuthzRepository(req.db),
      custody: createOpsCustodyReader(req.db),
      fnf: createExitsFnf(req.db),
      settings: createSettingsRepository(req.db),
    }),
    probation: probationServiceFor(req.db),
    pip: pipServiceFor(req.db),
    openDoor: openDoorServiceFor(req.db),
    concerns: createConcernsService({
      repo: createConcernsRepository(req.db),
      authz: createAuthzRepository(req.db),
      settings: createSettingsRepository(req.db),
    }),
  });

/** HTTP layer only: read input, call the service, shape the response. */
export const jobsController = {
  overview: async (req: Request, res: Response): Promise<void> => {
    const svc = service(req);
    res.json({
      schedulerEnabled: env.scheduler.enabled,
      jobs: svc.jobs(),
      runs: await svc.runs(),
    });
  },

  runNow: async (req: Request, res: Response): Promise<void> => {
    const run = await service(req).runNow(req.params.name!);
    req.log.info(
      { job: run.job, status: run.status, summary: run.summary },
      'job run by hand',
    );
    res.json(run);
  },
};
