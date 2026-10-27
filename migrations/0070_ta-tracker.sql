CREATE TYPE "public"."ta_activity_kind" AS ENUM('call', 'email', 'whatsapp', 'meeting');--> statement-breakpoint
CREATE TYPE "public"."ta_activity_outcome" AS ENUM('connected', 'no_answer', 'busy', 'wrong_number', 'other');--> statement-breakpoint
CREATE SEQUENCE "ta"."candidate_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "ta"."source_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"channel" "candidate_source" NOT NULL,
	"activated_on" date NOT NULL,
	"spoc_id" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ta"."activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" "ta_activity_kind" NOT NULL,
	"outcome" "ta_activity_outcome" NOT NULL,
	"notes" text,
	"happened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "next_action" text;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "next_action_owner_id" uuid;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "next_action_due" date;--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD COLUMN "candidate_code" text;--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD COLUMN "current_company" text;--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD COLUMN "designation" text;--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD COLUMN "notice_days" integer;--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD COLUMN "current_ctc" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD COLUMN "expected_ctc" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD COLUMN "available_from" date;--> statement-breakpoint
ALTER TABLE "ta"."positions" ADD COLUMN "priority" "hiring_priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "ta"."positions" ADD COLUMN "expected_close_on" date;--> statement-breakpoint
ALTER TABLE "ta"."source_activations" ADD CONSTRAINT "source_activations_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "ta"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."source_activations" ADD CONSTRAINT "source_activations_spoc_id_employees_id_fk" FOREIGN KEY ("spoc_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."activities" ADD CONSTRAINT "activities_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "ta"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."activities" ADD CONSTRAINT "activities_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_activations_position_idx" ON "ta"."source_activations" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "activities_application_idx" ON "ta"."activities" USING btree ("application_id","happened_at");--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD CONSTRAINT "applications_next_action_owner_id_employees_id_fk" FOREIGN KEY ("next_action_owner_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD CONSTRAINT "candidates_candidate_code_unique" UNIQUE("candidate_code");