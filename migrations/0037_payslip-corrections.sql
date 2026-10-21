CREATE TYPE "public"."payslip_correction_status" AS ENUM('pending', 'applied', 'cancelled');--> statement-breakpoint
CREATE TABLE "org"."payslip_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"source_payslip_id" uuid NOT NULL,
	"source_month" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reason" text NOT NULL,
	"status" "payslip_correction_status" DEFAULT 'pending' NOT NULL,
	"applied_run_id" uuid,
	"created_by" uuid NOT NULL,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payslip_corrections_amount_ck" CHECK ("org"."payslip_corrections"."amount" <> 0)
);
--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "correction" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslip_corrections" ADD CONSTRAINT "payslip_corrections_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."payslip_corrections" ADD CONSTRAINT "payslip_corrections_source_payslip_id_payslips_id_fk" FOREIGN KEY ("source_payslip_id") REFERENCES "org"."payslips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."payslip_corrections" ADD CONSTRAINT "payslip_corrections_applied_run_id_payroll_runs_id_fk" FOREIGN KEY ("applied_run_id") REFERENCES "org"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."payslip_corrections" ADD CONSTRAINT "payslip_corrections_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."payslip_corrections" ADD CONSTRAINT "payslip_corrections_cancelled_by_employees_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payslip_corrections_employee_idx" ON "org"."payslip_corrections" USING btree ("employee_id","status");