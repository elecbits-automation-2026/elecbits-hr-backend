ALTER TABLE "ta"."approvals" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."approver_role";--> statement-breakpoint
CREATE TYPE "public"."approver_role" AS ENUM('ta_head', 'hr_head', 'admin');--> statement-breakpoint
ALTER TABLE "ta"."approvals" ALTER COLUMN "role" SET DATA TYPE "public"."approver_role" USING "role"::"public"."approver_role";