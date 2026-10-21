-- Revert of the Grade & Band Structure migration (the policy turned out to be
-- outdated — user decision): back to the single L1–L6 ladder. Verified empty
-- before writing this: no employee had a grade, career_tracks had no rows.
ALTER TABLE "org"."employees" DROP COLUMN IF EXISTS "track";--> statement-breakpoint
ALTER TABLE "org"."employees" DROP COLUMN IF EXISTS "grade";--> statement-breakpoint
ALTER TABLE "org"."career_tracks" ALTER COLUMN "band_code" SET DATA TYPE "public"."level" USING band_code::"public"."level";--> statement-breakpoint
ALTER TABLE "org"."career_tracks" ALTER COLUMN "target_band" SET DATA TYPE "public"."level" USING target_band::"public"."level";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."grade_track";
