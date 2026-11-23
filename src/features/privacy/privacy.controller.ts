import type { Request, Response } from 'express';
import type { DbClient } from '../../db/client.js';
import { createSettingsRepository } from '../settings/index.js';
import { createPrivacyRepository } from './privacy.repository.js';
import type { AcceptPrivacyInput } from './privacy.schema.js';
import { createPrivacyService } from './privacy.service.js';

/** Composition root — also used by other features to audit sensitive reads, and by the jobs. */
export const privacyServiceFor = (db: DbClient) =>
  createPrivacyService({
    repo: createPrivacyRepository(db),
    settings: createSettingsRepository(db),
  });

/** HTTP layer only: read input, call the service, shape the response. */
export const privacyController = {
  status: async (req: Request, res: Response): Promise<void> => {
    res.json(await privacyServiceFor(req.db).status(req.auth!.employeeId));
  },

  accept: async (req: Request, res: Response): Promise<void> => {
    const input: AcceptPrivacyInput = req.body;
    const result = await privacyServiceFor(req.db).accept(
      req.auth!.employeeId,
      input.version,
      req.auth!.userId,
    );
    req.log.info({ version: input.version }, 'privacy notice accepted');
    res.json(result);
  },

  exportMine: async (req: Request, res: Response): Promise<void> => {
    const data = await privacyServiceFor(req.db).exportMine(req.auth!.employeeId);
    req.log.info({ employeeId: req.auth!.employeeId }, 'personal data exported');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="my-elecbits-hr-data-${data.exportedAt.slice(0, 10)}.json"`,
    );
    res.json(data);
  },

  retentionPreview: async (req: Request, res: Response): Promise<void> => {
    res.json(await privacyServiceFor(req.db).retentionPreview());
  },
};
