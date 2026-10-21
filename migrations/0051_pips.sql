CREATE TYPE "public"."pip_checkin_rating" AS ENUM('on_track', 'at_risk', 'off_track');--> statement-breakpoint
CREATE TYPE "public"."pip_status" AS ENUM('pending_hr', 'active', 'passed', 'not_passed', 'cancelled');--> statement-breakpoint
CREATE TABLE "org"."pip_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pip_id" uuid NOT NULL,
	"on" date NOT NULL,
	"rating" "pip_checkin_rating" NOT NULL,
	"note" text NOT NULL,
	"by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."pips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"rm_id" uuid NOT NULL,
	"status" "pip_status" DEFAULT 'pending_hr' NOT NULL,
	"reason" text NOT NULL,
	"targets" jsonb NOT NULL,
	"support" text NOT NULL,
	"start_on" date NOT NULL,
	"end_on" date NOT NULL,
	"extended" boolean DEFAULT false NOT NULL,
	"hr_by" uuid,
	"hr_at" timestamp with time zone,
	"hr_note" text,
	"acknowledged_at" timestamp with time zone,
	"outcome_note" text,
	"outcome_by" uuid,
	"outcome_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."pip_checkins" ADD CONSTRAINT "pip_checkins_pip_id_pips_id_fk" FOREIGN KEY ("pip_id") REFERENCES "org"."pips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."pip_checkins" ADD CONSTRAINT "pip_checkins_by_employees_id_fk" FOREIGN KEY ("by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."pips" ADD CONSTRAINT "pips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."pips" ADD CONSTRAINT "pips_rm_id_employees_id_fk" FOREIGN KEY ("rm_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."pips" ADD CONSTRAINT "pips_hr_by_employees_id_fk" FOREIGN KEY ("hr_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."pips" ADD CONSTRAINT "pips_outcome_by_employees_id_fk" FOREIGN KEY ("outcome_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pip_checkins_pip_idx" ON "org"."pip_checkins" USING btree ("pip_id");--> statement-breakpoint
CREATE INDEX "pips_employee_idx" ON "org"."pips" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pips_one_live_uq" ON "org"."pips" USING btree ("employee_id") WHERE status IN ('pending_hr', 'active');