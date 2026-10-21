CREATE TYPE "public"."remote_work_type" AS ENUM('wfh', 'client_visit', 'remote');--> statement-breakpoint
ALTER TABLE "org"."attendance" ADD COLUMN "check_out_lat" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "org"."attendance" ADD COLUMN "check_out_lng" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "org"."wfh_requests" ADD COLUMN "type" "remote_work_type" DEFAULT 'wfh' NOT NULL;