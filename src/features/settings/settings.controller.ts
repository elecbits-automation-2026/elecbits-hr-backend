import type { Request, Response } from 'express';
import createError from 'http-errors';
import { createAuthzRepository } from '../access/authz.repository.js';
import { isSettingArea } from './settings.registry.js';
import { createSettingsRepository } from './settings.repository.js';
import type { UpdateSettingInput } from './settings.schema.js';
import { createSettingsService } from './settings.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createSettingsService({
    repo: createSettingsRepository(req.db),
    authz: createAuthzRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

/** HTTP layer only: read validated input, call the service, shape the response. */
export const settingsController = {
  list: async (req: Request, res: Response): Promise<void> => {
    const raw = req.query.area === undefined ? undefined : String(req.query.area);
    if (raw !== undefined && !isSettingArea(raw)) {
      throw createError(400, 'Unknown settings area', { code: 'INVALID_AREA' });
    }
    res.json(await service(req).list(req.auth!.employeeId, raw));
  },

  publicValues: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).publicValues());
  },

  update: async (req: Request, res: Response): Promise<void> => {
    const input: UpdateSettingInput = req.body;
    const setting = await service(req).update(req.params.key, input.value, actor(req));
    req.log.info({ key: setting.key }, 'org setting updated');
    res.json(setting);
  },
};
