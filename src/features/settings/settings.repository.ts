import { eq, inArray } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { auditLog, employees, orgSettings } from '../../db/schema/index.js';
import {
  SETTINGS_REGISTRY,
  isSettingKey,
  type SettingKey,
  type SettingValue,
} from './settings.registry.js';

export type OrgSettingRow = typeof orgSettings.$inferSelect;

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

/**
 * A stored override, re-checked against the key's CURRENT schema: a value
 * saved before the schema tightened falls back to the default instead of
 * reaching a consumer in a shape it can't handle.
 */
const resolve = <K extends SettingKey>(key: K, stored: unknown): SettingValue<K> => {
  const def = SETTINGS_REGISTRY[key];
  if (stored === undefined) return def.default as SettingValue<K>;
  const parsed = def.schema.safeParse(stored);
  return (parsed.success ? parsed.data : def.default) as SettingValue<K>;
};

/** The only place the settings feature touches the database. */
export const createSettingsRepository = (db: DbClient) => ({
  listRows: async (): Promise<OrgSettingRow[]> => db.orm.select().from(orgSettings),

  /**
   * EFFECTIVE value for one key — the stored override, or the registry
   * default when no row exists. This is the read other features compose in
   * their roots when they adopt a setting.
   */
  effective: async <K extends SettingKey>(key: K): Promise<SettingValue<K>> => {
    const rows = await db.orm
      .select({ value: orgSettings.value })
      .from(orgSettings)
      .where(eq(orgSettings.key, key))
      .limit(1);
    return resolve(key, rows[0]?.value);
  },

  /** Several keys in one round-trip — for services that read a whole policy. */
  effectiveMany: async <K extends SettingKey>(
    keys: readonly K[],
  ): Promise<{ [P in K]: SettingValue<P> }> => {
    const rows =
      keys.length === 0
        ? []
        : await db.orm
            .select({ key: orgSettings.key, value: orgSettings.value })
            .from(orgSettings)
            .where(inArray(orgSettings.key, [...keys]));
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    return Object.fromEntries(keys.map((k) => [k, resolve(k, stored.get(k))])) as {
      [P in K]: SettingValue<P>;
    };
  },

  /** Upsert the override + audit, one transaction. */
  upsert: async (
    key: SettingKey,
    value: unknown,
    actor: ActorContext,
  ): Promise<OrgSettingRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(orgSettings)
        .values({ key, value, updatedBy: actor.actorEmployeeId })
        .onConflictDoUpdate({
          target: orgSettings.key,
          set: { value, updatedBy: actor.actorEmployeeId, updatedAt: new Date() },
        })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'settings.updated',
        subject: `org_settings:${key}`,
        detail: JSON.stringify({ key, value }),
      });
      return rows[0]!;
    });
  },

  namesByIds: async (ids: string[]): Promise<Map<string, string>> => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  },
});

export type SettingsRepository = ReturnType<typeof createSettingsRepository>;

/** The narrow read surface other features depend on when they adopt a key. */
export type SettingsReader = Pick<SettingsRepository, 'effective' | 'effectiveMany'>;

export { isSettingKey };
