ALTER TABLE "ta"."applications" ADD COLUMN "pre_end_stage" "application_stage";--> statement-breakpoint
ALTER TABLE "ta"."positions" ADD COLUMN "on_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ta"."positions" ADD COLUMN "on_hold_by" uuid;--> statement-breakpoint
ALTER TABLE "ta"."positions" ADD COLUMN "on_hold_reason" text;--> statement-breakpoint
ALTER TABLE "ta"."positions" ADD CONSTRAINT "positions_on_hold_by_employees_id_fk" FOREIGN KEY ("on_hold_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;