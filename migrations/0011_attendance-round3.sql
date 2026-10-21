ALTER TYPE "public"."approval_status" ADD VALUE 'partially_approved' BEFORE 'approved';--> statement-breakpoint
ALTER TABLE "org"."wfh_requests" ALTER COLUMN "type" SET DEFAULT 'remote';--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "base_zone_id" uuid;--> statement-breakpoint
ALTER TABLE "org"."punch_zones" ADD COLUMN "work_start" text;--> statement-breakpoint
ALTER TABLE "org"."punch_zones" ADD COLUMN "work_end" text;--> statement-breakpoint
ALTER TABLE "org"."wfh_requests" ADD COLUMN "rm_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "org"."wfh_requests" ADD COLUMN "rm_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org"."wfh_requests" ADD COLUMN "hr_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "org"."wfh_requests" ADD COLUMN "hr_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "auto_el_days" numeric(4, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "auto_sl_days" numeric(4, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "auto_cl_days" numeric(4, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "lop_overridden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."wfh_requests" ADD CONSTRAINT "wfh_requests_rm_approved_by_employees_id_fk" FOREIGN KEY ("rm_approved_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."wfh_requests" ADD CONSTRAINT "wfh_requests_hr_approved_by_employees_id_fk" FOREIGN KEY ("hr_approved_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;