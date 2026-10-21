import createError from 'http-errors';
import type { AuthzRepository } from '../access/authz.repository.js';
import type {
  ActorContext,
  FeedbackJoinedRow,
  FeedbackRepository,
} from './feedback.repository.js';
import { createRmOrHrGate } from '../access/rmOrHr.gate.js';
import type {
  CreateFeedbackInput,
  FeedbackNoteDto,
  NoteHistoryDto,
} from './feedback.schema.js';

const toNote = (row: FeedbackJoinedRow): FeedbackNoteDto => ({
  id: row.id,
  employee: { id: row.employeeId, name: row.employeeName },
  author: { id: row.authorId, name: row.authorName },
  type: row.type,
  body: row.body,
  evidence: row.evidence,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Feedback rules (insights phase C, user decisions):
 *  - the system only ever DRAFTS — reaching this service means a human chose
 *    to send;
 *  - sender must be in the recipient's chain (RM or named leave approver) or
 *    hold a broad hrbp.people update grant; Owner/SuperAdmin bypass;
 *  - never to yourself; recipients must be real, active people;
 *  - every send is audited without the note's body.
 */
export const createFeedbackService = (deps: {
  repo: FeedbackRepository;
  authz: AuthzRepository;
}) => {
  const { repo, authz } = deps;

  const send = async (
    input: CreateFeedbackInput,
    actor: ActorContext,
  ): Promise<FeedbackNoteDto> => {
    if (input.employeeId === actor.actorEmployeeId) {
      throw createError(403, 'You cannot send a note to yourself', {
        code: 'SELF_FEEDBACK',
      });
    }
    const target = await repo.findRecipient(input.employeeId);
    if (!target || target.status === 'inactive') {
      throw createError(404, 'Recipient not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }

    const inChain =
      target.reportsTo === actor.actorEmployeeId ||
      target.leaveApprover === actor.actorEmployeeId;
    if (!inChain) {
      // HR stands in for people its grant reaches (Phase 3).
      if (!(await authz.reaches(actor.actorEmployeeId, 'hrbp.people', 'update', target.id))) {
        throw createError(403, "You are not in this person's reporting chain", {
          code: 'NOT_AN_APPROVER',
        });
      }
    }

    const row = await repo.insert(input, actor);
    return toNote({ ...row, employeeName: target.name, authorName: '' });
  };

  const mine = async (employeeId: string): Promise<FeedbackNoteDto[]> =>
    (await repo.listForRecipient(employeeId)).map(toNote);

  const sent = async (authorId: string): Promise<FeedbackNoteDto[]> =>
    (await repo.listByAuthor(authorId)).map(toNote);

  /** The person's notes, for their RM or HR (hrbp.people read reach). */
  const history = async (employeeId: string, viewerId: string): Promise<NoteHistoryDto[]> => {
    await createRmOrHrGate(authz)(viewerId, employeeId, {
      moduleKey: 'hrbp.people',
      action: 'read',
    });
    return (await repo.listForRecipient(employeeId)).map((n) => ({
      id: n.id,
      type: n.type,
      author: { id: n.authorId, name: n.authorName },
      body: n.authorId === viewerId ? n.body : null,
      createdAt: n.createdAt.toISOString(),
    }));
  };

  return { send, mine, sent, history };
};

export type FeedbackService = ReturnType<typeof createFeedbackService>;
