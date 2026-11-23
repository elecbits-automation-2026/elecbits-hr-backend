import { z } from '../../shared/zod.js';

/** POST /me/privacy/accept — the version the person read (must be the current one). */
export const acceptPrivacySchema = z
  .object({ version: z.string().trim().min(1).max(40) })
  .strict()
  .openapi('AcceptPrivacy');

/** GET /me/privacy — the current notice and whether this person still has to accept it. */
export const privacyStatusSchema = z
  .object({
    version: z.string(),
    text: z.string(),
    acceptedVersion: z.string().nullable(),
    acceptedAt: z.string().datetime().nullable(),
    required: z.boolean(),
  })
  .openapi('PrivacyStatus');

/** GET /me/export — everything the HRMS holds about the caller, as JSON. */
export const myDataExportSchema = z
  .object({
    exportedAt: z.string().datetime(),
    note: z.string(),
    sections: z.record(z.string(), z.unknown()),
  })
  .openapi('MyDataExport');

/** GET /admin/privacy/retention — what the purge job would remove today. */
export const retentionPreviewSchema = z
  .object({
    purgeEnabled: z.boolean(),
    periods: z.object({
      gpsMonths: z.number().int(),
      medicalCertificateMonths: z.number().int(),
      exEmployeeYears: z.number().int(),
    }),
    cutoffs: z.object({ gps: z.string(), medical: z.string(), exEmployee: z.string() }),
    wouldRemove: z.object({
      punchLocations: z.number().int(),
      medicalCertificates: z.number().int(),
      exEmployeeContactRecords: z.number().int(),
    }),
  })
  .openapi('RetentionPreview');

export type AcceptPrivacyInput = z.infer<typeof acceptPrivacySchema>;
export type PrivacyStatusDto = z.infer<typeof privacyStatusSchema>;
export type MyDataExportDto = z.infer<typeof myDataExportSchema>;
export type RetentionPreviewDto = z.infer<typeof retentionPreviewSchema>;
