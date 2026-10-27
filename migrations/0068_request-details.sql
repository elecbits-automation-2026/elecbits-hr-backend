CREATE TYPE "public"."hiring_priority" AS ENUM('high', 'normal', 'low');--> statement-breakpoint
ALTER TYPE "public"."approver_role" ADD VALUE 'hrbp';--> statement-breakpoint
ALTER TYPE "public"."requisition_status" ADD VALUE 'rejected';--> statement-breakpoint
CREATE SEQUENCE "ta"."requisition_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "request_code" text;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "target_joining_on" date;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "reporting_manager_id" uuid;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "priority" "hiring_priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD COLUMN "employment_type" text;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD CONSTRAINT "requisitions_reporting_manager_id_employees_id_fk" FOREIGN KEY ("reporting_manager_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."requisitions" ADD CONSTRAINT "requisitions_request_code_unique" UNIQUE("request_code");