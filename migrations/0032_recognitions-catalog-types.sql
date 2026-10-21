DROP INDEX "org"."recognitions_approved_cycle_uq";--> statement-breakpoint
ALTER TABLE "org"."recognitions" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "org"."recognitions" ADD COLUMN "award_name" text;--> statement-breakpoint
ALTER TABLE "org"."recognitions" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "org"."recognitions" ADD COLUMN "group_lead" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "recognitions_group_idx" ON "org"."recognitions" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recognitions_approved_cycle_uq" ON "org"."recognitions" USING btree ("type","cycle") WHERE status = 'approved' AND group_lead;--> statement-breakpoint
DROP TYPE "public"."recognition_type";