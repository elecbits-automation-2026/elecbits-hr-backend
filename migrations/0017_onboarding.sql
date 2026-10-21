CREATE TYPE "public"."onboarding_phase" AS ENUM('before_start', 'week_one', 'first_30');--> statement-breakpoint
CREATE TYPE "public"."onboarding_status" AS ENUM('open', 'done');--> statement-breakpoint
CREATE TYPE "public"."onboarding_task_owner" AS ENUM('employee', 'hr', 'manager', 'admin');--> statement-breakpoint
CREATE TABLE "org"."onboarding_journeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"started_on" date NOT NULL,
	"due_on" date NOT NULL,
	"status" "onboarding_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_journeys_employee_id_unique" UNIQUE("employee_id")
);
--> statement-breakpoint
CREATE TABLE "org"."onboarding_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journey_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"phase" "onboarding_phase" NOT NULL,
	"task_key" text NOT NULL,
	"title" text NOT NULL,
	"owner" "onboarding_task_owner" NOT NULL,
	"policy_code" text,
	"done_at" timestamp with time zone,
	"done_by" uuid
);
--> statement-breakpoint
ALTER TABLE "org"."onboarding_journeys" ADD CONSTRAINT "onboarding_journeys_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_journey_id_onboarding_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "org"."onboarding_journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_done_by_employees_id_fk" FOREIGN KEY ("done_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_tasks_uq" ON "org"."onboarding_tasks" USING btree ("journey_id","task_key");--> statement-breakpoint
CREATE INDEX "onboarding_tasks_journey_idx" ON "org"."onboarding_tasks" USING btree ("journey_id");