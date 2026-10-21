import type { Request, Response } from 'express';
import { assetRequestsServiceFor } from './asset-requests.controller.js';
import { actorOf, assetsServiceFor, idParam } from './assets.controller.js';
import type { ReportIncidentInput } from './assets.schema.js';
import { gatePassesServiceFor } from './gate-passes.controller.js';
import { GATE_PASS_DISCLAIMER, type ExtendReturnInput } from './gate-passes.schema.js';
import type { MyAssetsDto } from './my-assets.schema.js';
import { toCategory } from './ops.dto.js';
import { createOpsRepository } from './ops.repository.js';
import { stockServiceFor } from './stock.controller.js';

/** HTTP layer only — composes the OPS services for the caller's own view. */
export const myAssetsController = {
  overview: async (req: Request, res: Response): Promise<void> => {
    const me = actorOf(req).actorEmployeeId;
    const ops = createOpsRepository(req.db);
    const [held, passes, requests, stock, categories, gateItems] = await Promise.all([
      assetsServiceFor(req).list({ holderId: me }),
      gatePassesServiceFor(req).mine(me),
      assetRequestsServiceFor(req).listMine(me),
      stockServiceFor(req).movements({ employeeId: me, limit: 100 }),
      ops.categories(),
      ops.assetViews({ gatePassOnly: true }),
    ]);
    const out: MyAssetsDto = {
      held,
      passes,
      requests,
      stock,
      categories: categories.map(toCategory),
      passable: gateItems
        .filter(
          (a) =>
            !a.pass_id &&
            ((a.status === 'assigned' && a.holder_id === me) ||
              a.status === 'idle' ||
              a.status === 'in_use_shared'),
        )
        .map((a) => ({
          id: a.id,
          assetCode: a.asset_code,
          name: a.name,
          category: a.cat_name,
          zone: a.zone_name,
          mine: a.holder_id === me,
        })),
      disclaimer: GATE_PASS_DISCLAIMER,
    };
    res.json(out);
  },

  loanBack: async (req: Request, res: Response): Promise<void> => {
    res.json(await assetsServiceFor(req).loanBack(idParam(req), actorOf(req)));
  },

  loanExtend: async (req: Request, res: Response): Promise<void> => {
    const input: ExtendReturnInput = req.body;
    res.json(await assetsServiceFor(req).loanExtend(idParam(req), input, actorOf(req)));
  },

  passBack: async (req: Request, res: Response): Promise<void> => {
    res.json(await gatePassesServiceFor(req).back(idParam(req), actorOf(req), null));
  },

  passExtend: async (req: Request, res: Response): Promise<void> => {
    const input: ExtendReturnInput = req.body;
    res.json(await gatePassesServiceFor(req).extend(idParam(req), input, actorOf(req)));
  },

  reportIncident: async (req: Request, res: Response): Promise<void> => {
    const input: ReportIncidentInput = req.body;
    await assetsServiceFor(req).reportIncident(idParam(req), input, actorOf(req), false);
    req.log.info({ assetId: req.params.id }, 'asset incident reported by holder');
    res.status(201).json({ ok: true });
  },
};
