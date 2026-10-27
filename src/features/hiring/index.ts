/** Public surface of the hiring (TA) module. */
export { hiringRoutes } from './hiring.routes.js';
export { registerHiringDocs } from './hiring.docs.js';
export { registerCandidatesDocs } from './candidates.docs.js';
export { registerHireDocs } from './hire.docs.js';
export { registerReportsDocs } from './reports.docs.js';
export type { HiringMeDto, HiringPlanDto, RequisitionDto } from './hiring.schema.js';

import type { DbClient } from '../../db/client.js';
import { createSettingsRepository } from '../settings/index.js';
import { createHiringRepository } from './hiring.repository.js';
import { createHiringJobsRepository } from './hiringJobs.repository.js';
import { createHiringJobsService } from './hiringJobs.service.js';
export type { HiringJobsService } from './hiringJobs.service.js';

/** The hiring scheduled jobs on a DbClient (scheduler + "run now"). */
export const hiringJobsFor = (db: DbClient) =>
  createHiringJobsService({
    repo: createHiringJobsRepository(db),
    hiring: createHiringRepository(db),
    settings: createSettingsRepository(db),
  });
