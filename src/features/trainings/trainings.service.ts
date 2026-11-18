import { randomUUID } from 'node:crypto';
import createError from 'http-errors';
import { checkUpload } from '../../shared/helpers/uploads.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import { reachesIn, type HrDoor } from '../access/index.js';
import type {
  ActorContext,
  Bell,
  TrainingListRow,
  TrainingRow,
  TrainingsRepository,
} from './trainings.repository.js';
import type {
  AssignResultDto,
  AssignTrainingInput,
  CompleteTrainingInput,
  TrainingDto,
} from './trainings.schema.js';

const localDate = (d = new Date()): string => d.toLocaleDateString('en-CA');
const DAY_MS = 24 * 60 * 60 * 1000;
const CERT_MAX_BYTES = 10 * 1024 * 1024;
/** The due-soon bell goes this many days ahead (once). */
const DUE_SOON_DAYS = 3;

const LINK_MINE = '/growth?tab=trainings';
const LINK_TEAM = '/growth?tab=trainings';

/** Trainings are people data: HR manages them with hrbp.people (like goals). */
const HR_MANAGE: HrDoor = { moduleKey: 'hrbp.people', action: 'update' };
const HR_READ: HrDoor = { moduleKey: 'hrbp.people', action: 'read' };

const toDto = (r: TrainingListRow, today: string): TrainingDto => ({
  id: r.id,
  employee: { id: r.employee_id, name: r.employee_name, department: r.department_name },
  title: r.title,
  stream: r.stream,
  description: r.description,
  link: r.link,
  dueOn: r.due_on,
  status: r.status,
  overdue: r.status === 'assigned' && r.due_on !== null && r.due_on < today,
  assignedBy: { id: r.assigned_by, name: r.assigned_by_name },
  assignedAt: new Date(r.assigned_at).toISOString(),
  completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  completionNote: r.completion_note,
  cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
  certificate:
    r.cert_file_name !== null
      ? { fileName: r.cert_file_name, sizeBytes: r.cert_size ?? 0 }
      : null,
});

const notFound = () =>
  createError(404, 'Training not found', { code: 'TRAINING_NOT_FOUND' });

/**
 * Training rules (learner, 2026-11-16):
 *  - a manager assigns to their own reports (RM or leave approver); HR with
 *    hrbp.people update assigns to anyone in reach — one or many at once;
 *    never to yourself, the Admin account or a leaver; an open training with
 *    the same title is skipped, not duplicated;
 *  - only the person marks it done (optional note + certificate PDF/image);
 *  - whoever assigned it, the person's manager or HR may reopen or withdraw;
 *  - bells: the person on assign / reopen / withdraw, the assigner on done;
 *    the daily job rings once 3 days before the due date and once overdue
 *    (overdue also tells the assigner).
 */
