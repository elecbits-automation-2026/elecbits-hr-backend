import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { settingsController } from './settings.controller.js';
import { updateSettingSchema } from './settings.schema.js';

/**
 * Org settings — mounted at /api/v1/settings. Each key belongs to an area;
 * access.settings opens every area and the area's owning module opens its own
 * (payroll -> pr.payroll, attendance -> hrbp.attendance, ...). The gate is
 * per key, so it lives in the service, not in requireAccess.
 *
 *   GET /          -> 200 OrgSetting[]  (readable keys only; ?area= filter)
 *   GET /public    -> 200 { key: value } (public keys, any signed-in user)
 *   PUT /:key      -> 200 OrgSetting    (area update right; value validated
 *                                        against the key's registry schema)
 */
export const settingsRoutes = Router();

settingsRoutes.use(authenticate);

settingsRoutes.get('/', settingsController.list);
settingsRoutes.get('/public', settingsController.publicValues);
settingsRoutes.put('/:key', validateBody(updateSettingSchema), settingsController.update);
