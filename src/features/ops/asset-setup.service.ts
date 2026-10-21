import createError from 'http-errors';
import type { AssetSetupRepository } from './asset-setup.repository.js';
import type {
  AssetSetupDto,
  CreateCategoryInput,
  PutKitInput,
  UpdateCategoryInput,
} from './asset-setup.schema.js';
import type { ActorContext, OpsRepository } from './ops.repository.js';

/**
 * OPS setup (the `ops.locations` grant, relabelled "OPS setup" now that the
 * zones are the locations). Categories say whether items are lent (lab) and
 * whether they may leave on a gate pass; kits list what each designation
 * should be given when they join — a checklist, nothing is auto-issued.
 */
export const createAssetSetupService = (deps: {
  repo: AssetSetupRepository;
  ops: OpsRepository;
}) => {
  const { repo, ops } = deps;

  const overview = async (): Promise<AssetSetupDto> => {
    const [cats, kitRows, designations] = await Promise.all([
      repo.categoriesWithCounts(),
      repo.kits(),
      repo.designations(),
    ]);
    const kits = new Map<string, AssetSetupDto['kits'][number]>();
    for (const k of kitRows) {
      const key = k.designation.toLowerCase();
      if (!kits.has(key)) kits.set(key, { designation: k.designation, items: [] });
      kits.get(key)!.items.push({
        categoryId: k.category_id,
        categoryName: k.category_name,
        qty: k.qty,
      });
    }
    return {
      categories: cats.map((c) => ({
        id: c.id,
        name: c.name,
        codePrefix: c.code_prefix,
        kind: c.kind,
        requiresGatePass: c.requires_gate_pass,
        assetCount: c.asset_count,
      })),
      kits: [...kits.values()],
      designations,
    };
  };

  const createCategory = async (input: CreateCategoryInput, actor: ActorContext) => {
    if (await repo.clash(input.name, input.codePrefix)) {
      throw createError(409, 'A category with that name or prefix exists', {
        code: 'CATEGORY_EXISTS',
      });
    }
    await repo.insertCategory(
      { ...input, codePrefix: input.codePrefix.toUpperCase() },
      actor,
    );
    return overview();
  };

  const updateCategory = async (
    id: string,
    input: UpdateCategoryInput,
    actor: ActorContext,
  ) => {
    if (!(await ops.category(id))) {
      throw createError(404, 'Category not found', { code: 'CATEGORY_NOT_FOUND' });
    }
    if (
      (input.name || input.codePrefix) &&
      (await repo.clash(input.name, input.codePrefix, id))
    ) {
      throw createError(409, 'A category with that name or prefix exists', {
        code: 'CATEGORY_EXISTS',
      });
    }
    await repo.updateCategory(
      id,
      {
        ...input,
        ...(input.codePrefix ? { codePrefix: input.codePrefix.toUpperCase() } : {}),
      },
      actor,
    );
    return overview();
  };

  const putKit = async (input: PutKitInput, actor: ActorContext) => {
    const ids = new Set(input.items.map((i) => i.categoryId));
    if (ids.size !== input.items.length) {
      throw createError(422, 'Each category once per kit', {
        code: 'DUPLICATE_CATEGORY',
      });
    }
    for (const id of ids) {
      if (!(await ops.category(id))) {
        throw createError(422, 'Unknown category', { code: 'CATEGORY_NOT_FOUND' });
      }
    }
    await repo.replaceKit(input.designation.trim(), input.items, actor);
    return overview();
  };

  return { overview, createCategory, updateCategory, putKit };
};

export type AssetSetupService = ReturnType<typeof createAssetSetupService>;
