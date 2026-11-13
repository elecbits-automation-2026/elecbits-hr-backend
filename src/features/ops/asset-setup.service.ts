import createError from 'http-errors';
import type { AssetSetupRepository } from './asset-setup.repository.js';
import type {
  AssetSetupDto,
  CreateCategoryInput,
  UpdateCategoryInput,
} from './asset-setup.schema.js';
import type { ActorContext, OpsRepository } from './ops.repository.js';

/**
 * OPS setup (the `ops.locations` grant, relabelled "OPS setup" now that the
 * zones are the locations). Categories say whether items are lent (lab) and
 * whether they may leave on a gate pass. (Joiner kits by designation were
 * removed on 2026-11-05 — OPS decides each joiner's assets.)
 */
export const createAssetSetupService = (deps: {
  repo: AssetSetupRepository;
  ops: OpsRepository;
}) => {
  const { repo, ops } = deps;

  const overview = async (): Promise<AssetSetupDto> => {
    const cats = await repo.categoriesWithCounts();
    return {
      categories: cats.map((c) => ({
        id: c.id,
        name: c.name,
        codePrefix: c.code_prefix,
        kind: c.kind,
        requiresGatePass: c.requires_gate_pass,
        assetCount: c.asset_count,
      })),
    };
  };

  /** Gate passes are for lent (lab) items only — never issued equipment like laptops. */
  const assertGatePassKind = (kind: string, requiresGatePass: boolean) => {
    if (requiresGatePass && kind !== 'lab') {
      throw createError(422, 'Only lent (lab) categories can need a gate pass', {
        code: 'GATE_PASS_LAB_ONLY',
      });
    }
  };

  const createCategory = async (input: CreateCategoryInput, actor: ActorContext) => {
    assertGatePassKind(input.kind, input.requiresGatePass);
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
    const current = await ops.category(id);
    if (!current) {
      throw createError(404, 'Category not found', { code: 'CATEGORY_NOT_FOUND' });
    }
    const kind = input.kind ?? current.kind;
    // Turning a category into issued equipment drops its gate-pass flag.
    const patch =
      kind !== 'lab' && input.requiresGatePass === undefined
        ? { ...input, requiresGatePass: false }
        : input;
    assertGatePassKind(kind, patch.requiresGatePass ?? current.requiresGatePass);
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
        ...patch,
        ...(input.codePrefix ? { codePrefix: input.codePrefix.toUpperCase() } : {}),
      },
      actor,
    );
    return overview();
  };

  return { overview, createCategory, updateCategory };
};

export type AssetSetupService = ReturnType<typeof createAssetSetupService>;
