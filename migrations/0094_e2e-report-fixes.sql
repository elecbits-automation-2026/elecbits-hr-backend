CREATE TABLE "org"."privacy_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."leave_certificates" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."claim_receipts" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."policy_documents" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."onboarding_task_files" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."training_certificates" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ta"."candidate_cvs" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ta"."offer_letters" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ta"."signed_offer_letters" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."leave_certificates" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "org"."claim_receipts" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "org"."policy_documents" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "org"."onboarding_task_files" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "org"."training_certificates" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "ta"."candidate_cvs" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "ta"."offer_letters" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "ta"."signed_offer_letters" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "org"."privacy_acceptances" ADD CONSTRAINT "privacy_acceptances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_acceptances_employee_version_uq" ON "org"."privacy_acceptances" USING btree ("employee_id","version");--> statement-breakpoint
CREATE INDEX "privacy_acceptances_employee_idx" ON "org"."privacy_acceptances" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_category_serial_uniq" ON "ops"."assets" USING btree ("category_id",lower("serial_no")) WHERE "ops"."assets"."serial_no" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."leave_certificates" ADD CONSTRAINT "leave_certificates_stored_ck" CHECK ("org"."leave_certificates"."data" IS NOT NULL OR "org"."leave_certificates"."drive_file_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "org"."claim_receipts" ADD CONSTRAINT "claim_receipts_stored_ck" CHECK ("org"."claim_receipts"."data" IS NOT NULL OR "org"."claim_receipts"."drive_file_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "org"."policy_documents" ADD CONSTRAINT "policy_documents_stored_ck" CHECK ("org"."policy_documents"."data" IS NOT NULL OR "org"."policy_documents"."drive_file_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "org"."onboarding_task_files" ADD CONSTRAINT "onboarding_task_files_stored_ck" CHECK ("org"."onboarding_task_files"."data" IS NOT NULL OR "org"."onboarding_task_files"."drive_file_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "org"."training_certificates" ADD CONSTRAINT "training_certificates_stored_ck" CHECK ("org"."training_certificates"."data" IS NOT NULL OR "org"."training_certificates"."drive_file_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "ta"."candidate_cvs" ADD CONSTRAINT "candidate_cvs_stored_ck" CHECK ("ta"."candidate_cvs"."data" IS NOT NULL OR "ta"."candidate_cvs"."drive_file_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "ta"."offer_letters" ADD CONSTRAINT "offer_letters_stored_ck" CHECK ("ta"."offer_letters"."data" IS NOT NULL OR "ta"."offer_letters"."drive_file_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "ta"."signed_offer_letters" ADD CONSTRAINT "signed_offer_letters_stored_ck" CHECK ("ta"."signed_offer_letters"."data" IS NOT NULL OR "ta"."signed_offer_letters"."drive_file_id" IS NOT NULL);