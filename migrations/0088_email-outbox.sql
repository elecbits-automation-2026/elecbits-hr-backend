CREATE TABLE "ops"."email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid,
	"to_address" text NOT NULL,
	"type" text NOT NULL,
	"subject" text NOT NULL,
	"body" text,
	"link" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "email_outbox_status_chk" CHECK ("ops"."email_outbox"."status" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "ops"."email_outbox" ADD CONSTRAINT "email_outbox_recipient_id_employees_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_dedupe_uq" ON "ops"."email_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "ops"."email_outbox" USING btree ("status","next_attempt_at");