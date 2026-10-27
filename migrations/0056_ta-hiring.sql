CREATE SCHEMA "ta";
--> statement-breakpoint
CREATE TYPE "public"."approval_decision" AS ENUM('approve', 'reject');--> statement-breakpoint
CREATE TYPE "public"."approval_subject" AS ENUM('requisition', 'jd', 'scorecard', 'hire');--> statement-breakpoint
CREATE TYPE "public"."approver_role" AS ENUM('ta_head', 'vp_hr_head', 'admin');--> statement-breakpoint
CREATE TYPE "public"."interview_round" AS ENUM('hr', 'technical', 'practical', 'managerial', 'hr_final');--> statement-breakpoint
CREATE TYPE "public"."requisition_status" AS ENUM('draft', 'submitted', 'returned', 'approved', 'cancelled');--> statement-breakpoint
CREATE TABLE "ta"."hiring_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department_id" uuid NOT NULL,
	"quarter" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ta"."requisition_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requisition_id" uuid NOT NULL,
	"round" "interview_round" NOT NULL,
	"interviewer_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ta"."requisitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid,
	"department_id" uuid NOT NULL,
	"role_title" text NOT NULL,
	"quantity" integer NOT NULL,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "requisition_status" DEFAULT 'draft' NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"return_reason" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requisitions_quantity_ck" CHECK ("ta"."requisitions"."quantity" BETWEEN 1 AND 50)
);
--> statement-breakpoint
CREATE TABLE "ta"."approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" "approval_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"role" "approver_role" NOT NULL,
	"decided_by" uuid NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ta_approvals_reason_ck" CHECK ("ta"."approvals"."decision" = 'approve' OR coalesce(btrim("ta"."approvals"."reason"), '') <> '')
);
--> statement-breakpoint
ALTER TABLE "ta"."hiring_plans" ADD CONSTRAINT "hiring_plans_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "org"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."hiring_plans" ADD CONSTRAINT "hiring_plans_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."requisition_rounds" ADD CONSTRAINT "requisition_rounds_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "ta"."requisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."requisition_rounds" ADD CONSTRAINT "requisition_rounds_interviewer_id_employees_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD CONSTRAINT "requisitions_plan_id_hiring_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "ta"."hiring_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD CONSTRAINT "requisitions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "org"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD CONSTRAINT "requisitions_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD CONSTRAINT "requisitions_submitted_by_employees_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."approvals" ADD CONSTRAINT "approvals_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hiring_plans_dept_quarter_uq" ON "ta"."hiring_plans" USING btree ("department_id","quarter");--> statement-breakpoint
CREATE UNIQUE INDEX "requisition_rounds_uq" ON "ta"."requisition_rounds" USING btree ("requisition_id","round");--> statement-breakpoint
CREATE INDEX "requisitions_status_idx" ON "ta"."requisitions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "requisitions_plan_idx" ON "ta"."requisitions" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ta_approvals_uq" ON "ta"."approvals" USING btree ("subject_kind","subject_id","version","role");