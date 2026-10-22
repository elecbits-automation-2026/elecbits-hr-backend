import { pipServiceFor } from '../features/pip/index.js';
import { probationServiceFor } from '../features/probation/index.js';
import {
  createExitsFnf,
  createExitsRepository,
  createExitsService,
} from '../features/exits/index.js';
import { createOpsCustodyReader } from '../features/ops/index.js';
import { openDoorServiceFor } from '../features/open-door/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { createAuthzRepository } from '../features/access/authz.repository.js';
import {
  createConcernsRepository,
  createConcernsService,
} from '../features/concerns/index.js';
import { createJobsRepository, createJobsService } from '../features/jobs/index.js';
import { createSettingsRepository } from '../features/settings/index.js';

/** How often the scheduler asks the jobs whether they are due. */
const TICK_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;
let busy = false;

const service = () =>
  createJobsService({
    repo: createJobsRepository(db),
    authz: createAuthzRepository(db),
    settings: createSettingsRepository(db),
    exits: createExitsService({
      repo: createExitsRepository(db),
      authz: createAuthzRepository(db),
      custody: createOpsCustodyReader(db),
      fnf: createExitsFnf(db),
      settings: createSettingsRepository(db),
    }),
    probation: probationServiceFor(db),
    pip: pipServiceFor(db),
    openDoor: openDoorServiceFor(db),
    concerns: createConcernsService({
      repo: createConcernsRepository(db),
      authz: createAuthzRepository(db),
      settings: createSettingsRepository(db),
    }),
  });

/** One tick; never overlaps itself and never throws into the timer. */
const tick = async (): Promise<void> => {
  if (busy) return;
  busy = true;
  try {
    const ran = await service().tick();
    if (ran.length > 0) logger.info({ jobs: ran }, 'scheduled jobs ran');
  } catch (err) {
    logger.error({ err }, 'scheduler tick failed');
  } finally {
    busy = false;
  }
};

/**
 * In-process scheduler (end-of-pass). It lives in the API process: no extra
 * service to deploy. Every tick asks the jobs whether they are due; the
 * job-run table (ops.scheduled_job_runs, unique job + run key) makes each run
 * happen once even with several instances. Off with SCHEDULER_ENABLED=false.
 */
export const startScheduler = (): void => {
  if (!env.scheduler.enabled) {
    logger.info('scheduler disabled (SCHEDULER_ENABLED=false)');
    return;
  }
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  // A first look shortly after boot, so a run missed while down happens now.
  setTimeout(() => void tick(), 15_000).unref();
  logger.info(
    { dailyAt: env.scheduler.dailyAt, tickMinutes: TICK_MS / 60_000 },
    'scheduler started',
  );
};

export const stopScheduler = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};
