import createError from 'http-errors';
import type { AuthzRepository } from '../access/authz.repository.js';
import type { Action } from '../../shared/constants/constants.js';
import { hasOrgScope } from '../../shared/helpers/helpers.js';
import type {
  ActorContext,
  OrgSettingRow,
  SettingsRepository,
} from './settings.repository.js';
import {
  AREA_MODULES,
  PUBLIC_SETTING_KEYS,
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  isSettingKey,
  type SettingArea,
  type SettingKey,
} from './settings.registry.js';
import type { SettingDto } from './settings.schema.js';

/**
 * Org settings rules (refinement plan X4):
 *  - the REGISTRY is the contract: unknown keys are 404, values are validated
 *    against the key's zod shape — a typo can never poison a consumer;
 *  - the table stores only overrides; a missing row serves the code default
 *    (isDefault: true), so a fresh database behaves exactly like today;
 *  - each key belongs to an AREA: access.settings opens every area, the
 *    area's owning module (org/dept scope — a `me` grant never opens
 *    org-wide policy, review finding M4) opens its own;
 *  - every change is audited with the new value.
 */
export const createSettingsService = (deps: {
  repo: SettingsRepository;
  authz: AuthzRepository;
}) => {
  const { repo, authz } = deps;

  /** Per-request memo of "may this caller <action> this area?". */
  const gate = (callerId: string) => {
    const memo = new Map<string, Promise<boolean>>();
    const holds = (moduleKey: string, action: Action): Promise<boolean> => {
      const k = `${moduleKey}:${action}`;
      if (!memo.has(k)) {
        memo.set(
          k,
          authz
            .resolveAccess(callerId, moduleKey, action)
            .then(hasOrgScope),
        );
      }
      return memo.get(k)!;
    };
    return async (area: SettingArea, action: Action): Promise<boolean> => {
      if (await holds('access.settings', action)) return true;
      const owner = AREA_MODULES[area];
      return owner !== null && holds(owner, action);
    };
  };

  const toDto = (
    key: SettingKey,
    row: OrgSettingRow | undefined,
    names: Map<string, string>,
    canEdit: boolean,
  ): SettingDto => ({
    key,
    area: SETTINGS_REGISTRY[key].area,
    label: SETTINGS_REGISTRY[key].label,
    description: SETTINGS_REGISTRY[key].description,
    live: SETTINGS_REGISTRY[key].live,
    canEdit,
    value: row?.value ?? SETTINGS_REGISTRY[key].default,
    isDefault: row === undefined,
    updatedByName: row?.updatedBy ? (names.get(row.updatedBy) ?? null) : null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  });

  /** The settings the caller may read (optionally one area), registry order. */
  const list = async (callerId: string, area?: SettingArea): Promise<SettingDto[]> => {
    const can = gate(callerId);
    const keys = SETTING_KEYS.filter((k) => !area || SETTINGS_REGISTRY[k].area === area);
    const areas = [...new Set(keys.map((k) => SETTINGS_REGISTRY[k].area))];
    const access = new Map(
      await Promise.all(
        areas.map(
          async (a) =>
            [a, { read: await can(a, 'read'), update: await can(a, 'update') }] as const,
        ),
      ),
    );
    const visible = keys.filter((k) => access.get(SETTINGS_REGISTRY[k].area)!.read);
    if (visible.length === 0) return [];

    const rows = await repo.listRows();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const names = await repo.namesByIds(
      rows.map((r) => r.updatedBy).filter((v): v is string => v !== null),
    );
    return visible.map((key) =>
      toDto(key, byKey.get(key), names, access.get(SETTINGS_REGISTRY[key].area)!.update),
    );
  };

  /** Effective values of the public keys — readable by every signed-in user. */
  const publicValues = async (): Promise<Record<string, unknown>> =>
    repo.effectiveMany(PUBLIC_SETTING_KEYS);

  const update = async (
    key: string,
    value: unknown,
    actor: ActorContext,
  ): Promise<SettingDto> => {
    if (!isSettingKey(key)) {
      throw createError(404, 'Unknown setting', { code: 'SETTING_NOT_FOUND' });
    }
    if (!(await gate(actor.actorEmployeeId)(SETTINGS_REGISTRY[key].area, 'update'))) {
      throw createError(403, 'You cannot change this setting', {
        code: 'SETTING_FORBIDDEN',
      });
    }
    const parsed = SETTINGS_REGISTRY[key].schema.safeParse(value);
    if (!parsed.success) {
      throw createError(
        422,
        parsed.error.issues[0]?.message ?? 'Invalid value for this setting',
        {
          code: 'INVALID_SETTING_VALUE',
        },
      );
    }
    const row = await repo.upsert(key, parsed.data, actor);
    const names = await repo.namesByIds(row.updatedBy ? [row.updatedBy] : []);
    return toDto(key, row, names, true);
  };

  return { list, publicValues, update };
};

export type SettingsService = ReturnType<typeof createSettingsService>;
