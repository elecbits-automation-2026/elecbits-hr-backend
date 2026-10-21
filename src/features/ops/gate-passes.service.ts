import createError from 'http-errors';
import { localDateOf } from '../../shared/helpers/helpers.js';
import { reachesIn, type PeopleScope } from '../access/index.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import type {
  GatePassesRepository,
  GatePassRow,
  PassViewRow,
} from './gate-passes.repository.js';
import type {
  CreateGatePassInput,
  DeclineGatePassInput,
  ExtendReturnInput,
  GatePassDto,
} from './gate-passes.schema.js';
import type { ActorContext, Bell, OpsRepository } from './ops.repository.js';

const OPS_PASSES = '/hr/gate-passes';
const MY_ASSETS = '/my-assets';
const today = () => localDateOf(new Date());
const ref = (id: string | null, name: string | null) =>
  id ? { id, name: name ?? '' } : null;

const toPass = (p: PassViewRow, t: string): GatePassDto => ({
  id: p.id,
  asset: {
    id: p.asset_id,
    assetCode: p.asset_code,
    name: p.asset_name,
    zone: { id: p.zone_id, name: p.zone_name },
  },
  holder: { id: p.requested_by, name: p.holder_name },
  purpose: p.purpose,
  destination: p.destination,
  returnOn: p.return_on,
  originalReturnOn: p.original_return_on,
  disclaimerAcceptedAt: p.disclaimer_accepted_at.toISOString(),
  status: p.status,
  overdue: p.status === 'approved' && p.return_on < t,
  decidedBy: ref(p.decided_by, p.decider_name),
  decidedAt: p.decided_at?.toISOString() ?? null,
  declineReason: p.decline_reason,
  returnedAt: p.returned_at?.toISOString() ?? null,
  returnedConfirmedBy: ref(p.returned_confirmed_by, p.confirmer_name),
  createdAt: p.created_at.toISOString(),
});

/**
 * Gate-pass rules (user decisions 2026-10-15):
 *  - only items whose category is flagged may leave (never laptops);
 *  - anyone may ask for an item they hold or a zone item nobody holds, and
 *    the requester is answerable for it until it is back (the disclaimer);
 *  - OPS alone decides, never on their own pass; approval lets it leave and
 *    the requester's RM gets an FYI;
 *  - the holder (or OPS) marks it back; "still out" needs a reason and a new
 *    date. The daily ops-overdue job does the asking after the date.
 */
