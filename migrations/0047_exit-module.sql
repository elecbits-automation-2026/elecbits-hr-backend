CREATE TYPE "public"."exit_clearance_kind" AS ENUM('hr', 'manager', 'ops', 'payroll');--> statement-breakpoint
CREATE TYPE "public"."exit_kind" AS ENUM('resignation', 'termination');--> statement-breakpoint
CREATE TYPE "public"."exit_status" AS ENUM('submitted', 'accepted', 'relieved', 'settled', 'withdrawn', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notice_shortfall_action" AS ENUM('waive', 'recover');--> statement-breakpoint
CREATE TYPE "public"."termination_mode" AS ENUM('serve', 'pay_in_lieu');--> statement-breakpoint
CREATE TABLE "org"."exit_clearances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exit_id" uuid NOT NULL,
	"kind" "exit_clearance_kind" NOT NULL,
	"cleared_by" uuid,
	"cleared_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "org"."exits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" "exit_kind" NOT NULL,
	"status" "exit_status" NOT NULL,
	"reason" text NOT NULL,
	"initiated_by" uuid NOT NULL,
	"notice_start_on" date NOT NULL,
	"notice_days" integer DEFAULT 0 NOT NULL,
	"proposed_last_day" date NOT NULL,
	"last_working_day" date NOT NULL,
	"shortfall_days" integer DEFAULT 0 NOT NULL,
	"shortfall_action" "notice_shortfall_action",
	"shortfall_reason" text,
	"termination_mode" "termination_mode",
	"handover_plan" text,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"relieved_at" timestamp with time zone,
	"interview" jsonb,
	"interview_at" timestamp with time zone,
	"settled_run_id" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."fnf_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exit_id" uuid NOT NULL,
	"label" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"note" text,
	"added_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."leave_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leave_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_certificates_leave_id_unique" UNIQUE("leave_id")
);
--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "exit_id" uuid;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "encashed_el_days" numeric(5, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "gratuity_years" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "gratuity" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "notice_pay" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "notice_recovery" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "sick_lop_days" numeric(5, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "sick_lop_deduction" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "fnf_recovery" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."exit_clearances" ADD CONSTRAINT "exit_clearances_exit_id_exits_id_fk" FOREIGN KEY ("exit_id") REFERENCES "org"."exits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."exit_clearances" ADD CONSTRAINT "exit_clearances_cleared_by_employees_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD CONSTRAINT "exits_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD CONSTRAINT "exits_initiated_by_employees_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD CONSTRAINT "exits_acknowledged_by_employees_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD CONSTRAINT "exits_accepted_by_employees_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD CONSTRAINT "exits_closed_by_employees_id_fk" FOREIGN KEY ("closed_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."fnf_recoveries" ADD CONSTRAINT "fnf_recoveries_exit_id_exits_id_fk" FOREIGN KEY ("exit_id") REFERENCES "org"."exits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."fnf_recoveries" ADD CONSTRAINT "fnf_recoveries_added_by_employees_id_fk" FOREIGN KEY ("added_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."leave_certificates" ADD CONSTRAINT "leave_certificates_leave_id_leave_requests_id_fk" FOREIGN KEY ("leave_id") REFERENCES "org"."leave_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."leave_certificates" ADD CONSTRAINT "leave_certificates_uploaded_by_employees_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exit_clearances_uq" ON "org"."exit_clearances" USING btree ("exit_id","kind");--> statement-breakpoint
CREATE INDEX "exits_employee_idx" ON "org"."exits" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exits_one_live_uq" ON "org"."exits" USING btree ("employee_id") WHERE status IN ('submitted', 'accepted', 'relieved');--> statement-breakpoint
CREATE INDEX "fnf_recoveries_exit_idx" ON "org"."fnf_recoveries" USING btree ("exit_id");--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD CONSTRAINT "payslips_exit_id_exits_id_fk" FOREIGN KEY ("exit_id") REFERENCES "org"."exits"("id") ON DELETE no action ON UPDATE no action;