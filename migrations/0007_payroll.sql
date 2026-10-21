CREATE TYPE "public"."payroll_run_status" AS ENUM('draft', 'finalized', 'paid');--> statement-breakpoint
CREATE TABLE "org"."payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month" text NOT NULL,
	"status" "payroll_run_status" DEFAULT 'draft' NOT NULL,
	"generated_by" uuid NOT NULL,
	"finalized_by" uuid,
	"finalized_at" timestamp with time zone,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_month_unique" UNIQUE("month")
);
--> statement-breakpoint
CREATE TABLE "org"."payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"ctc" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"monthly_gross" numeric(12, 2) NOT NULL,
	"basic" numeric(12, 2) NOT NULL,
	"hra" numeric(12, 2) NOT NULL,
	"special_allowance" numeric(12, 2) NOT NULL,
	"working_days" numeric(4, 1) NOT NULL,
	"lop_days" numeric(4, 1) DEFAULT '0' NOT NULL,
	"lop_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"pf" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tds" numeric(12, 2) DEFAULT '0' NOT NULL,
	"professional_tax" numeric(12, 2) DEFAULT '0' NOT NULL,
	"other_deduction" numeric(12, 2) DEFAULT '0' NOT NULL,
	"earnings_total" numeric(12, 2) NOT NULL,
	"deductions_total" numeric(12, 2) NOT NULL,
	"net_pay" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payslips_lop_days_ck" CHECK ("org"."payslips"."lop_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "org"."employee_salary" ADD COLUMN "basic_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "org"."employee_salary" ADD COLUMN "hra_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "org"."employee_salary" ADD COLUMN "pf_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "org"."employee_salary" ADD COLUMN "tds_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "org"."employee_salary" ADD COLUMN "professional_tax_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "org"."employee_salary" ADD COLUMN "other_deduction_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "org"."payroll_runs" ADD CONSTRAINT "payroll_runs_generated_by_employees_id_fk" FOREIGN KEY ("generated_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."payroll_runs" ADD CONSTRAINT "payroll_runs_finalized_by_employees_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."payroll_runs" ADD CONSTRAINT "payroll_runs_paid_by_employees_id_fk" FOREIGN KEY ("paid_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD CONSTRAINT "payslips_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "org"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD CONSTRAINT "payslips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payslips_run_employee_uq" ON "org"."payslips" USING btree ("run_id","employee_id");