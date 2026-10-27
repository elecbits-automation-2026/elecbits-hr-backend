CREATE TYPE "public"."candidate_doc_status" AS ENUM('requested', 'received', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('draft', 'pending', 'approved', 'returned');--> statement-breakpoint
ALTER TYPE "public"."application_stage" ADD VALUE 'joined';--> statement-breakpoint
CREATE TABLE "ta"."application_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "candidate_doc_status" DEFAULT 'requested' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ta"."signed_offer_letters" (
	"application_id" uuid PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "offer_terms" text;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "offer_status" "offer_status";--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "offer_return_reason" text;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "offer_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "offer_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "folder_link" text;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "joined_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD COLUMN "joined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ta"."application_documents" ADD CONSTRAINT "application_documents_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "ta"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."application_documents" ADD CONSTRAINT "application_documents_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."signed_offer_letters" ADD CONSTRAINT "signed_offer_letters_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "ta"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."signed_offer_letters" ADD CONSTRAINT "signed_offer_letters_uploaded_by_employees_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_documents_uq" ON "ta"."application_documents" USING btree ("application_id","name");--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD CONSTRAINT "applications_offer_approved_by_employees_id_fk" FOREIGN KEY ("offer_approved_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."applications" ADD CONSTRAINT "applications_joined_confirmed_by_employees_id_fk" FOREIGN KEY ("joined_confirmed_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;