export const createTrainingsService = (deps: {
  repo: TrainingsRepository;
  authz: AuthzRepository;
}) => {
  const { repo, authz } = deps;

  const hrReach = async (actorId: string, door: HrDoor) =>
    authz.reachable(
      actorId,
      await authz.resolveAccess(actorId, door.moduleKey, door.action),
    );

  /** Manager (RM / leave approver) of the person, or HR reaching them. */
  const mayManage = async (actorId: string, employeeId: string, door = HR_MANAGE) => {
    if ((await repo.teamIds(actorId)).includes(employeeId)) return true;
    return reachesIn(await hrReach(actorId, door), employeeId);
  };

  const mustFind = async (id: string): Promise<TrainingRow> => {
    const row = await repo.findById(id);
    if (!row) throw notFound();
    return row;
  };

  const dto = async (id: string): Promise<TrainingDto> =>
    toDto((await repo.one(id))!, localDate());

  const mine = async (employeeId: string) =>
    (await repo.listFor([employeeId])).map((r) => toDto(r, localDate()));

  const team = async (rmId: string) =>
    (await repo.listFor(await repo.teamIds(rmId))).map((r) => toDto(r, localDate()));

  const all = async () => (await repo.listAll()).map((r) => toDto(r, localDate()));

  const forPerson = async (employeeId: string, actor: ActorContext) => {
    const me = actor.actorEmployeeId!;
    if (employeeId !== me && !(await mayManage(me, employeeId, HR_READ))) {
      throw createError(403, "Only this person's manager or HR can see their trainings", {
        code: 'NOT_AN_APPROVER',
      });
    }
    return (await repo.listFor([employeeId])).map((r) => toDto(r, localDate()));
  };

  const assign = async (
    input: AssignTrainingInput,
    actor: ActorContext,
  ): Promise<AssignResultDto> => {
    const me = actor.actorEmployeeId!;
    const ids = [...new Set(input.employeeIds)];
    if (input.dueOn && input.dueOn < localDate()) {
      throw createError(422, 'The due date has already passed', { code: 'DUE_IN_PAST' });
    }
    if (ids.includes(me)) {
      throw createError(422, 'You cannot assign a training to yourself', {
        code: 'NO_SELF_ASSIGN',
      });
    }
    const people = await repo.people(ids);
    const byId = new Map(people.map((p) => [p.id, p]));
    const team = new Set(await repo.teamIds(me));
    const reach = await hrReach(me, HR_MANAGE);
    for (const id of ids) {
      const p = byId.get(id);
      if (!p || p.status === 'inactive') {
        throw createError(422, 'Only a current employee can be assigned a training', {
          code: 'EMPLOYEE_NOT_CURRENT',
        });
      }
      if (p.is_owner) {
        throw createError(422, 'The Admin account takes no trainings', {
          code: 'SYSTEM_ACCOUNT',
        });
      }
      if (!team.has(id) && !reachesIn(reach, id)) {
        throw createError(
          403,
          `You can assign trainings to your own reports only (${p.name})`,
          {
            code: 'NOT_AN_APPROVER',
          },
        );
      }
    }
    const open = await repo.openWithTitle(ids, input.title);
    const targets = ids.filter((id) => !open.has(id));
    const batchId = targets.length > 1 ? randomUUID() : null;
    const due = input.dueOn ? ` — due ${input.dueOn}` : '';
    const bells: Bell[] =
      targets.length > 0
        ? [
            {
              to: targets,
              event: {
                type: 'training.assigned',
                title: `New training: ${input.title}${due}`,
                body: input.description,
                link: LINK_MINE,
              },
              email: true,
            },
          ]
        : [];
    const assigned = await repo.assign(
      targets.map((employeeId) => ({
        employeeId,
        title: input.title,
        stream: input.stream,
        description: input.description ?? null,
        link: input.link ?? null,
        dueOn: input.dueOn ?? null,
        batchId,
        assignedBy: me,
      })),
      bells,
      actor,
    );
    return {
      assigned,
      skipped: ids
        .filter((id) => open.has(id))
        .map((id) => ({ id, name: byId.get(id)!.name })),
    };
  };

  const complete = async (
    id: string,
    input: CompleteTrainingInput,
    actor: ActorContext,
  ) => {
    const t = await mustFind(id);
    if (t.employeeId !== actor.actorEmployeeId) throw notFound();
    if (t.status !== 'assigned') {
      throw createError(409, `This training is ${t.status}`, { code: 'TRAINING_CLOSED' });
    }
    const person = (await repo.people([t.employeeId]))[0];
    const ok = await repo.transition(
      id,
      'assigned',
      {
        status: 'completed',
        completedAt: new Date(),
        completionNote: input.note ?? null,
      },
      'training.completed',
      t.assignedBy !== t.employeeId
        ? [
            {
              to: [t.assignedBy],
              event: {
                type: 'training.completed',
                title: `${person?.name ?? 'Someone'} completed “${t.title}”`,
                link: LINK_TEAM,
              },
            },
          ]
        : [],
      actor,
    );
    if (!ok)
      throw createError(409, 'The training changed meanwhile — reload', {
        code: 'STALE',
      });
    return dto(id);
  };

  /** Whoever assigned it, the person's manager, or HR. */
  const assertMayChange = async (t: TrainingRow, actor: ActorContext) => {
    const me = actor.actorEmployeeId!;
    if (t.assignedBy === me) return;
    if (!(await mayManage(me, t.employeeId))) {
      throw createError(
        403,
        'Only whoever assigned it, the manager or HR can change this',
        {
          code: 'NOT_AN_APPROVER',
        },
      );
    }
  };

  const reopen = async (id: string, actor: ActorContext) => {
    const t = await mustFind(id);
    await assertMayChange(t, actor);
    if (t.status !== 'completed') {
      throw createError(409, 'Only a completed training can be reopened', {
        code: 'NOT_COMPLETED',
      });
    }
    const ok = await repo.transition(
      id,
      'completed',
      { status: 'assigned', completedAt: null, completionNote: null },
      'training.reopened',
      [
        {
          to: [t.employeeId],
          event: {
            type: 'training.reopened',
            title: `“${t.title}” was reopened — it is open again`,
            link: LINK_MINE,
          },
        },
      ],
      actor,
    );
    if (!ok)
      throw createError(409, 'The training changed meanwhile — reload', {
        code: 'STALE',
      });
    return dto(id);
  };

  const cancel = async (id: string, actor: ActorContext) => {
    const t = await mustFind(id);
    await assertMayChange(t, actor);
    if (t.status !== 'assigned') {
      throw createError(409, 'Only an open training can be withdrawn', {
        code: 'NOT_OPEN',
      });
    }
    const ok = await repo.transition(
      id,
      'assigned',
      {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: actor.actorEmployeeId,
      },
      'training.cancelled',
      [
        {
          to: [t.employeeId],
          event: {
            type: 'training.cancelled',
            title: `“${t.title}” was withdrawn — nothing to do`,
            link: LINK_MINE,
          },
        },
      ],
      actor,
    );
    if (!ok)
      throw createError(409, 'The training changed meanwhile — reload', {
        code: 'STALE',
      });
    return dto(id);
  };

  const uploadCertificate = async (
    id: string,
    file: { fileName: string; data: Buffer },
    actor: ActorContext,
  ) => {
    const t = await mustFind(id);
    if (t.employeeId !== actor.actorEmployeeId) throw notFound();
    if (t.status === 'cancelled') {
      throw createError(409, 'This training was withdrawn', { code: 'TRAINING_CLOSED' });
    }
    const contentType = checkUpload(file, ['pdf', 'jpg', 'png'], {
      maxBytes: CERT_MAX_BYTES,
      what: 'The certificate',
    });
    await repo.upsertCertificate({ trainingId: id, ...file, contentType }, actor);
    return dto(id);
  };

  /** The person, whoever assigned it, their manager, or HR in reach. */
  const certificate = async (id: string, actor: ActorContext) => {
    const t = await mustFind(id);
    const me = actor.actorEmployeeId!;
    if (
      t.employeeId !== me &&
      t.assignedBy !== me &&
      !(await mayManage(me, t.employeeId, HR_READ))
    ) {
      throw notFound();
    }
    const file = await repo.certificate(id);
    if (!file) throw createError(404, 'No certificate', { code: 'CERT_NOT_FOUND' });
    return file;
  };

  /** The `training-reminders` job: once when due soon, once when overdue. */
  const daily = async (now: Date) => {
    const today = localDate(now);
    let dueSoon = 0;
    let overdue = 0;
    for (const t of await repo.openWithDueDate()) {
      const days = Math.round((Date.parse(t.due_on) - Date.parse(today)) / DAY_MS);
      if (
        days >= 0 &&
        days <= DUE_SOON_DAYS &&
        !(await repo.reminded('training_due', t.id))
      ) {
        await repo.remind('training_due', t.id, {
          to: [t.employee_id],
          event: {
            type: 'training.due_soon',
            title: `“${t.title}” is due ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}`,
            link: LINK_MINE,
          },
        });
        dueSoon += 1;
      }
      if (days < 0 && !(await repo.reminded('training_overdue', t.id))) {
        await repo.remind('training_overdue', t.id, {
          to: [t.employee_id, t.assigned_by],
          event: {
            type: 'training.overdue',
            title: `“${t.title}” is overdue (was due ${t.due_on})`,
            link: LINK_MINE,
          },
        });
        overdue += 1;
      }
    }
    return { dueSoon, overdue };
  };

  return {
    mine,
    team,
    all,
    forPerson,
    assign,
    complete,
    reopen,
    cancel,
    uploadCertificate,
    certificate,
    daily,
  };
};

export type TrainingsService = ReturnType<typeof createTrainingsService>;
