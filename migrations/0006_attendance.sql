CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'declined', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."attendance_source" AS ENUM('office', 'remote', 'regularized');--> statement-breakpoint
CREATE TABLE "org"."attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"check_in_at" timestamp with time zone NOT NULL,
	"check_out_at" timestamp with time zone,
	"source" "attendance_source" NOT NULL,
	"check_in_ip" text,
	"check_out_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_out_after_in_ck" CHECK ("org"."attendance"."check_out_at" IS NULL OR "org"."attendance"."check_out_at" > "org"."attendance"."check_in_at")
);
--> statement-breakpoint
CREATE TABLE "org"."attendance_regularizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"proposed_in" timestamp with time zone NOT NULL,
	"proposed_out" timestamp with time zone NOT NULL,
	"reason" text,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_reg_out_after_in_ck" CHECK ("org"."attendance_regularizations"."proposed_out" > "org"."attendance_regularizations"."proposed_in")
);
--> statement-breakpoint
CREATE TABLE "org"."holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holidays_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "org"."wfh_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wfh_requests_dates_ck" CHECK ("org"."wfh_requests"."end_date" >= "org"."wfh_requests"."start_date")
);
--> statement-breakpoint
ALTER TABLE "org"."attendance" ADD CONSTRAINT "attendance_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."attendance_regularizations" ADD CONSTRAINT "attendance_regularizations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."attendance_regularizations" ADD CONSTRAINT "attendance_regularizations_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."wfh_requests" ADD CONSTRAINT "wfh_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."wfh_requests" ADD CONSTRAINT "wfh_requests_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_employee_date_uq" ON "org"."attendance" USING btree ("employee_id","date");--> statement-breakpoint
CREATE INDEX "attendance_reg_employee_idx" ON "org"."attendance_regularizations" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "attendance_reg_status_idx" ON "org"."attendance_regularizations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wfh_requests_employee_idx" ON "org"."wfh_requests" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "wfh_requests_status_idx" ON "org"."wfh_requests" USING btree ("status");