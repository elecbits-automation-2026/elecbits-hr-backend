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
import type { CandidateDocStatus, MarkHiredInput, OfferDraftInput } from './hire.schema.js';
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

/** A raw file body (like leave certificates), named by ?filename=. */
const fileOf = (req: Request, fallback: string) => {
  if (!Buffer.isBuffer(req.body)) {
    throw createError(422, 'Send the file as the raw request body', { code: 'NOT_A_FILE' });
  }
  return {
    fileName: String(req.query.filename ?? fallback).slice(0, 200),
    contentType: req.headers['content-type'] ?? '',
    data: req.body,
  };
};

const sendFile = (res: Response, file: { fileName: string; contentType: string; data: Buffer }) => {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `inline; filename="${file.fileName.replaceAll('"', '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file.data);
};

/** HTTP layer for documents, the HR Head-approved offer, the hire and joining. */
export const hireController = {
  documents: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).documents(req.params.id!));
  },

  addDocument: async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await service(req).addDocument(req.params.id!, req.body.name, actor(req)));
  },

  setDocument: async (req: Request, res: Response): Promise<void> => {
    const status: CandidateDocStatus = req.body.status;
    res.json(
      await service(req).setDocument(req.params.id!, req.params.docId!, status, actor(req)),
    );
  },

  setFolder: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).setFolder(req.params.id!, req.body.link, actor(req)));
  },

  uploadOfferLetter: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await service(req).uploadOfferLetter(req.params.id!, fileOf(req, 'offer-letter'), actor(req)),
    );
  },

  offerLetter: async (req: Request, res: Response): Promise<void> => {
    sendFile(res, await service(req).offerLetter(req.params.id!));
  },

  uploadSignedLetter: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await service(req).uploadSignedLetter(
        req.params.id!,
        fileOf(req, 'signed-offer-letter'),
        actor(req),
      ),
    );
  },

  signedLetter: async (req: Request, res: Response): Promise<void> => {
    sendFile(res, await service(req).signedLetter(req.params.id!));
  },

  saveOfferDraft: async (req: Request, res: Response): Promise<void> => {
    const input: OfferDraftInput = req.body;
    res.json(await service(req).saveOfferDraft(req.params.id!, input, actor(req)));
  },

  submitOffer: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).submitOffer(req.params.id!, actor(req)));
  },

  pendingOffers: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).pendingOffers(req.auth!.employeeId));
  },

  approveOffer: async (req: Request, res: Response): Promise<void> => {
    const a = await service(req).approveOffer(req.params.id!, actor(req));
    req.log.info({ applicationId: a.id }, 'offer approved');
    res.json(a);
  },

  returnOffer: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).returnOffer(req.params.id!, req.body.reason, actor(req)));
  },

  shareOffer: async (req: Request, res: Response): Promise<void> => {
    const a = await service(req).shareOffer(req.params.id!, actor(req));
    req.log.info({ applicationId: a.id }, 'offer shared');
    res.json(a);
  },

  declined: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await service(req).endOffer(req.params.id!, 'offer_declined', req.body.reason, actor(req)),
    );
  },

  withdrawOffer: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await service(req).endOffer(req.params.id!, 'offer_withdrawn', req.body.reason, actor(req)),
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

  confirmJoined: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).confirmJoined(req.params.id!, actor(req)));
  },

  noShow: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).noShow(req.params.id!, req.body.reason, actor(req)));
  },
};
