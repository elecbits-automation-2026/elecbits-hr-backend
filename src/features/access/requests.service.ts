import createError from 'http-errors';
import { hasBroadScope } from '../../shared/helpers/helpers.js';
import type { AuthzRepository } from './authz.repository.js';
import type {
  ActorContext,
  GrantRequestItemRow,
  GrantRequestRow,
  RequestsRepository,
} from './requests.repository.js';
import type {
  CreateGrantRequestInput,
  DecideGrantRequestInput,
  GrantRequestDto,
  RequestItem,
} from './requests.schema.js';

/** Identity of a unit, so "granted ⊆ requested" can be checked. */
const itemKey = (i: RequestItem): string =>
  i.kind === 'batch'
    ? `batch:${i.batchId}`
    : `grant:${i.moduleKey}:${i.action}:${i.scope}`;

const toItem = (row: GrantRequestItemRow) => ({
  kind: row.kind,
  ...(row.batchId ? { batchId: row.batchId } : {}),
  ...(row.moduleKey ? { moduleKey: row.moduleKey } : {}),
  ...(row.action ? { action: row.action } : {}),
  ...(row.scope ? { scope: row.scope } : {}),
  batchName: row.batchName,
});

/**
 * Grant-request rules (§5.5, §10, refinement plan Phase 1):
 *  - HR (broad hrbp.people update) asks for extra access for ONE person at a
 *    time, never for themselves or the administration account; the Owner /
 *    a SuperAdmin never raises one (they assign batches directly);
 *  - the Owner / a SuperAdmin decides (route gate: access.requests update):
 *    approve as asked, approve NARROWER (a subset of what was asked), or
 *    decline with a reason; batch-assign delegation is dropped, so this is
 *    the only door to extra access besides Admin editing batches directly;
 *  - nobody decides a request that involves them, the Owner included;
 *  - granted items are written as their own rows, the access attaches in the
 *    same transaction (live on the next request), and everything is audited;
 *  - the bell tells the deciders about a new request and the requester and
 *    the person about the decision.
 */
