ALTER TABLE "org"."employees" ADD COLUMN "claim_token_hash" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "claim_token_expires_at" timestamp with time zone;