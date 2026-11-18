CREATE TYPE "public"."concern_severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD COLUMN "owner_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD COLUMN "severity" "concern_severity";--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD CONSTRAINT "concerns_owner_id_employees_id_fk" FOREIGN KEY ("owner_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;