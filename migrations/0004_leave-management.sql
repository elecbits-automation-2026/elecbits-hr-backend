CREATE TYPE "public"."leave_day_part" AS ENUM('full', 'first_half', 'second_half');--> statement-breakpoint
CREATE TYPE "public"."leave_status" AS ENUM('pending', 'partially_approved', 'approved', 'declined', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."leave_type" AS ENUM('casual', 'sick', 'earned', 'unpaid');--> statement-breakpoint
CREATE TABLE "org"."leave_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" "leave_type" NOT NULL,
	"year" integer NOT NULL,
	"allocated" numeric(5, 1) NOT NULL,
	"used" numeric(5, 1) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_balances_allocated_ck" CHECK ("org"."leave_balances"."allocated" >= 0),
	CONSTRAINT "leave_balances_used_ck" CHECK ("org"."leave_balances"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "org"."leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" "leave_type" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"day_part" "leave_day_part" DEFAULT 'full' NOT NULL,
	"days" numeric(5, 1) NOT NULL,
	"reason" text,
	"status" "leave_status" DEFAULT 'pending' NOT NULL,
	"rm_required" boolean NOT NULL,
	"rm_approved_by" uuid,
	"rm_approved_at" timestamp with time zone,
	"hr_approved_by" uuid,
	"hr_approved_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_requests_dates_ck" CHECK ("org"."leave_requests"."end_date" >= "org"."leave_requests"."start_date"),
	CONSTRAINT "leave_requests_half_day_ck" CHECK ("org"."leave_requests"."day_part" = 'full' OR "org"."leave_requests"."start_date" = "org"."leave_requests"."end_date"),
	CONSTRAINT "leave_requests_days_ck" CHECK ("org"."leave_requests"."days" > 0)
);
--> statement-breakpoint
ALTER TABLE "org"."leave_balances" ADD CONSTRAINT "leave_balances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."leave_requests" ADD CONSTRAINT "leave_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."leave_requests" ADD CONSTRAINT "leave_requests_rm_approved_by_employees_id_fk" FOREIGN KEY ("rm_approved_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."leave_requests" ADD CONSTRAINT "leave_requests_hr_approved_by_employees_id_fk" FOREIGN KEY ("hr_approved_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."leave_requests" ADD CONSTRAINT "leave_requests_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_balances_uq" ON "org"."leave_balances" USING btree ("employee_id","type","year");--> statement-breakpoint
CREATE INDEX "leave_requests_employee_idx" ON "org"."leave_requests" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "leave_requests_status_idx" ON "org"."leave_requests" USING btree ("status");