CREATE TYPE "public"."reimbursement_status" AS ENUM('pending_rm', 'pending_payroll', 'approved', 'paid', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "org"."reimbursement_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"spent_on" date NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"receipt_note" text,
	"status" "reimbursement_status" NOT NULL,
	"rm_decided_by" uuid,
	"rm_decided_at" timestamp with time zone,
	"payroll_decided_by" uuid,
	"payroll_decided_at" timestamp with time zone,
	"decline_reason" text,
	"paid_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reimbursement_claims_amount_ck" CHECK ("org"."reimbursement_claims"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_rm_decided_by_employees_id_fk" FOREIGN KEY ("rm_decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_payroll_decided_by_employees_id_fk" FOREIGN KEY ("payroll_decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_paid_run_id_payroll_runs_id_fk" FOREIGN KEY ("paid_run_id") REFERENCES "org"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reimbursement_claims_employee_idx" ON "org"."reimbursement_claims" USING btree ("employee_id","status");--> statement-breakpoint
CREATE INDEX "reimbursement_claims_status_idx" ON "org"."reimbursement_claims" USING btree ("status");