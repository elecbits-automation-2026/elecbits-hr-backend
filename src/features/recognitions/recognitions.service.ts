import { randomUUID } from 'node:crypto';
import createError from 'http-errors';
import { hasOrgScope } from '../../shared/helpers/helpers.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import { createSelfGovernance } from '../access/selfGovernance.js';
import type { SettingValue, SettingsReader } from '../settings/index.js';
import type {
  ActorContext,
  RecognitionJoinedRow,
  RecognitionRow,
  RecognitionsRepository,
} from './recognitions.repository.js';
import type {
  BoardDto,
  CatalogEntryDto,
  CreateRecognitionInput,
  DecideRecognitionInput,
  DirectoryEntryDto,
  RecognitionDto,
} from './recognitions.schema.js';

type Catalog = SettingValue<'awards.catalog'>;
type CatalogEntry = Catalog[string];

/** "2026-10" for monthly awards, "2026-Q4" for quarterly, null for any-time. */
const cycleFor = (cadence: CatalogEntry['cadence'], at: Date): string | null => {
  const y = at.getFullYear();
  const m = at.getMonth() + 1;
  if (cadence === 'monthly') return `${y}-${String(m).padStart(2, '0')}`;
  if (cadence === 'quarterly') return `${y}-Q${Math.ceil(m / 3)}`;
  return null;
};

/** Equal shares of `total` in whole rupees; the first shares absorb the remainder. */
const splitEqually = (total: number, n: number): number[] => {
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
};

const nameOf = (row: RecognitionRow, catalog: Catalog): string =>
  row.awardName ?? catalog[row.type]?.name ?? row.type;

/**
 * R&R rules (refinement plan, Phase 2 — user-redesigned):
 *  - a manager nominates their OWN reports only (the nominator must be each
 *    recipient's effective RM); the self-governing top, who have no manager,
 *    are nominated by HR (broad hrbp.people update); never yourself;
 *  - the manager nominating IS the manager's approval: HR gives the single,
 *    final approval (broad hrbp.people update), never on a nomination they
 *    made or an award to themselves;
 *  - award types come from the HR-edited catalog (settings awards.catalog);
 *    name and ₹ value are snapshotted at nomination; a TEAM type may name
 *    several of the nominator's reports, the value split equally;
 *  - cadence is enforced at approval: monthly/quarterly types allow one
 *    approved award per window, org-wide (a team award counts once);
 *  - the bell tells HR about a nomination and the nominator + recipients
 *    about the decision; an approved award pays in the NEXT month's payslip.
 */
