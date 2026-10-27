ALTER TABLE "ta"."applications" ADD COLUMN "current_round" "interview_round";--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "rejected_round" "interview_round";--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "rejected_by" uuid;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "informed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD CONSTRAINT "applications_rejected_by_employees_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;