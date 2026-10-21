CREATE TABLE "ops"."reminders_sent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."scheduled_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"run_key" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" jsonb,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "ops"."reminders_sent" ADD CONSTRAINT "reminders_sent_recipient_id_employees_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminders_sent_lookup_idx" ON "ops"."reminders_sent" USING btree ("kind","subject_id","recipient_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_job_runs_job_key_uq" ON "ops"."scheduled_job_runs" USING btree ("job","run_key");--> statement-breakpoint
CREATE INDEX "scheduled_job_runs_started_idx" ON "ops"."scheduled_job_runs" USING btree ("started_at");