import { z } from '../../shared/zod.js';
import { SETTING_AREAS } from './settings.registry.js';

/**
 * One setting as the API serves it: the registry's metadata + the EFFECTIVE
 * value (stored override, or the code default when no row exists).
 */
export const settingSchema = z
  .object({
    key: z.string(),
    /** The area whose owning module (or access.settings) governs the key. */
    area: z.enum(SETTING_AREAS),
    label: z.string(),
    description: z.string(),
    /** False until a feature reads the key — editing it changes nothing yet. */
    live: z.boolean(),
    /** The caller may change it (owning module or access.settings update). */
    canEdit: z.boolean(),
    /** Shape varies per key — the registry's zod schema is the contract. */
    value: z.unknown(),
    /** True when no override row exists — the code default is in effect. */
    isDefault: z.boolean(),
    updatedByName: z.string().nullable(),
    updatedAt: z.string().datetime().nullable(),
  })
  .openapi('OrgSetting');

/** GET /settings query — optional area filter. */
export const listSettingsQuerySchema = z.object({
  area: z.enum(SETTING_AREAS).optional(),
});

/** GET /settings/public — key -> effective value, public keys only. */
export const publicSettingsSchema = z
  .record(z.string(), z.unknown())
  .openapi('PublicOrgSettings');

/** PUT body — the value is validated against the key's registry schema. */
export const updateSettingSchema = z
  .object({ value: z.unknown() })
  .openapi('UpdateOrgSetting');

export type SettingDto = z.infer<typeof settingSchema>;
export type UpdateSettingInput = z.infer<typeof updateSettingSchema>;
