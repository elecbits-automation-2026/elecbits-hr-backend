import type { Request, Response } from 'express';
import createError from 'http-errors';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createEmployeesRepository, createEmployeesService } from '../employees/index.js';
import {
  createOnboardingRepository,
  createOnboardingService,
} from '../onboarding/index.js';
import { createSettingsRepository } from '../settings/index.js';
import { createCandidatesRepository } from './candidates.repository.js';
import { createCandidatesService } from './candidates.service.js';
import { createHireRepository } from './hire.repository.js';
import type {
  BgvInput,
  DecideHireInput,
  MakeOfferInput,
  MarkHiredInput,
} from './hire.schema.js';
import { createHireService, type HireTransaction } from './hire.service.js';
import { createHiringRepository } from './hiring.repository.js';
import { POSITION_PROGRESS } from './hiring.service.js';

/**
 * Composition root. Mark hired runs the employee intake and the application
 * update in ONE transaction: both are built on the transaction's client.
 */
const service = (req: Request) => {
  const settings = createSettingsRepository(req.db);
  const hiring = createHiringRepository(req.db);
  const transaction: HireTransaction = (fn) =>
    req.db.transaction((tx) =>
      fn({
        employees: createEmployeesService({
          repo: createEmployeesRepository(tx),
          settings: createSettingsRepository(tx),
          authz: createAuthzRepository(tx),
          onboarding: createOnboardingService({
            repo: createOnboardingRepository(tx),
            authz: createAuthzRepository(tx),
          }),
        }),
        markHired: (id, employeeId, positionId, actor, bells) =>
          createHireRepository(tx).markHired(
            tx,
            id,
            employeeId,
            positionId,
            POSITION_PROGRESS.filled,
            actor,
            bells,
          ),
      }),
    );
  return createHireService({
    repo: createHireRepository(req.db),
    hiring,
    settings,
    applications: createCandidatesService({
      repo: createCandidatesRepository(req.db),
      hiring,
    }),
    transaction,
  });
};

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

/** HTTP layer for the final decision, offer, BGV and hire (TA Step E). */
export const hireController = {
  sendForDecision: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).sendForDecision(req.params.id!, actor(req)));
  },

  pendingDecisions: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).pendingDecisions(req.auth!.employeeId));
  },

  decide: async (req: Request, res: Response): Promise<void> => {
    const input: DecideHireInput = req.body;
    const a = await service(req).decide(req.params.id!, input, actor(req));
    req.log.info({ applicationId: a.id, decision: input.decision }, 'hire decided');
    res.json(a);
  },

  uploadOfferLetter: async (req: Request, res: Response): Promise<void> => {
    if (!Buffer.isBuffer(req.body)) {
      throw createError(422, 'Send the file as the raw request body', {
        code: 'NOT_A_FILE',
      });
    }
    const fileName = String(req.query.filename ?? 'offer-letter').slice(0, 200);
    res.json(
      await service(req).uploadOfferLetter(
        req.params.id!,
        { fileName, contentType: req.headers['content-type'] ?? '', data: req.body },
        actor(req),
      ),
    );
  },

  offerLetter: async (req: Request, res: Response): Promise<void> => {
    const file = await service(req).offerLetter(req.params.id!);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${file.fileName.replaceAll('"', '')}"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.data);
  },

  makeOffer: async (req: Request, res: Response): Promise<void> => {
    const input: MakeOfferInput = req.body;
    const a = await service(req).makeOffer(req.params.id!, input, actor(req));
    req.log.info({ applicationId: a.id }, 'offer made');
    res.json(a);
  },

  setBgv: async (req: Request, res: Response): Promise<void> => {
    const input: BgvInput = req.body;
    res.json(await service(req).setBgv(req.params.id!, input, actor(req)));
  },

  declined: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await service(req).endOffer(
        req.params.id!,
        'offer_declined',
        req.body.reason,
        actor(req),
      ),
    );
  },

  withdrawOffer: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await service(req).endOffer(
        req.params.id!,
        'offer_withdrawn',
        req.body.reason,
        actor(req),
      ),
    );
  },

  markHired: async (req: Request, res: Response): Promise<void> => {
    const input: MarkHiredInput = req.body;
    const out = await service(req).markHired(req.params.id!, input, actor(req));
    req.log.info(
      { applicationId: out.application.id, employeeId: out.employeeId },
      'candidate hired',
    );
    res.json(out);
  },

  noShow: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).noShow(req.params.id!, req.body.reason, actor(req)));
  },

};
