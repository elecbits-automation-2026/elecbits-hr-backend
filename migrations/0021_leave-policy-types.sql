ALTER TYPE "public"."leave_type" ADD VALUE 'menstrual';--> statement-breakpoint
ALTER TYPE "public"."leave_type" ADD VALUE 'vacation_family';--> statement-breakpoint
ALTER TYPE "public"."leave_type" ADD VALUE 'compassionate';--> statement-breakpoint
ALTER TABLE "org"."leave_balances" ADD COLUMN "opening" numeric(5, 1) DEFAULT '0' NOT NULL;