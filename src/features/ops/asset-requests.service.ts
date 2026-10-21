import createError from 'http-errors';
import { reachesIn, type PeopleScope } from '../access/index.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import type {
  AssetRequestRow,
  AssetRequestsRepository,
  RequestViewRow,
} from './asset-requests.repository.js';
import type {
  AssetRequestDto,
  CreateAssetRequestInput,
  FulfilAssetRequestInput,
  UpdateAssetRequestInput,
} from './asset-requests.schema.js';
import type { AssetsService } from './assets.service.js';
import type { ActorContext, AssetChange, OpsRepository } from './ops.repository.js';

const ref = (id: string | null, name: string | null) =>
  id ? { id, name: name ?? '' } : null;
const assetRef = (id: string | null, code: string | null, name: string | null) =>
  id ? { id, assetCode: code ?? '', name: name ?? '' } : null;

const toRequest = (r: RequestViewRow): AssetRequestDto => ({
  id: r.id,
  requestedBy: { id: r.requested_by, name: r.requester_name },
  type: r.type,
  asset: assetRef(r.asset_id, r.asset_code, r.asset_name),
  category: ref(r.category_id, r.category_name),
  note: r.note,
  status: r.status,
  handledBy: ref(r.handled_by, r.handler_name),
  handlerNote: r.handler_note,
  fulfilledAsset: assetRef(r.fulfilled_asset_id, r.fulfilled_code, r.fulfilled_name),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const TYPE_LABEL: Record<AssetRequestRow['type'], string> = {
  new: 'a new asset',
  upgrade: 'an upgrade',
  replacement: 'a replacement',
  repair: 'a repair',
  return: 'a return',
};

/**
 * OPS queue rules: any OPS holder whose grant reaches the requester may pick
 * up any request. Requests about an item must be about one the requester
 * holds. Fulfilling issues / takes back through the register's own checks, so
 * the history reads the same as if OPS had done it from the asset drawer.
 */
export const createAssetRequestsService = (deps: {
  repo: AssetRequestsRepository;
  ops: OpsRepository;
  assets: AssetsService;
  authz: AuthzRepository;
}) => {
  const { repo, ops, assets, authz } = deps;

  const one = async (id: string) => {
    const r = (await repo.views({ id }))[0];
    if (!r) throw createError(404, 'Request not found', { code: 'REQUEST_NOT_FOUND' });
    return toRequest(r);
  };

  const listQueue = async () => (await repo.views()).map(toRequest);
  const listMine = async (employeeId: string) =>
    (await repo.views({ requestedBy: employeeId })).map(toRequest);

  const create = async (input: CreateAssetRequestInput, actor: ActorContext) => {
    const me = actor.actorEmployeeId;
    if (input.type === 'new') {
      if (!input.categoryId && !input.note?.trim()) {
        throw createError(422, 'Say what you need', { code: 'DETAIL_REQUIRED' });
      }
    } else {
      if (!input.assetId) {
        throw createError(422, 'Pick the item this is about', {
          code: 'ASSET_ID_REQUIRED',
        });
      }
      const a = await ops.asset(input.assetId);
      if (!a || a.holderId !== me) {
        throw createError(422, 'You can only ask about an item you hold', {
          code: 'NOT_YOUR_ASSET',
        });
      }
    }
    if (input.categoryId && !(await ops.category(input.categoryId))) {
      throw createError(422, 'Unknown category', { code: 'CATEGORY_NOT_FOUND' });
    }
    const [person, audience] = await Promise.all([
      ops.employee(me),
      authz.listBroadHolders('ops.asset_requests', 'update', me),
    ]);
    const id = await repo.insert(
      {
        requestedBy: me,
        type: input.type,
        assetId: input.type === 'new' ? null : input.assetId!,
        categoryId: input.categoryId ?? null,
        note: input.note?.trim() || null,
      },
      actor,
      {
        to: audience.filter((x) => x !== me),
        event: {
          type: 'ops.request',
          title: `${person?.name ?? 'Someone'} asked for ${TYPE_LABEL[input.type]}`,
          link: '/hr/asset-requests',
        },
      },
    );
    return one(id);
  };

  const reachable = async (id: string, reach: PeopleScope) => {
    const r = await repo.findById(id);
    if (!r || !reachesIn(reach, r.requestedBy)) {
      throw createError(404, 'Request not found', { code: 'REQUEST_NOT_FOUND' });
    }
    if (r.status === 'fulfilled' || r.status === 'declined') {
      throw createError(409, `This request is already ${r.status}`, {
        code: 'REQUEST_CLOSED',
      });
    }
    return r;
  };

  /** Pick up (in progress) or decline, with a note the requester sees. */
  const handle = async (
    id: string,
    input: UpdateAssetRequestInput,
    actor: ActorContext,
    reach: PeopleScope = { all: true },
  ) => {
    const r = await reachable(id, reach);
    if (r.requestedBy === actor.actorEmployeeId) {
      throw createError(403, 'You cannot handle your own request', {
        code: 'SELF_APPROVAL',
      });
    }
    if (input.status === 'declined' && !input.note?.trim()) {
      throw createError(422, 'Say why it is declined', { code: 'REASON_REQUIRED' });
    }
    const ok = await repo.setStatus(
      id,
      r.status,
      {
        status: input.status,
        handledBy: actor.actorEmployeeId,
        handlerNote: input.note ?? null,
      },
      actor,
      input.status === 'declined'
        ? {
            to: [r.requestedBy],
            event: {
              type: 'ops.request',
              title: `OPS declined your request for ${TYPE_LABEL[r.type]}`,
              body: input.note ?? undefined,
              link: '/my-assets',
            },
          }
        : undefined,
    );
    if (!ok)
      throw createError(409, 'The request changed meanwhile', {
        code: 'REQUEST_CHANGED',
      });
    return one(id);
  };

  /**
   * Fulfil. new: issue `issueAssetId`. upgrade / replacement: issue the new
   * item and take the old one back (its condition recorded) together.
   * return: take the item back. repair: just closes it with a note.
   */
  const fulfil = async (
    id: string,
    input: FulfilAssetRequestInput,
    actor: ActorContext,
    reach: PeopleScope = { all: true },
  ) => {
    const r = await reachable(id, reach);
    if (r.requestedBy === actor.actorEmployeeId) {
      throw createError(403, 'You cannot handle your own request', {
        code: 'SELF_APPROVAL',
      });
    }
    const changes: AssetChange[] = [];
    const needsIssue =
      r.type === 'new' || r.type === 'upgrade' || r.type === 'replacement';
    const takesBack =
      r.type === 'upgrade' || r.type === 'replacement' || r.type === 'return';
    if (needsIssue) {
      if (!input.issueAssetId) {
        throw createError(422, 'Pick the asset to hand over', {
          code: 'ASSET_ID_REQUIRED',
        });
      }
      changes.push(
        await assets.planIssue(input.issueAssetId, {
          employeeId: r.requestedBy,
          zoneId: input.zoneId,
          dueOn: input.dueOn,
          note: input.note,
        }),
      );
    }
    if (takesBack && r.assetId) {
      const old = await ops.asset(r.assetId);
      // Already handed back some other way — nothing to take.
      if (old && old.holderId === r.requestedBy) {
        changes.push(
          await assets.planReturn(r.assetId, {
            condition: input.returnCondition ?? 'good',
            note: input.note,
          }),
        );
      }
    }
    const ok = await ops.applyAssetChanges(changes, actor, async (tx) => {
      const moved = await repo.setStatusIn(
        tx,
        id,
        r.status,
        {
          status: 'fulfilled',
          handledBy: actor.actorEmployeeId,
          handlerNote: input.note ?? null,
          fulfilledAssetId: input.issueAssetId ?? null,
        },
        actor,
        {
          to: [r.requestedBy],
          event: {
            type: 'ops.request',
            title: `OPS completed your request for ${TYPE_LABEL[r.type]}`,
            link: '/my-assets',
          },
        },
      );
      if (!moved) {
        throw createError(409, 'The request changed meanwhile', {
          code: 'REQUEST_CHANGED',
        });
      }
    });
    if (!ok) {
      throw createError(409, 'An asset changed meanwhile — reload and try again', {
        code: 'ASSET_CHANGED',
      });
    }
    return one(id);
  };

  return { listQueue, listMine, create, handle, fulfil };
};

export type AssetRequestsService = ReturnType<typeof createAssetRequestsService>;
