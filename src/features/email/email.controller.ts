import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import type { DbClient } from '../../db/client.js';
import { createSettingsRepository } from '../settings/index.js';
import { driverFor } from './email.drivers.js';
import { createEmailRepository } from './email.repository.js';
import { createEmailService } from './email.service.js';

/** Composition root — also used by the scheduler's outbox sender. */
export const emailServiceFor = (db: DbClient) =>
  createEmailService({
    repo: createEmailRepository(db),
    settings: createSettingsRepository(db),
    driver: () => driverFor(env.email),
    config: env.email,
    appUrl: env.appUrl,
  });

/** HTTP layer only: read input, call the service, shape the response. */
export const emailController = {
  status: async (req: Request, res: Response): Promise<void> => {
    res.json(await emailServiceFor(req.db).status());
  },

  retryFailed: async (req: Request, res: Response): Promise<void> => {
    const result = await emailServiceFor(req.db).retryFailed();
    req.log.info(result, 'failed emails re-queued');
    res.json(result);
  },

  test: async (req: Request, res: Response): Promise<void> => {
    const result = await emailServiceFor(req.db).sendTest(req.auth!.employeeId);
    req.log.info({ driver: result.driver }, 'test email sent');
    res.json(result);
  },
};
