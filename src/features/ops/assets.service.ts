import createError, { isHttpError } from 'http-errors';
import { localDateOf } from '../../shared/helpers/helpers.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import type { AssetsRepository, NewAsset } from './assets.repository.js';
import {
  DISPOSED_STATUSES,
  type AssetDetailDto,
  type AssetDto,
  type AssetOptionsDto,
  type CloseIncidentInput,
  type CreateAssetInput,
  type ImportAssetRow,
  type ImportAssetsInput,
  type ImportResultDto,
  type IssueAssetInput,
  type KitCheckDto,
  type MoveAssetInput,
  type ReportIncidentInput,
  type ReturnAssetInput,
  type SetAssetStatusInput,
  type TransferAssetInput,
  type UpdateAssetInput,
} from './assets.schema.js';
import { issueChange, returnChange } from './ops.changes.js';
import { toAsset, toCategory, toEvent, toIncident, toPassSummary } from './ops.dto.js';
import type {
  ActorContext,
  AssetChange,
  AssetRow,
  CategoryRow,
  OpsRepository,
} from './ops.repository.js';

const MY_ASSETS = '/my-assets';
const OPS_ASSETS = '/hr/assets';
const today = () => localDateOf(new Date());
const label = (a: { name: string; assetCode: string }) => `${a.name} (${a.assetCode})`;
const isDisposed = (s: AssetRow['status']) =>
  (DISPOSED_STATUSES as readonly string[]).includes(s);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The asset register (OPS, user decisions 2026-10-15). Every asset sits in a
 * punch zone and may also be held by one person (`assigned`). OPS issues,
 * takes back, transfers, moves between zones and changes status; the
 * employee confirms nothing. Lab categories are LENT — issuing one needs a
 * due date. Scrapped / gifted / lost are final; nothing is ever deleted and
 * every step is appended to the asset's history. Loss / damage / theft are
 * recorded as incidents only (no recovery from pay).
 */
