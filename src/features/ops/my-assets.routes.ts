import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validateBody } from '../../middleware/validateBody.js';
import { reportIncidentSchema } from './assets.schema.js';
import { extendReturnSchema } from './gate-passes.schema.js';
import { myAssetsController } from './my-assets.controller.js';

/**
 * My assets — mounted at /api/v1/my-assets. Every route acts on the
 * caller's own items only (`me` scope; no OPS grant).
 *
 *   GET  /                        held, passes, requests, stock, passable items
 *   POST /loans/:id/back          a lent item is back at its zone
 *   POST /loans/:id/extend        still out: reason + new date
 *   POST /passes/:id/back         a gate-pass item is back
 *   POST /passes/:id/extend       still out: reason + new date
 *   POST /:id/incidents           report damage / loss / theft of my item
 */
export const myAssetsRoutes = Router();

myAssetsRoutes.use(authenticate);

myAssetsRoutes.get('/', myAssetsController.overview);
myAssetsRoutes.post('/loans/:id/back', myAssetsController.loanBack);
myAssetsRoutes.post(
  '/loans/:id/extend',
  validateBody(extendReturnSchema),
  myAssetsController.loanExtend,
);
myAssetsRoutes.post('/passes/:id/back', myAssetsController.passBack);
myAssetsRoutes.post(
  '/passes/:id/extend',
  validateBody(extendReturnSchema),
  myAssetsController.passExtend,
);
myAssetsRoutes.post(
  '/:id/incidents',
  validateBody(reportIncidentSchema),
  myAssetsController.reportIncident,
);
