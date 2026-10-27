CREATE TYPE "public"."application_stage" AS ENUM('sourced', 'shortlisted', 'interviewing', 'interviewed', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."candidate_source" AS ENUM('naukri', 'linkedin', 'internshala', 'careers_page', 'agency', 'campus', 'social', 'referral', 'internal', 'other');--> statement-breakpoint
CREATE TYPE "public"."interview_recommendation" AS ENUM('hire', 'no_hire');--> statement-breakpoint
ALTER TYPE "public"."position_status" ADD VALUE 'interviewing' BEFORE 'filled';--> statement-breakpoint
CREATE TABLE "ta"."applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"stage" "application_stage" DEFAULT 'sourced' NOT NULL,
	"shortlisted_by" uuid,
	"shortlisted_at" timestamp with time zone,
	"interviews_started_at" timestamp with time zone,
	"outcome_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ta"."candidate_cvs" (
	"candidate_id" uuid PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ta"."candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"source" "candidate_source" NOT NULL,
	"referred_by" uuid,
	"notes" text,
	"consent_at" timestamp with time zone NOT NULL,
	"retain_until" date NOT NULL,
	"anonymised_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ta"."interview_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"round" "interview_round" NOT NULL,
	"interviewer_id" uuid NOT NULL,
	"scores" jsonb NOT NULL,
	"recommendation" "interview_recommendation" NOT NULL,
	"notes" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD CONSTRAINT "applications_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "ta"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD CONSTRAINT "applications_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "ta"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD CONSTRAINT "applications_shortlisted_by_employees_id_fk" FOREIGN KEY ("shortlisted_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD CONSTRAINT "applications_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."candidate_cvs" ADD CONSTRAINT "candidate_cvs_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "ta"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."candidate_cvs" ADD CONSTRAINT "candidate_cvs_uploaded_by_employees_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD CONSTRAINT "candidates_referred_by_employees_id_fk" FOREIGN KEY ("referred_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."candidates" ADD CONSTRAINT "candidates_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."interview_scores" ADD CONSTRAINT "interview_scores_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "ta"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."interview_scores" ADD CONSTRAINT "interview_scores_interviewer_id_employees_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "applications_candidate_position_uq" ON "ta"."applications" USING btree ("candidate_id","position_id");--> statement-breakpoint
CREATE INDEX "applications_position_idx" ON "ta"."applications" USING btree ("position_id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_email_uq" ON "ta"."candidates" USING btree ("email") WHERE "ta"."candidates"."email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "candidates_phone_idx" ON "ta"."candidates" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_scores_app_round_uq" ON "ta"."interview_scores" USING btree ("application_id","round");