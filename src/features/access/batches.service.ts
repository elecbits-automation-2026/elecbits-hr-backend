import createError from 'http-errors';
import { BASELINE_BATCHES } from '../../shared/constants/constants.js';
import type { BatchDto, UpsertBatchInput } from './batches.schema.js';
import type { ActorContext, BatchesRepository, BatchRow } from './batches.repository.js';

/**
 * Batch rules (§3.2–§3.3):
 *  - effective access is a UNION — no deny rules;
 *  - edits apply live to every holder, and are audit-logged;
 *  - assigning a batch outside the caller's assignable list must become a
 *    grant REQUEST instead (enforced here once batch_assign_rights is read);
 *  - nobody edits their own access — no self-approval (§10).
 */
export const createBatchesService = (deps: { repo: BatchesRepository }) => {
  const { repo } = deps;

  const toBatch = async (row: BatchRow): Promise<BatchDto> => ({
    id: row.id,
    name: row.name,
    description: row.description,
    grants: (await repo.listGrants(row.id)).map((g) => ({
      moduleKey: g.moduleKey,
      action: g.action,
      scope: g.scope,
    })),
    createdAt: row.createdAt.toISOString(),
  });

  const list = async () => Promise.all((await repo.list()).map(toBatch));

  const modules = async () =>
    (await repo.listModules()).map((m) => ({
      key: m.key,
      name: m.name,
      parentKey: m.parentKey,
    }));

  const create = async (input: UpsertBatchInput, actor: ActorContext) =>
    toBatch(await repo.insertWithGrants(input, actor));

  /** Portal sections gate on these literal names — renaming one would silently
   *  lock every holder out of their UI while their grants still work (M9). */
  const PROTECTED_NAMES: ReadonlySet<string> = new Set([
    ...Object.values(BASELINE_BATCHES),
    'TA',
    'OPS',
  ]);

  const update = async (
    batchId: string,
    input: UpsertBatchInput,
    actor: ActorContext,
  ) => {
    const existing = await repo.findById(batchId);
    if (!existing) {
      throw createError(404, 'Batch not found', { code: 'BATCH_NOT_FOUND' });
    }
    if (PROTECTED_NAMES.has(existing.name) && input.name !== existing.name) {
      throw createError(
        422,
        'Seeded batches cannot be renamed — the portal gates on their names',
        {
          code: 'SEEDED_BATCH_NAME',
        },
      );
    }
    if (await repo.isHolder(batchId, actor.actorEmployeeId)) {
      // Editing a batch you hold is editing your own access — the same
      // self-approval ban as assign/revoke (§10), with no Owner exception.
      throw createError(403, 'You cannot edit a batch you hold yourself', {
        code: 'NO_SELF_APPROVAL',
      });
    }
    const batch = await repo.updateWithGrants(batchId, input, actor);
    if (!batch) {
      throw createError(404, 'Batch not found', { code: 'BATCH_NOT_FOUND' });
    }
    return toBatch(batch);
  };

  const holders = async (batchId: string) => {
    if (!(await repo.findById(batchId))) {
      throw createError(404, 'Batch not found', { code: 'BATCH_NOT_FOUND' });
    }
    return (await repo.listHolders(batchId)).map((h) => ({
      ...h,
      grantedAt: h.grantedAt.toISOString(),
    }));
  };

  const assign = async (batchId: string, employeeId: string, actor: ActorContext) => {
    if (employeeId === actor.actorEmployeeId) {
      // No self-approval, at any level (§10).
      throw createError(403, 'You cannot change your own access', {
        code: 'NO_SELF_APPROVAL',
      });
    }
    if (!(await repo.findById(batchId))) {
      throw createError(404, 'Batch not found', { code: 'BATCH_NOT_FOUND' });
    }
    // TODO(skeleton): check batch_assign_rights for the caller; outside the
    // assignable list -> 403 telling the client to open a grant request (§3.3).
    await repo.attachToEmployee(batchId, employeeId, actor);
  };

  const revoke = async (batchId: string, employeeId: string, actor: ActorContext) => {
    if (employeeId === actor.actorEmployeeId) {
      // Nobody edits their own access — removal included (§10).
      throw createError(403, 'You cannot change your own access', {
        code: 'NO_SELF_APPROVAL',
      });
    }
    if (!(await repo.findById(batchId))) {
      throw createError(404, 'Batch not found', { code: 'BATCH_NOT_FOUND' });
    }
    const removed = await repo.detachFromEmployee(batchId, employeeId, actor);
    if (!removed) {
      throw createError(404, 'This employee does not hold that batch', {
        code: 'NOT_A_HOLDER',
      });
    }
  };

  return { list, modules, create, update, holders, assign, revoke };
};

export type BatchesService = ReturnType<typeof createBatchesService>;
