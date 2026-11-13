ALTER TYPE "public"."reimbursement_status" ADD VALUE 'pending_admin' BEFORE 'approved';--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD COLUMN "admin_decided_by" uuid;--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD COLUMN "admin_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD COLUMN "paid_on" date;--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD COLUMN "payment_ref" text;--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD COLUMN "paid_by" uuid;--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_admin_decided_by_employees_id_fk" FOREIGN KEY ("admin_decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_paid_by_employees_id_fk" FOREIGN KEY ("paid_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;