export const createGatePassesService = (deps: {
  repo: GatePassesRepository;
  ops: OpsRepository;
  authz: AuthzRepository;
}) => {
  const { repo, ops, authz } = deps;

  const one = async (id: string) => {
    const p = (await repo.views({ id }))[0];
    if (!p) throw createError(404, 'Gate pass not found', { code: 'PASS_NOT_FOUND' });
    return toPass(p, today());
  };

  const list = async () => {
    const t = today();
    return (await repo.views()).map((p) => toPass(p, t));
  };

  const mine = async (employeeId: string) => {
    const t = today();
    return (await repo.views({ requestedBy: employeeId })).map((p) => toPass(p, t));
  };

  const opsAudience = (subjectId: string) =>
    authz.listBroadHolders('ops.gate_passes', 'update', subjectId);

  const create = async (input: CreateGatePassInput, actor: ActorContext) => {
    const me = actor.actorEmployeeId;
    const v = (await ops.assetViews({ ids: [input.assetId] }))[0];
    if (!v) throw createError(404, 'Asset not found', { code: 'ASSET_NOT_FOUND' });
    if (!v.cat_gate) {
      throw createError(422, `${v.cat_name} items don't go out on a gate pass`, {
        code: 'GATE_PASS_NOT_REQUIRED',
      });
    }
    if (v.status === 'assigned' && v.holder_id !== me) {
      throw createError(422, `${v.holder_name ?? 'Someone else'} holds this item`, {
        code: 'HELD_BY_SOMEONE_ELSE',
      });
    }
    if (v.status !== 'assigned' && v.status !== 'idle' && v.status !== 'in_use_shared') {
      throw createError(422, 'This item is not available to take out', {
        code: 'ASSET_UNAVAILABLE',
      });
    }
    if (v.pass_id) {
      throw createError(409, 'This item already has a live gate pass', {
        code: 'PASS_OPEN',
      });
    }
    if (input.returnOn < today()) {
      throw createError(422, 'The return date is in the past', {
        code: 'PAST_RETURN_DATE',
      });
    }
    const [person, audience] = await Promise.all([ops.employee(me), opsAudience(me)]);
    const id = await repo.insert(
      {
        assetId: v.id,
        requestedBy: me,
        purpose: input.purpose,
        destination: input.destination,
        returnOn: input.returnOn,
        originalReturnOn: input.returnOn,
        disclaimerAcceptedAt: new Date(),
      },
      {
        kind: 'pass_requested',
        employeeId: me,
        dueOn: input.returnOn,
        note: input.destination,
      },
      actor,
      {
        to: audience.filter((x) => x !== me),
        event: {
          type: 'ops.gate_pass',
          title: `${person?.name ?? 'Someone'} requested a gate pass for ${v.name} (${v.asset_code}) until ${input.returnOn}`,
          link: OPS_PASSES,
        },
      },
    );
    return one(id);
  };

  const reachable = async (id: string, reach: PeopleScope): Promise<GatePassRow> => {
    const p = await repo.findById(id);
    if (!p || !reachesIn(reach, p.requestedBy)) {
      throw createError(404, 'Gate pass not found', { code: 'PASS_NOT_FOUND' });
    }
    return p;
  };

  const step = async (
    p: GatePassRow,
    patch: Parameters<GatePassesRepository['transition']>[1],
    event: Parameters<GatePassesRepository['transition']>[2],
    action: string,
    actor: ActorContext,
    bells: Bell[],
  ) => {
    if (!(await repo.transition(p, patch, event, action, actor, bells))) {
      throw createError(409, 'The gate pass changed meanwhile', { code: 'PASS_CHANGED' });
    }
    return one(p.id);
  };

  const mustBe = (p: GatePassRow, status: GatePassRow['status'], verb: string) => {
    if (p.status !== status) {
      throw createError(409, `Cannot ${verb} a ${p.status} gate pass`, {
        code: 'INVALID_TRANSITION',
      });
    }
  };

  const approve = async (id: string, actor: ActorContext, reach: PeopleScope) => {
    const p = await reachable(id, reach);
    mustBe(p, 'requested', 'approve');
    if (p.requestedBy === actor.actorEmployeeId) {
      throw createError(403, 'You cannot approve your own gate pass', {
        code: 'SELF_APPROVAL',
      });
    }
    const [v, holder] = await Promise.all([one(id), ops.employee(p.requestedBy)]);
    const what = `${v.asset.name} (${v.asset.assetCode})`;
    const bells: Bell[] = [
      {
        to: [p.requestedBy],
        event: {
          type: 'ops.gate_pass',
          title: `Gate pass approved: ${what} may leave — you're responsible for it until it's back by ${p.returnOn}`,
          link: MY_ASSETS,
        },
      },
    ];
    const rm = holder?.effective_rm;
    if (rm && rm !== actor.actorEmployeeId && rm !== p.requestedBy) {
      bells.push({
        to: [rm],
        event: {
          type: 'ops.gate_pass',
          title: `FYI: ${holder.name} is taking ${what} to ${p.destination} until ${p.returnOn}`,
        },
      });
    }
    return step(
      p,
      { status: 'approved', decidedBy: actor.actorEmployeeId, decidedAt: new Date() },
      { kind: 'pass_approved', employeeId: p.requestedBy, dueOn: p.returnOn },
      'ops.pass_approved',
      actor,
      bells,
    );
  };

  const decline = async (
    id: string,
    input: DeclineGatePassInput,
    actor: ActorContext,
    reach: PeopleScope,
  ) => {
    const p = await reachable(id, reach);
    mustBe(p, 'requested', 'decline');
    if (p.requestedBy === actor.actorEmployeeId) {
      throw createError(403, 'You cannot decide your own gate pass', {
        code: 'SELF_APPROVAL',
      });
    }
    const v = await one(id);
    return step(
      p,
      {
        status: 'declined',
        decidedBy: actor.actorEmployeeId,
        decidedAt: new Date(),
        declineReason: input.reason,
      },
      { kind: 'pass_declined', employeeId: p.requestedBy, note: input.reason },
      'ops.pass_declined',
      actor,
      [
        {
          to: [p.requestedBy],
          event: {
            type: 'ops.gate_pass',
            title: `Gate pass declined for ${v.asset.name} (${v.asset.assetCode})`,
            body: input.reason,
            link: MY_ASSETS,
          },
        },
      ],
    );
  };

  /**
   * It is back at its zone. The holder says so (OPS is told), or OPS says so
   * (the holder is told). The pass closes; the asset was never moved.
   */
  const back = async (
    id: string,
    actor: ActorContext,
    asOps: { reach: PeopleScope } | null,
  ) => {
    const p = asOps
      ? await reachable(id, asOps.reach)
      : await repo.findById(id).then((x) => {
          if (!x || x.requestedBy !== actor.actorEmployeeId) {
            throw createError(404, 'Gate pass not found', { code: 'PASS_NOT_FOUND' });
          }
          return x;
        });
    mustBe(p, 'approved', 'mark back');
    const v = await one(id);
    const what = `${v.asset.name} (${v.asset.assetCode})`;
    const bells: Bell[] = asOps
      ? [
          {
            to: [p.requestedBy],
            event: {
              type: 'ops.gate_pass',
              title: `OPS marked ${what} back at ${v.asset.zone.name}`,
              link: MY_ASSETS,
            },
          },
        ]
      : [
          {
            to: (await opsAudience(p.requestedBy)).filter((x) => x !== p.requestedBy),
            event: {
              type: 'ops.gate_pass',
              title: `${what} is back at ${v.asset.zone.name} — returned by ${v.holder.name}`,
              link: OPS_PASSES,
            },
          },
        ];
    return step(
      p,
      {
        status: 'returned',
        returnedAt: new Date(),
        returnedConfirmedBy: actor.actorEmployeeId,
      },
      { kind: 'pass_back', employeeId: p.requestedBy, zoneId: v.asset.zone.id },
      'ops.pass_back',
      actor,
      bells,
    );
  };

  /** "Still out": the holder gives the reason and a new return date; OPS is told. */
  const extend = async (id: string, input: ExtendReturnInput, actor: ActorContext) => {
    const p = await repo.findById(id);
    if (!p || p.requestedBy !== actor.actorEmployeeId) {
      throw createError(404, 'Gate pass not found', { code: 'PASS_NOT_FOUND' });
    }
    mustBe(p, 'approved', 'extend');
    if (input.returnOn < today() || input.returnOn <= p.returnOn) {
      throw createError(
        422,
        'Pick a new return date after the current one, from today on',
        {
          code: 'BAD_RETURN_DATE',
        },
      );
    }
    const v = await one(id);
    const what = `${v.asset.name} (${v.asset.assetCode})`;
    return step(
      p,
      { returnOn: input.returnOn },
      {
        kind: 'pass_extended',
        employeeId: p.requestedBy,
        dueOn: input.returnOn,
        prevDueOn: p.returnOn,
        note: input.reason,
      },
      'ops.pass_extended',
      actor,
      [
        {
          to: (await opsAudience(p.requestedBy)).filter((x) => x !== p.requestedBy),
          event: {
            type: 'ops.gate_pass',
            title: `${v.holder.name}: ${what} is still out past ${p.returnOn} — new date ${input.returnOn}`,
            body: input.reason,
            link: OPS_PASSES,
          },
        },
      ],
    );
  };

  return { list, mine, create, approve, decline, back, extend };
};

export type GatePassesService = ReturnType<typeof createGatePassesService>;
