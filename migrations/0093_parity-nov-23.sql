CREATE TYPE "public"."open_door_slot_type" AS ENUM('hr_open_door', 'dept_head', 'skip_level');--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD COLUMN "ai_category" text;--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD COLUMN "ai_severity" "concern_severity";--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD COLUMN "ai_summary" text;--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD COLUMN "ai_suggested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org"."open_door_slots" ADD COLUMN "slot_type" "open_door_slot_type" DEFAULT 'hr_open_door' NOT NULL;