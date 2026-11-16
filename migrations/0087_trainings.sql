CREATE TYPE "public"."training_status" AS ENUM('assigned', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."training_stream" AS ENUM('compliance', 'leadership', 'company', 'functional');--> statement-breakpoint
CREATE TABLE "org"."training_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"training_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_certificates_training_id_unique" UNIQUE("training_id")
);
--> statement-breakpoint
CREATE TABLE "org"."trainings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"title" text NOT NULL,
	"stream" "training_stream" NOT NULL,
	"description" text,
	"link" text,
	"due_on" date,
	"status" "training_status" DEFAULT 'assigned' NOT NULL,
	"batch_id" uuid,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"completion_note" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "org"."training_certificates" ADD CONSTRAINT "training_certificates_training_id_trainings_id_fk" FOREIGN KEY ("training_id") REFERENCES "org"."trainings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."training_certificates" ADD CONSTRAINT "training_certificates_uploaded_by_employees_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."trainings" ADD CONSTRAINT "trainings_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."trainings" ADD CONSTRAINT "trainings_assigned_by_employees_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."trainings" ADD CONSTRAINT "trainings_cancelled_by_employees_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trainings_employee_idx" ON "org"."trainings" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "trainings_status_due_idx" ON "org"."trainings" USING btree ("status","due_on");