export const createRecognitionsService = (deps: {
  repo: RecognitionsRepository;
  authz: AuthzRepository;
  settings: SettingsReader;
}) => {
  const { repo, authz, settings } = deps;
  const selfGoverned = createSelfGovernance(authz);

  /** R&R decisions spend the company award budget: org-scoped HR only (Phase 3). */
  const isBroadHr = async (employeeId: string): Promise<boolean> =>
    hasOrgScope(await authz.resolveAccess(employeeId, 'hrbp.people', 'update'));

  const catalog = (): Promise<Catalog> => settings.effective('awards.catalog');

  /** Group rows of one nomination into a DTO per row, each listing every recipient. */
  const toDtos = (rows: RecognitionJoinedRow[], cat: Catalog): RecognitionDto[] => {
    const byGroup = new Map<string, Array<{ id: string; name: string }>>();
    for (const r of rows) {
      if (!r.groupId) continue;
      const list = byGroup.get(r.groupId) ?? [];
      list.push({ id: r.employeeId, name: r.employeeName });
      byGroup.set(r.groupId, list);
    }
    return rows.map((r) => ({
      id: r.id,
      employee: { id: r.employeeId, name: r.employeeName },
      recipients: r.groupId
        ? (byGroup.get(r.groupId) ?? [])
        : [{ id: r.employeeId, name: r.employeeName }],
      groupId: r.groupId,
      type: r.type,
      awardName: nameOf(r, cat),
      citation: r.citation,
      valueInr: r.valueInr,
      nominatedBy: { id: r.nominatedBy, name: r.nominatorName },
      status: r.status,
      cycle: r.cycle,
      decisionReason: r.decisionReason,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  };

  const nominate = async (
    input: CreateRecognitionInput,
    actor: ActorContext,
  ): Promise<RecognitionDto> => {
    const ids = [...new Set(input.employeeIds)];
    if (ids.includes(actor.actorEmployeeId)) {
      throw createError(403, 'You cannot nominate yourself', { code: 'SELF_NOMINATION' });
    }
    const cat = await catalog();
    const award = cat[input.type];
    if (!award) {
      throw createError(422, 'This award type is not in the catalog', {
        code: 'UNKNOWN_AWARD',
      });
    }
    if (!award.team && ids.length !== 1) {
      throw createError(422, `${award.name} goes to one person`, {
        code: 'SINGLE_RECIPIENT',
      });
    }

    const people = await repo.findRecipients(ids);
    if (people.length !== ids.length || people.some((p) => p.status !== 'active')) {
      throw createError(404, 'Recipient not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    // Managers nominate their own reports; HR stands in for the self-governing top.
    const hr = await isBroadHr(actor.actorEmployeeId);
    for (const p of people) {
      const ownReport = (p.leaveApprover ?? p.reportsTo) === actor.actorEmployeeId;
      const topByHr = hr && (await selfGoverned(p));
      if (!ownReport && !topByHr) {
        throw createError(403, `Only ${p.name}'s manager can nominate them`, {
          code: 'NOT_THEIR_MANAGER',
        });
      }
    }

    const shares = splitEqually(award.valueInr, ids.length);
    const ordered = ids.map((id) => people.find((p) => p.id === id)!);
    const hrHolders = (await authz.listBroadHolders('hrbp.people', 'update')).filter(
      (id) => id !== actor.actorEmployeeId && !ids.includes(id),
    );
    const inserted = await repo.insertNomination(
      ordered.map((p, i) => ({ employeeId: p.id, valueInr: shares[i]! })),
      {
        type: input.type,
        awardName: award.name,
        citation: input.citation,
        groupId: ids.length > 1 ? randomUUID() : null,
      },
      actor,
      {
        recipientIds: hrHolders,
        event: {
          type: 'recognition.nominated',
          title: `${award.name} nomination: ${ordered.map((p) => p.name).join(', ')}`,
          body: input.citation.slice(0, 200),
          link: '/recognition',
        },
      },
    );
    const nameById = new Map(ordered.map((p) => [p.id, p.name]));
    return toDtos(
      inserted.map((r) => ({
        ...r,
        employeeName: nameById.get(r.employeeId) ?? '',
        nominatorName: '',
      })),
      cat,
    )[0]!;
  };

  const decide = async (
    id: string,
    input: DecideRecognitionInput,
    actor: ActorContext,
  ): Promise<RecognitionDto> => {
    const row = await repo.findById(id);
    if (!row)
      throw createError(404, 'Nomination not found', { code: 'RECOGNITION_NOT_FOUND' });
    if (row.status !== 'pending') {
      throw createError(409, 'This nomination has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    if (input.decision === 'decline' && !input.reason?.trim()) {
      throw createError(422, 'Declining needs a reason the nominator will see', {
        code: 'DECLINE_REASON_REQUIRED',
      });
    }
    const rows = await repo.findNominationRows(row);
    if (row.nominatedBy === actor.actorEmployeeId) {
      throw createError(403, 'You cannot decide your own nomination', {
        code: 'SELF_APPROVAL',
      });
    }
    if (rows.some((r) => r.employeeId === actor.actorEmployeeId)) {
      throw createError(403, 'You cannot decide an award about yourself', {
        code: 'SELF_APPROVAL',
      });
    }
    // The manager already approved by nominating; HR's approval is final.
    if (!(await isBroadHr(actor.actorEmployeeId))) {
      throw createError(403, 'HR gives the final approval on nominations', {
        code: 'NOT_AN_APPROVER',
      });
    }

    const cat = await catalog();
    const awardName = nameOf(row, cat);
    let cycle: string | null = null;
    const cadenceFull = () =>
      createError(
        409,
        `${awardName} has already been given for ${cycle} — one per ${cat[row.type]?.cadence === 'monthly' ? 'month' : 'quarter'}`,
        { code: 'CADENCE_FULL' },
      );
    if (input.decision === 'approve') {
      // The CURRENT catalog decides the window (a type removed since keeps none).
      cycle = cycleFor(cat[row.type]?.cadence ?? 'any', new Date());
      if (cycle !== null && (await repo.countApprovedInCycle(row.type, cycle)) > 0) {
        throw cadenceFull();
      }
    }

    const approved = input.decision === 'approve';
    // The count above is the friendly early answer; the partial unique index
    // on the lead row is the arbiter when two approvals race for one window.
    const updated = await repo
      .applyDecision(
        row,
        {
          status: approved ? 'approved' : 'declined',
          cycle,
          decisionReason: input.reason?.trim() ?? null,
        },
        actor,
        {
          recipientIds: [row.nominatedBy, ...rows.map((r) => r.employeeId)],
          event: {
            type: 'recognition.decided',
            title: approved
              ? `${awardName} approved for ${rows.map((r) => r.employeeName).join(', ')}`
              : `${awardName} nomination declined`,
            body: approved
              ? 'It pays in next month’s payslip.'
              : (input.reason?.trim() ?? null),
            link: '/recognition',
          },
        },
      )
      .catch((err: unknown) => {
        const e = err as { code?: string; cause?: { code?: string } };
        if (e.code === '23505' || e.cause?.code === '23505') throw cadenceFull();
        throw err;
      });
    if (updated.length === 0) {
      throw createError(409, 'This nomination has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    const fresh = await repo.findNominationRows(row);
    return toDtos(fresh, cat).find(
      (d) => d.id === (fresh.find((r) => r.groupLead) ?? fresh[0]!).id,
    )!;
  };

  const board = async (): Promise<BoardDto> => {
    const [rows, cat] = await Promise.all([repo.listApproved(), catalog()]);
    const byPerson = new Map<
      string,
      { name: string; count: number; totalInr: number; byType: Record<string, number> }
    >();
    const typeNames: Record<string, string> = {};
    for (const [key, entry] of Object.entries(cat)) typeNames[key] = entry.name;
    for (const r of rows) {
      typeNames[r.type] ??= nameOf(r, cat);
      const entry = byPerson.get(r.employeeId) ?? {
        name: r.employeeName,
        count: 0,
        totalInr: 0,
        byType: {},
      };
      entry.count += 1;
      entry.totalInr += r.valueInr;
      entry.byType[r.type] = (entry.byType[r.type] ?? 0) + 1;
      byPerson.set(r.employeeId, entry);
    }
    return {
      ranking: [...byPerson.entries()]
        .map(([id, e]) => ({
          employee: { id, name: e.name },
          count: e.count,
          totalInr: e.totalInr,
          byType: e.byType,
        }))
        .sort((a, b) => b.count - a.count || b.totalInr - a.totalInr),
      // Recent: one card per nomination (a team award shows all its people).
      recent: toDtos(rows, cat)
        .filter((_, i) => rows[i]!.groupLead)
        .slice(0, 20),
      typeNames,
    };
  };

  const mine = async (employeeId: string): Promise<RecognitionDto[]> =>
    toDtos(await repo.listForRecipient(employeeId), await catalog());

  const sent = async (employeeId: string): Promise<RecognitionDto[]> => {
    const rows = await repo.listByNominator(employeeId);
    return toDtos(rows, await catalog()).filter((_, i) => rows[i]!.groupLead);
  };

  /** HR's queue: every pending nomination they may decide (never their own or about them). */
  const pending = async (actor: ActorContext): Promise<RecognitionDto[]> => {
    if (!(await isBroadHr(actor.actorEmployeeId))) return [];
    const rows = await repo.listPending();
    const involved = new Set(
      rows
        .filter(
          (r) =>
            r.nominatedBy === actor.actorEmployeeId ||
            r.employeeId === actor.actorEmployeeId,
        )
        .map((r) => r.groupId ?? r.id),
    );
    const visible = rows.filter((r) => !involved.has(r.groupId ?? r.id));
    return toDtos(visible, await catalog()).filter((_, i) => visible[i]!.groupLead);
  };

  /** The nomination picker: the caller's own reports; HR also sees the top people. */
  const directory = async (actor: ActorContext): Promise<DirectoryEntryDto[]> => {
    const hr = await isBroadHr(actor.actorEmployeeId);
    const ownerId = hr ? await authz.ownerId() : null;
    return (await repo.directory(actor.actorEmployeeId, ownerId)).filter(
      (p) => p.id !== actor.actorEmployeeId,
    );
  };

  /** The award types nominators can pick. */
  const awardCatalog = async (): Promise<CatalogEntryDto[]> =>
    Object.entries(await catalog()).map(([key, e]) => ({
      key,
      name: e.name,
      cadence: e.cadence,
      valueInr: e.valueInr,
      team: e.team ?? false,
    }));

  return { nominate, decide, board, mine, sent, pending, directory, awardCatalog };
};

export type RecognitionsService = ReturnType<typeof createRecognitionsService>;
