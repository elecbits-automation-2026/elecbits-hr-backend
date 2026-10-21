CREATE TYPE "public"."loan_kind" AS ENUM('loan', 'advance');--> statement-breakpoint
CREATE TYPE "public"."loan_repayment_kind" AS ENUM('emi', 'fnf', 'outside');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('active', 'closed', 'recovered_at_exit');--> statement-breakpoint
CREATE TABLE "org"."loan_repayments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"run_id" uuid,
	"month" text,
	"kind" "loan_repayment_kind" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"principal_part" numeric(12, 2) NOT NULL,
	"interest_part" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" "loan_kind" NOT NULL,
	"principal" numeric(12, 2) NOT NULL,
	"interest_rate_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"months" integer NOT NULL,
	"start_month" text NOT NULL,
	"emi" numeric(12, 2) NOT NULL,
	"status" "loan_status" DEFAULT 'active' NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "loan_emi" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."loan_repayments" ADD CONSTRAINT "loan_repayments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "org"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."loan_repayments" ADD CONSTRAINT "loan_repayments_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "org"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."loans" ADD CONSTRAINT "loans_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."loans" ADD CONSTRAINT "loans_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_repayments_loan_idx" ON "org"."loan_repayments" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "loans_employee_idx" ON "org"."loans" USING btree ("employee_id");