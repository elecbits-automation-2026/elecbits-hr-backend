CREATE TYPE "public"."bgv_status" AS ENUM('not_started', 'in_progress', 'clear', 'failed');--> statement-breakpoint
ALTER TYPE "public"."application_stage" ADD VALUE 'decision' BEFORE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."application_stage" ADD VALUE 'selected' BEFORE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."application_stage" ADD VALUE 'offered' BEFORE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."application_stage" ADD VALUE 'hired' BEFORE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."application_stage" ADD VALUE 'offer_declined' BEFORE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."application_stage" ADD VALUE 'offer_withdrawn' BEFORE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."application_stage" ADD VALUE 'no_show' BEFORE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."position_status" ADD VALUE 'offer' BEFORE 'filled';--> statement-breakpoint
CREATE TABLE "ta"."offer_letters" (
	"application_id" uuid PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "decision_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "selected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "offered_ctc" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "joining_date" date;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "offered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "bgv_status" "bgv_status" DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "bgv_notes" text;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "bgv_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "employee_id" uuid;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "hired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "urgent_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "ta"."offer_letters" ADD CONSTRAINT "offer_letters_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "ta"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."offer_letters" ADD CONSTRAINT "offer_letters_uploaded_by_employees_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD CONSTRAINT "applications_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD CONSTRAINT "requisitions_urgent_requested_by_employees_id_fk" FOREIGN KEY ("urgent_requested_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;