export const createAssetsService = (deps: {
  ops: OpsRepository;
  repo: AssetsRepository;
  authz: AuthzRepository;
}) => {
  const { ops, repo, authz } = deps;

  const load = async (id: string): Promise<AssetRow> => {
    const a = await ops.asset(id);
    if (!a) throw createError(404, 'Asset not found', { code: 'ASSET_NOT_FOUND' });
    return a;
  };

  const view = async (id: string): Promise<AssetDto> => {
    const rows = await ops.assetViews({ ids: [id] });
    if (!rows[0]) throw createError(404, 'Asset not found', { code: 'ASSET_NOT_FOUND' });
    return toAsset(rows[0], today());
  };

  const assertLive = (a: AssetRow) => {
    if (isDisposed(a.status)) {
      throw createError(409, `This asset is ${a.status} — it has left the register`, {
        code: 'ASSET_DISPOSED',
      });
    }
  };

  /** Nothing moves while a gate pass is live — close the pass first. */
  const assertNoLivePass = async (id: string) => {
    const v = (await ops.assetViews({ ids: [id] }))[0];
    if (v?.pass_id) {
      throw createError(
        409,
        v.pass_status === 'approved'
          ? 'This item is out on a gate pass — mark it back first'
          : 'This item has a gate pass waiting for approval — decide it first',
        { code: 'ASSET_ON_PASS' },
      );
    }
  };

  const liveEmployee = async (id: string) => {
    const e = await ops.employee(id);
    if (!e) throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    if (e.status !== 'active') {
      throw createError(422, `${e.name} is not an active employee`, {
        code: 'NOT_ACTIVE',
      });
    }
    return e;
  };

  const zoneOrThrow = async (id: string) => {
    const z = await ops.zone(id);
    if (!z) throw createError(422, 'Unknown zone', { code: 'ZONE_NOT_FOUND' });
    return z;
  };

  /**
   * Where a handed-over asset sits: the zone OPS picked, else the person's
   * base zone (when it still exists), else where the asset already is.
   */
  const issueZone = async (
    picked: string | undefined,
    baseZoneId: string | null,
    current: string,
  ): Promise<string> => {
    if (picked) return (await zoneOrThrow(picked)).id;
    if (baseZoneId && (await ops.zone(baseZoneId))) return baseZoneId;
    return current;
  };

  const categoryOrThrow = async (id: string): Promise<CategoryRow> => {
    const c = await ops.category(id);
    if (!c) throw createError(422, 'Unknown category', { code: 'CATEGORY_NOT_FOUND' });
    return c;
  };

  /** Lab categories are lent: a due date from today on. Others never carry one. */
  const loanDue = (c: CategoryRow, dueOn: string | undefined): string | null => {
    if (c.kind !== 'lab') return null;
    if (!dueOn) {
      throw createError(422, `${c.name} is lent with a due date — give one`, {
        code: 'DUE_DATE_REQUIRED',
      });
    }
    if (dueOn < today()) {
      throw createError(422, 'The due date is in the past', { code: 'PAST_DUE_DATE' });
    }
    return dueOn;
  };

  const applyOrConflict = async (change: AssetChange, actor: ActorContext) => {
    if (!(await ops.applyAssetChange(change, actor))) {
      throw createError(409, 'The asset changed meanwhile — reload and try again', {
        code: 'ASSET_CHANGED',
      });
    }
    return view(change.assetId);
  };

  /** The next free EB-<prefix>-nnnn, skipping codes already planned in this batch. */
  const nextCode = async (prefix: string, planned: Set<string>) => {
    const base = `EB-${prefix}-`;
    const used = new Set([...(await ops.codesLike(base)), ...planned]);
    let max = 0;
    for (const c of used) {
      const n = Number(c.slice(base.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return `${base}${String(max + 1).padStart(4, '0')}`;
  };

  // ── Reads ────────────────────────────────────────────────────────────────

  const options = async (): Promise<AssetOptionsDto> => {
    const [categories, zones, people] = await Promise.all([
      ops.categories(),
      ops.zones(),
      ops.people(),
    ]);
    return { categories: categories.map(toCategory), zones, people };
  };

  const list = async (filter: { holderId?: string } = {}): Promise<AssetDto[]> => {
    const t = today();
    return (await ops.assetViews(filter)).map((r) => toAsset(r, t));
  };

  const detail = async (id: string): Promise<AssetDetailDto> => {
    const base = await view(id);
    const [events, incidents, passes] = await Promise.all([
      repo.events(id),
      repo.incidents({ assetId: id }),
      repo.passesFor(id),
    ]);
    return {
      ...base,
      events: events.map(toEvent),
      incidents: incidents.map(toIncident),
      passes: passes.map(toPassSummary),
    };
  };

  /** A joiner's kit against what they already hold (person sheet, OPS only). */
  const kitCheck = async (employeeId: string): Promise<KitCheckDto> => {
    const e = await ops.employee(employeeId);
    if (!e) throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    if (!e.designation) return { designation: null, items: [] };
    const rows = await repo.kitCheck(e.designation, employeeId);
    return {
      designation: e.designation,
      items: rows.map((r) => ({
        categoryId: r.category_id,
        categoryName: r.category_name,
        qty: r.qty,
        held: r.held,
      })),
    };
  };

  // ── Register ─────────────────────────────────────────────────────────────

  /** Validate one new asset into an insert (shared by create and import). */
  const prepare = async (
    input: CreateAssetInput,
    planned: Set<string>,
  ): Promise<NewAsset> => {
    const category = await categoryOrThrow(input.categoryId);
    const zone = await zoneOrThrow(input.zoneId);
    const code = input.assetCode?.trim()
      ? input.assetCode.trim().toUpperCase()
      : await nextCode(category.codePrefix, planned);
    if (planned.has(code) || (await ops.codeTaken(code))) {
      throw createError(409, `Asset code ${code} is already used`, {
        code: 'CODE_TAKEN',
      });
    }
    planned.add(code);
    const holder = input.holderId ? await liveEmployee(input.holderId) : null;
    const dueOn = holder ? loanDue(category, input.loanDueOn) : null;
    const values = {
      assetCode: code,
      name: input.name,
      categoryId: category.id,
      zoneId: zone.id,
      status: holder ? ('assigned' as const) : (input.status ?? 'idle'),
      holderId: holder?.id ?? null,
      loanDueOn: dueOn,
      make: input.make ?? null,
      model: input.model ?? null,
      serialNo: input.serialNo ?? null,
      purchasedOn: input.purchasedOn ?? null,
      purchaseCost: input.purchaseCost == null ? null : String(input.purchaseCost),
      vendor: input.vendor ?? null,
      warrantyUntil: input.warrantyUntil ?? null,
      condition: input.condition ?? 'good',
      notes: input.notes ?? null,
    };
    return {
      values,
      event: {
        kind: holder ? 'issued' : 'registered',
        employeeId: holder?.id ?? null,
        zoneId: zone.id,
        status: values.status,
        condition: values.condition,
        dueOn,
      },
      bells: holder
        ? [
            {
              to: [holder.id],
              event: {
                type: 'ops.asset_issued',
                title: `OPS issued you ${input.name} (${code})${dueOn ? ` — due back ${dueOn}` : ''}`,
                link: MY_ASSETS,
              },
            },
          ]
        : [],
    };
  };

  const create = async (input: CreateAssetInput, actor: ActorContext) => {
    const prepared = await prepare(input, new Set());
    const [id] = await repo.insertMany([prepared], actor);
    return view(id!);
  };

  /**
   * CSV import (the same check-then-save edit screen as the employee import).
   * Rows name their category (name or prefix), zone and holder (email); every
   * row is checked, and nothing is saved unless all pass.
   */
  const importRows = async (
    input: ImportAssetsInput,
    actor: ActorContext,
  ): Promise<ImportResultDto> => {
    const [categories, zones] = await Promise.all([ops.categories(), ops.zones()]);
    const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
    const emails = input.rows.map((r) => norm(r.holderEmail)).filter(Boolean);
    const people = await ops.peopleByEmail(emails);
    const planned = new Set<string>();
    const errors: ImportResultDto['errors'] = [];
    const prepared: NewAsset[] = [];

    const toInput = (r: ImportAssetRow): CreateAssetInput => {
      const problems: string[] = [];
      const cat = categories.find(
        (c) =>
          norm(c.name) === norm(r.category) || norm(c.codePrefix) === norm(r.category),
      );
      if (!cat) problems.push(`unknown category "${r.category ?? ''}"`);
      const zone = zones.find((z) => norm(z.name) === norm(r.zone));
      if (!zone) problems.push(`unknown zone "${r.zone ?? ''}"`);
      if (!norm(r.name)) problems.push('name is required');
      const holder = norm(r.holderEmail) ? people.get(norm(r.holderEmail)) : undefined;
      if (norm(r.holderEmail) && !holder)
        problems.push(`no employee with email ${r.holderEmail}`);
      const statusRaw = norm(r.status).replace(/[\s-]+/g, '_');
      const status =
        statusRaw === '' || statusRaw === 'idle'
          ? undefined
          : ['in_use_shared', 'in_use', 'shared'].includes(statusRaw)
            ? ('in_use_shared' as const)
            : ['needs_repair', 'repair', 'not_working'].includes(statusRaw)
              ? ('needs_repair' as const)
              : statusRaw === 'assigned'
                ? undefined
                : null;
      if (status === null) problems.push(`unknown status "${r.status}"`);
      if (statusRaw === 'assigned' && !holder)
        problems.push('assigned needs a holder email');
      const date = (v: string | undefined, name: string) => {
        if (!norm(v)) return undefined;
        if (!ISO.test(v!.trim())) problems.push(`${name} must be YYYY-MM-DD`);
        return v!.trim();
      };
      const cost = norm(r.purchaseCost)
        ? Number(r.purchaseCost!.replace(/[₹,\s]/g, ''))
        : undefined;
      if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) {
        problems.push('purchase cost must be a number');
      }
      const condition = norm(r.condition) || 'good';
      if (!['new', 'good', 'fair', 'damaged'].includes(condition)) {
        problems.push(`unknown condition "${r.condition}"`);
      }
      const out: CreateAssetInput = {
        assetCode: r.assetCode?.trim() || undefined,
        name: (r.name ?? '').trim(),
        categoryId: cat?.id ?? '',
        zoneId: zone?.id ?? '',
        status: status ?? undefined,
        holderId: holder?.id,
        loanDueOn: date(r.loanDueOn, 'loan due date'),
        make: r.make?.trim() || null,
        model: r.model?.trim() || null,
        serialNo: r.serialNo?.trim() || null,
        purchasedOn: date(r.purchasedOn, 'purchase date'),
        purchaseCost: cost,
        vendor: r.vendor?.trim() || null,
        warrantyUntil: date(r.warrantyUntil, 'warranty date'),
        condition: condition as CreateAssetInput['condition'],
        notes: r.notes?.trim() || null,
      };
      if (problems.length) throw createError(422, problems.join('; '));
      return out;
    };

    for (const [i, r] of input.rows.entries()) {
      try {
        prepared.push(await prepare(toInput(r), planned));
      } catch (err) {
        if (!isHttpError(err)) throw err;
        errors.push({ row: i + 1, message: err.message });
      }
    }
    if (errors.length || input.dryRun) {
      return { ok: errors.length === 0, created: 0, errors };
    }
    const ids = await repo.insertMany(prepared, actor);
    return { ok: true, created: ids.length, errors: [] };
  };

  const update = async (id: string, input: UpdateAssetInput, actor: ActorContext) => {
    const a = await load(id);
    if (input.categoryId) await categoryOrThrow(input.categoryId);
    const code = input.assetCode?.trim().toUpperCase();
    if (code && code !== a.assetCode && (await ops.codeTaken(code, id))) {
      throw createError(409, `Asset code ${code} is already used`, {
        code: 'CODE_TAKEN',
      });
    }
    const { purchaseCost, assetCode: _code, ...rest } = input;
    return applyOrConflict(
      {
        assetId: id,
        expect: { status: a.status, holderId: a.holderId },
        patch: {
          ...rest,
          ...(code ? { assetCode: code } : {}),
          ...(purchaseCost !== undefined
            ? { purchaseCost: purchaseCost === null ? null : String(purchaseCost) }
            : {}),
        },
        event: { kind: 'edited', note: Object.keys(input).join(', ') },
        audit: { action: 'ops.asset_edited', detail: { fields: Object.keys(input) } },
      },
      actor,
    );
  };

  // ── Custody ──────────────────────────────────────────────────────────────

  /** Check and build an issue (shared with fulfilling a request). */
  const planIssue = async (id: string, input: IssueAssetInput): Promise<AssetChange> => {
    const a = await load(id);
    assertLive(a);
    if (a.status !== 'idle' && a.status !== 'in_use_shared') {
      throw createError(
        409,
        a.status === 'assigned'
          ? `${a.assetCode} is already held by someone`
          : `${a.assetCode} is not idle or shared, so it can't be issued`,
        { code: 'NOT_ISSUABLE' },
      );
    }
    await assertNoLivePass(id);
    const [person, category] = await Promise.all([
      liveEmployee(input.employeeId),
      categoryOrThrow(a.categoryId),
    ]);
    const zoneId = await issueZone(input.zoneId, person.base_zone_id, a.zoneId);
    const dueOn = loanDue(category, input.dueOn);
    return issueChange(a, person, zoneId, dueOn, input.note ?? null);
  };

  /** Check and build a take-back (shared with fulfilling a request). */
  const planReturn = async (
    id: string,
    input: ReturnAssetInput,
  ): Promise<AssetChange> => {
    const a = await load(id);
    if (a.status !== 'assigned' || !a.holderId) {
      throw createError(409, `Nobody holds ${a.assetCode}`, { code: 'NOT_HELD' });
    }
    await assertNoLivePass(id);
    const toStatus =
      input.toStatus ?? (input.condition === 'damaged' ? 'needs_repair' : 'idle');
    return returnChange(
      { ...a, holderId: a.holderId },
      input.condition,
      toStatus,
      input.note ?? null,
    );
  };

  const issue = async (id: string, input: IssueAssetInput, actor: ActorContext) =>
    applyOrConflict(await planIssue(id, input), actor);

  /** OPS takes it back: the holder is cleared and the condition recorded. */
  const returnAsset = async (id: string, input: ReturnAssetInput, actor: ActorContext) =>
    applyOrConflict(await planReturn(id, input), actor);

  /** Person to person in one step (two history meanings in one row: who from, who to). */
  const transfer = async (id: string, input: TransferAssetInput, actor: ActorContext) => {
    const a = await load(id);
    if (a.status !== 'assigned' || !a.holderId) {
      throw createError(409, 'Nobody holds this asset — issue it instead', {
        code: 'NOT_HELD',
      });
    }
    if (a.holderId === input.employeeId) {
      throw createError(422, 'They already hold it', { code: 'SAME_HOLDER' });
    }
    await assertNoLivePass(id);
    const [person, category, from] = await Promise.all([
      liveEmployee(input.employeeId),
      categoryOrThrow(a.categoryId),
      ops.employee(a.holderId),
    ]);
    const zoneId = await issueZone(input.zoneId, person.base_zone_id, a.zoneId);
    const dueOn = loanDue(category, input.dueOn);
    return applyOrConflict(
      {
        assetId: id,
        expect: { status: 'assigned', holderId: a.holderId },
        patch: {
          holderId: person.id,
          zoneId,
          loanDueOn: dueOn,
          ...(input.condition ? { condition: input.condition } : {}),
        },
        event: {
          kind: 'transferred',
          employeeId: person.id,
          zoneId,
          status: 'assigned',
          condition: input.condition ?? null,
          dueOn,
          note: `From ${from?.name ?? 'previous holder'}${input.note ? ` — ${input.note}` : ''}`,
        },
        audit: {
          action: 'ops.asset_transferred',
          detail: { fromEmployeeId: a.holderId, toEmployeeId: person.id },
        },
        bells: [
          {
            to: [person.id],
            event: {
              type: 'ops.asset_issued',
              title: `OPS issued you ${label(a)}${dueOn ? ` — due back ${dueOn}` : ''}`,
              link: MY_ASSETS,
            },
          },
          {
            to: [a.holderId],
            event: {
              type: 'ops.asset_returned',
              title: `${label(a)} was handed over to ${person.name}`,
              link: MY_ASSETS,
            },
          },
        ],
      },
      actor,
    );
  };

  /** Only OPS changes an asset's zone. */
  const move = async (id: string, input: MoveAssetInput, actor: ActorContext) => {
    const a = await load(id);
    assertLive(a);
    if (a.zoneId === input.zoneId) {
      throw createError(422, 'It is already in that zone', { code: 'SAME_ZONE' });
    }
    const zone = await zoneOrThrow(input.zoneId);
    return applyOrConflict(
      {
        assetId: id,
        expect: { status: a.status, holderId: a.holderId },
        patch: { zoneId: zone.id },
        event: { kind: 'zone_changed', zoneId: zone.id, note: input.note ?? null },
        audit: { action: 'ops.asset_moved', detail: { from: a.zoneId, to: zone.id } },
      },
      actor,
    );
  };

  /**
   * Hand-set statuses. A held asset must come back first — except a gift,
   * which goes to the holder. Scrapped / gifted need a reason and are final.
   */
  const setStatus = async (
    id: string,
    input: SetAssetStatusInput,
    actor: ActorContext,
  ) => {
    const a = await load(id);
    assertLive(a);
    if (a.status === input.status) {
      throw createError(422, `It is already ${input.status}`, { code: 'SAME_STATUS' });
    }
    await assertNoLivePass(id);
    if (a.status === 'assigned' && input.status !== 'gifted') {
      throw createError(409, 'Someone holds this — take it back first', {
        code: 'ASSET_HELD',
      });
    }
    const final = input.status === 'scrapped' || input.status === 'gifted';
    if (final && !input.note?.trim()) {
      throw createError(422, 'Say why it is leaving the register', {
        code: 'REASON_REQUIRED',
      });
    }
    let giftedTo: string | null = null;
    if (input.status === 'gifted') {
      giftedTo = input.giftedTo ?? a.holderId;
      if (!giftedTo) {
        throw createError(422, 'Who was it gifted to?', { code: 'GIFTED_TO_REQUIRED' });
      }
      if (!(await ops.employee(giftedTo))) {
        throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
      }
    }
    return applyOrConflict(
      {
        assetId: id,
        expect: { status: a.status, holderId: a.holderId },
        patch: {
          status: input.status,
          holderId: null,
          loanDueOn: null,
          ...(final
            ? { disposedOn: today(), disposeReason: input.note!.trim(), giftedTo }
            : {}),
        },
        event: {
          kind: 'status_changed',
          status: input.status,
          employeeId: giftedTo,
          note: input.note ?? null,
        },
        audit: {
          action: 'ops.asset_status',
          detail: { from: a.status, to: input.status, giftedTo },
        },
      },
      actor,
    );
  };

  // ── Lab loans: the holder's answers ─────────────────────────────────────

  const myLoan = async (assetId: string, employeeId: string) => {
    const a = await ops.asset(assetId);
    if (!a || a.status !== 'assigned' || a.holderId !== employeeId || !a.loanDueOn) {
      throw createError(404, 'Loan not found', { code: 'LOAN_NOT_FOUND' });
    }
    return a as AssetRow & { holderId: string; loanDueOn: string };
  };

  /** "It's back": the item returns to its zone (idle) and OPS is told. */
  const loanBack = async (assetId: string, actor: ActorContext) => {
    const a = await myLoan(assetId, actor.actorEmployeeId);
    await assertNoLivePass(assetId);
    const [me, zone, audience] = await Promise.all([
      ops.employee(a.holderId),
      ops.zone(a.zoneId),
      authz.listBroadHolders('ops.assets', 'update'),
    ]);
    return applyOrConflict(
      {
        assetId,
        expect: { status: 'assigned', holderId: a.holderId },
        patch: { status: 'idle', holderId: null, loanDueOn: null },
        event: {
          kind: 'loan_back',
          employeeId: a.holderId,
          zoneId: a.zoneId,
          status: 'idle',
        },
        audit: { action: 'ops.loan_back', detail: { employeeId: a.holderId } },
        bells: [
          {
            to: audience.filter((x) => x !== a.holderId),
            event: {
              type: 'ops.loan',
              title: `${label(a)} is back at ${zone?.name ?? 'its zone'} — returned by ${me?.name ?? 'the holder'}`,
              link: OPS_ASSETS,
            },
          },
        ],
      },
      actor,
    );
  };

  /** "Still out": a reason and a new due date; OPS is told. */
  const loanExtend = async (
    assetId: string,
    input: { returnOn: string; reason: string },
    actor: ActorContext,
  ) => {
    const a = await myLoan(assetId, actor.actorEmployeeId);
    if (input.returnOn < today() || input.returnOn <= a.loanDueOn) {
      throw createError(
        422,
        'Pick a new return date after the current one, from today on',
        {
          code: 'BAD_RETURN_DATE',
        },
      );
    }
    const [me, audience] = await Promise.all([
      ops.employee(a.holderId),
      authz.listBroadHolders('ops.assets', 'update'),
    ]);
    return applyOrConflict(
      {
        assetId,
        expect: { status: 'assigned', holderId: a.holderId },
        patch: { loanDueOn: input.returnOn },
        event: {
          kind: 'loan_extended',
          employeeId: a.holderId,
          dueOn: input.returnOn,
          prevDueOn: a.loanDueOn,
          note: input.reason,
        },
        audit: { action: 'ops.loan_extended', detail: { employeeId: a.holderId } },
        bells: [
          {
            to: audience.filter((x) => x !== a.holderId),
            event: {
              type: 'ops.loan',
              title: `${me?.name ?? 'The holder'}: ${label(a)} is still out past ${a.loanDueOn} — new date ${input.returnOn}`,
              body: input.reason,
              link: OPS_ASSETS,
            },
          },
        ],
      },
      actor,
    );
  };

  // ── Incidents (recorded only) ───────────────────────────────────────────

  const incidents = async () => (await repo.incidents()).map(toIncident);

  /**
   * OPS, or the person answerable for the item (its holder, or whoever has it
   * out on a gate pass), records damage / loss / theft. A report from the
   * holder rings OPS.
   */
  const reportIncident = async (
    assetId: string,
    input: ReportIncidentInput,
    actor: ActorContext,
    asOps: boolean,
  ) => {
    const v = (await ops.assetViews({ ids: [assetId] }))[0];
    if (!v) throw createError(404, 'Asset not found', { code: 'ASSET_NOT_FOUND' });
    if (isDisposed(v.status)) {
      throw createError(409, `This asset is ${v.status}`, { code: 'ASSET_DISPOSED' });
    }
    const answerable =
      v.pass_status === 'approved' ? v.pass_holder_id : (v.holder_id ?? null);
    if (!asOps && answerable !== actor.actorEmployeeId) {
      throw createError(404, 'Asset not found', { code: 'ASSET_NOT_FOUND' });
    }
    const reporter = asOps ? undefined : await ops.employee(actor.actorEmployeeId);
    const audience = asOps ? [] : await authz.listBroadHolders('ops.assets', 'update');
    await repo.insertIncident(
      {
        assetId,
        employeeId: answerable,
        kind: input.kind,
        description: input.description,
        reportedBy: actor.actorEmployeeId,
      },
      actor,
      asOps
        ? undefined
        : {
            to: audience.filter((id) => id !== actor.actorEmployeeId),
            event: {
              type: 'ops.incident',
              title: `${reporter?.name ?? 'Someone'} reported ${input.kind} of ${v.name} (${v.asset_code})`,
              link: OPS_ASSETS,
            },
          },
    );
    return detail(assetId);
  };

  const closeIncident = async (
    id: string,
    input: CloseIncidentInput,
    actor: ActorContext,
  ) => {
    const inc = await repo.incident(id);
    if (!inc)
      throw createError(404, 'Incident not found', { code: 'INCIDENT_NOT_FOUND' });
    if (inc.status !== 'open') {
      throw createError(409, 'Already closed', { code: 'INCIDENT_CLOSED' });
    }
    let change: AssetChange | undefined;
    if (input.assetLost) {
      if (inc.kind === 'damage') {
        throw createError(422, 'Only a loss or theft can mark the asset lost', {
          code: 'NOT_A_LOSS',
        });
      }
      const a = await load(inc.assetId);
      assertLive(a);
      change = {
        assetId: a.id,
        expect: { status: a.status, holderId: a.holderId },
        patch: {
          status: 'lost',
          holderId: null,
          loanDueOn: null,
          disposedOn: today(),
          disposeReason: input.outcome,
        },
        event: {
          kind: 'incident_closed',
          status: 'lost',
          employeeId: inc.employeeId,
          note: input.outcome,
        },
        audit: { action: 'ops.asset_status', detail: { from: a.status, to: 'lost' } },
      };
    }
    if (
      !(await repo.closeIncident(
        id,
        { outcome: input.outcome, closedBy: actor.actorEmployeeId },
        actor,
        change,
      ))
    ) {
      throw createError(404, 'Incident not found', { code: 'INCIDENT_NOT_FOUND' });
    }
    return detail(inc.assetId);
  };

  return {
    options,
    list,
    detail,
    kitCheck,
    create,
    importRows,
    update,
    planIssue,
    planReturn,
    issue,
    returnAsset,
    transfer,
    move,
    setStatus,
    loanBack,
    loanExtend,
    incidents,
    reportIncident,
    closeIncident,
  };
};

export type AssetsService = ReturnType<typeof createAssetsService>;
