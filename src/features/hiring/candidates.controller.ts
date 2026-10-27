import type { Request, Response } from 'express';
import createError from 'http-errors';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createCandidatesRepository } from './candidates.repository.js';
import type {
  CreateCandidateInput,
  EndInterviewSlotInput,
  LogActivityInput,
  NextActionInput,
  UpdateCandidateInput,
  ScheduleInterviewInput,
  SubmitScoreInput,
} from './candidates.schema.js';
import { createCandidatesService } from './candidates.service.js';
import { createHiringRepository } from './hiring.repository.js';
import { ROUNDS, type InterviewRound } from './hiring.schema.js';

const service = (req: Request) =>
  createCandidatesService({
    repo: createCandidatesRepository(req.db),
    hiring: createHiringRepository(req.db),
  });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

const roundParam = (req: Request): InterviewRound => {
  const r = req.params.round;
  if (!(ROUNDS as readonly string[]).includes(r ?? '')) {
    throw createError(400, 'Unknown round', { code: 'INVALID_ROUND' });
  }
  return r as InterviewRound;
};

/** HTTP layer for candidates, applications and interview scores (TA Step D). */
export const candidatesController = {
  list: async (req: Request, res: Response): Promise<void> => {
    const q = String(req.query.q ?? '').trim();
    res.json(await service(req).list(q || null));
  },

  matches: async (req: Request, res: Response): Promise<void> => {
    const email = String(req.query.email ?? '').trim();
    const phone = String(req.query.phone ?? '').trim();
    res.json(await service(req).matches(email || null, phone || null));
  },

  get: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).candidate(req.params.id!));
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateCandidateInput = req.body;
    const c = await service(req).create(input, actor(req));
    req.log.info({ candidateId: c.id }, 'candidate added');
    res.status(201).json(c);
  },

  uploadCv: async (req: Request, res: Response): Promise<void> => {
    if (!Buffer.isBuffer(req.body)) {
      throw createError(422, 'Send the file as the raw request body', {
        code: 'NOT_A_FILE',
      });
    }
    const fileName = String(req.query.filename ?? 'cv').slice(0, 200);
    const out = await service(req).uploadCv(
      req.params.id!,
      { fileName, contentType: req.headers['content-type'] ?? '', data: req.body },
      actor(req),
    );
    req.log.info({ candidateId: out.id, bytes: req.body.length }, 'candidate cv stored');
    res.json(out);
  },

  cv: async (req: Request, res: Response): Promise<void> => {
    // TA (the ta.hiring read grant, org-wide) or one of the candidate's interviewers.
    const access = await createAuthzRepository(req.db).resolveAccess(
      req.auth!.employeeId,
      'ta.hiring',
      'read',
    );
    const isTa = access.bypass || access.scopes.includes('org');
    const file = await service(req).cv(req.params.id!, req.auth!.employeeId, isTa);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${file.fileName.replaceAll('"', '')}"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(file.data);
  },

  pipeline: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).pipeline(req.params.id!));
  },

  apply: async (req: Request, res: Response): Promise<void> => {
    const a = await service(req).apply(req.params.id!, req.body.candidateId, actor(req));
    req.log.info({ applicationId: a.id }, 'application created');
    res.status(201).json(a);
  },

  informed: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).markInformed(req.params.id!, actor(req)));
  },

  startInterviews: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).startInterviews(req.params.id!, actor(req)));
  },

  reject: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await service(req).end(req.params.id!, 'rejected', req.body.reason, actor(req)),
    );
  },

  withdraw: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await service(req).end(req.params.id!, 'withdrawn', req.body.reason, actor(req)),
    );
  },

  swapInterviewer: async (req: Request, res: Response): Promise<void> => {
    await service(req).swapInterviewer(
      req.params.id!,
      roundParam(req),
      req.body.interviewerId,
      actor(req),
    );
    res.status(204).end();
  },

  score: async (req: Request, res: Response): Promise<void> => {
    const input: SubmitScoreInput = req.body;
    const a = await service(req).score(
      req.params.id!,
      roundParam(req),
      input,
      actor(req),
    );
    req.log.info({ applicationId: a.id, round: req.params.round }, 'round scored');
    res.json(a);
  },

  update: async (req: Request, res: Response): Promise<void> => {
    const input: UpdateCandidateInput = req.body;
    res.json(await service(req).updateCandidate(req.params.id!, input, actor(req)));
  },

  setNextAction: async (req: Request, res: Response): Promise<void> => {
    const input: NextActionInput = req.body;
    res.json(await service(req).setNextAction(req.params.id!, input, actor(req)));
  },

  activities: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).activities(req.params.id!));
  },

  logActivity: async (req: Request, res: Response): Promise<void> => {
    const input: LogActivityInput = req.body;
    res.status(201).json(await service(req).logActivity(req.params.id!, input, actor(req)));
  },

  schedule: async (req: Request, res: Response): Promise<void> => {
    const input: ScheduleInterviewInput = req.body;
    res.json(await service(req).schedule(req.params.id!, roundParam(req), input, actor(req)));
  },

  endSlot: async (req: Request, res: Response): Promise<void> => {
    const input: EndInterviewSlotInput = req.body;
    res.json(await service(req).endSlot(req.params.id!, roundParam(req), input, actor(req)));
  },

  myInterviews: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).myInterviews(req.auth!.employeeId));
  },
};
