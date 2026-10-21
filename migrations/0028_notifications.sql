CREATE TABLE "org"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "org"."notifications" ADD CONSTRAINT "notifications_recipient_id_employees_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "org"."notifications" USING btree ("recipient_id","created_at");