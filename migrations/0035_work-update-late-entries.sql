CREATE TABLE "org"."work_update_miss_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"month" text NOT NULL,
	"misses" integer NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."work_updates" ADD COLUMN "goal_ids" uuid[];--> statement-breakpoint
ALTER TABLE "org"."work_updates" ADD COLUMN "late_status" text;--> statement-breakpoint
ALTER TABLE "org"."work_updates" ADD COLUMN "late_decided_by" uuid;--> statement-breakpoint
ALTER TABLE "org"."work_updates" ADD COLUMN "late_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org"."work_update_miss_flags" ADD CONSTRAINT "work_update_miss_flags_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_update_miss_flags_uq" ON "org"."work_update_miss_flags" USING btree ("employee_id","month");--> statement-breakpoint
ALTER TABLE "org"."work_updates" ADD CONSTRAINT "work_updates_late_decided_by_employees_id_fk" FOREIGN KEY ("late_decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;