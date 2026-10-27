ALTER TYPE "public"."approver_role" ADD VALUE 'ta_rm';--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "ta_rm_id" uuid;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "ta_rm_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "ta_rm_assigned_by" uuid;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD CONSTRAINT "requisitions_ta_rm_id_employees_id_fk" FOREIGN KEY ("ta_rm_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD CONSTRAINT "requisitions_ta_rm_assigned_by_employees_id_fk" FOREIGN KEY ("ta_rm_assigned_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requisitions_ta_rm_idx" ON "ta"."requisitions" USING btree ("ta_rm_id");