export const createRequestsService = (deps: {
  repo: RequestsRepository;
  authz: AuthzRepository;
}) => {
  const { repo, authz } = deps;

  const toDtos = async (rows: GrantRequestRow[]): Promise<GrantRequestDto[]> => {
    const [items, names] = await Promise.all([
      repo.itemsFor(rows.map((r) => r.id)),
      repo.namesByIds(
        rows.flatMap((r) => [
          r.employeeId,
          r.requestedBy,
          ...(r.decidedBy ? [r.decidedBy] : []),
        ]),
      ),
    ]);
    const ref = (id: string) => ({ id, name: names.get(id) ?? '' });
    return rows.map((r) => {
      const own = items.filter((i) => i.requestId === r.id);
      return {
        id: r.id,
        employee: ref(r.employeeId),
        requestedBy: ref(r.requestedBy),
        note: r.note,
        status: r.status,
        requested: own.filter((i) => i.granted === 'requested').map(toItem),
        granted: own.filter((i) => i.granted === 'granted').map(toItem),
        decidedBy: r.decidedBy ? ref(r.decidedBy) : null,
        decisionReason: r.decisionReason,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    });
  };

  const requireHr = async (employeeId: string): Promise<{ bypass: boolean }> => {
    const access = await authz.resolveAccess(employeeId, 'hrbp.people', 'update');
    if (!access.bypass && !hasBroadScope(access.scopes)) {
      throw createError(403, 'Only HR can request access for someone', {
        code: 'NOT_HR',
      });
    }
    return { bypass: access.bypass };
  };

  /** What HR may propose: every batch but the baseline Employee one. */
  const options = async (employeeId: string) => {
    await requireHr(employeeId);
    return repo.requestableBatches();
  };

  /** Admin's queue: every request, newest first. */
  const list = async (): Promise<GrantRequestDto[]> => toDtos(await repo.list());

  /** The requests the caller raised — HR's view of where they stand. */
  const mine = async (employeeId: string): Promise<GrantRequestDto[]> =>
    toDtos(await repo.list({ requestedBy: employeeId }));

  const create = async (
    input: CreateGrantRequestInput,
    actor: ActorContext,
  ): Promise<GrantRequestDto> => {
    // The Owner / a SuperAdmin decides requests and assigns batches directly;
    // a request from them could only be decided by themselves (refused below
    // in decide), so it would sit pending forever.
    if ((await requireHr(actor.actorEmployeeId)).bypass) {
      throw createError(422, 'Admin assigns batches directly — no request needed', {
        code: 'ASSIGN_DIRECTLY',
      });
    }
    if (input.employeeId === actor.actorEmployeeId) {
      throw createError(403, 'You cannot request extra access for yourself', {
        code: 'NO_SELF_APPROVAL',
      });
    }
    const target = await repo.findEmployee(input.employeeId);
    if (!target || target.status === 'inactive') {
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    // HR proposes access only for people their grant reaches (Phase 3).
    if (
      !(await authz.reaches(actor.actorEmployeeId, 'hrbp.people', 'update', target.id))
    ) {
      throw createError(403, 'This person is outside the people your HR access covers', {
        code: 'OUT_OF_SCOPE',
      });
    }
    if (await repo.isOwner(input.employeeId)) {
      throw createError(422, 'The administration account already has full access', {
        code: 'SYSTEM_ACCOUNT',
      });
    }
    const deciders = (await repo.deciderIds()).filter(
      (id) => id !== actor.actorEmployeeId,
    );
    const row = await repo
      .insertWithItems(input, actor, {
        recipientIds: deciders,
        event: {
          type: 'access.request_created',
          title: `Access request for ${target.name}`,
          body: input.note,
          link: '/admin/grant-requests',
        },
      })
      .catch((err: unknown) => {
        const e = err as { code?: string; cause?: { code?: string } };
        if (e.code === '23503' || e.cause?.code === '23503') {
          throw createError(422, 'A requested batch or module does not exist', {
            code: 'UNKNOWN_ITEM',
          });
        }
        throw err;
      });
    return (await toDtos([row]))[0]!;
  };

  const decide = async (
    id: string,
    input: DecideGrantRequestInput,
    actor: ActorContext,
  ): Promise<GrantRequestDto> => {
    const request = await repo.findById(id);
    if (!request)
      throw createError(404, 'Request not found', { code: 'REQUEST_NOT_FOUND' });
    if (request.status !== 'pending') {
      throw createError(409, 'Request already decided', { code: 'ALREADY_DECIDED' });
    }
    if (
      request.employeeId === actor.actorEmployeeId ||
      request.requestedBy === actor.actorEmployeeId
    ) {
      // No self-approval (§10).
      throw createError(403, 'You cannot decide a request that involves you', {
        code: 'NO_SELF_APPROVAL',
      });
    }

    let status: 'approved' | 'approved_narrower' | 'declined' = 'declined';
    let granted: RequestItem[] = [];
    if (input.decision === 'approve') {
      const requested = (await repo.itemsFor([id]))
        .filter((i) => i.granted === 'requested')
        .map(toItem);
      const asked = new Set(requested.map(itemKey));
      granted = input.grantedItems ?? requested.map(({ batchName: _n, ...item }) => item);
      if (granted.some((g) => !asked.has(itemKey(g)))) {
        throw createError(422, 'You can only grant what was asked, or less', {
          code: 'BROADER_THAN_REQUESTED',
        });
      }
      const distinct = new Set(granted.map(itemKey));
      status = distinct.size < asked.size ? 'approved_narrower' : 'approved';
    }

    const target = await repo.findEmployee(request.employeeId);
    const outcome =
      status === 'declined'
        ? 'was declined'
        : status === 'approved_narrower'
          ? 'was approved in part'
          : 'was approved';
    const updated = await repo.applyDecision(
      request,
      { status, reason: input.reason?.trim() || null, granted },
      actor,
      {
        recipientIds: [request.requestedBy, request.employeeId],
        event: {
          type: 'access.request_decided',
          title: `Access request for ${target?.name ?? 'an employee'} ${outcome}`,
          body: input.reason?.trim() || null,
          link: null,
        },
      },
    );
    if (!updated) {
      throw createError(409, 'Request already decided', { code: 'ALREADY_DECIDED' });
    }
    return (await toDtos([updated]))[0]!;
  };

  return { list, mine, options, create, decide };
};

export type RequestsService = ReturnType<typeof createRequestsService>;
