CREATE TYPE "public"."interview_mode" AS ENUM('in_person', 'video', 'phone');--> statement-breakpoint
CREATE TYPE "public"."interview_slot_status" AS ENUM('scheduled', 'done', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TABLE "ta"."interview_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"round" "interview_round" NOT NULL,
	"interviewer_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_min" integer DEFAULT 60 NOT NULL,
	"mode" "interview_mode" NOT NULL,
	"location" text,
	"status" "interview_slot_status" DEFAULT 'scheduled' NOT NULL,
	"end_reason" text,
	"scheduled_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_slots_duration_ck" CHECK ("ta"."interview_slots"."duration_min" BETWEEN 15 AND 480)
);
--> statement-breakpoint
ALTER TABLE "ta"."interview_slots" ADD CONSTRAINT "interview_slots_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "ta"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."interview_slots" ADD CONSTRAINT "interview_slots_interviewer_id_employees_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."interview_slots" ADD CONSTRAINT "interview_slots_scheduled_by_employees_id_fk" FOREIGN KEY ("scheduled_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interview_slots_live_uq" ON "ta"."interview_slots" USING btree ("application_id","round") WHERE "ta"."interview_slots"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "interview_slots_interviewer_idx" ON "ta"."interview_slots" USING btree ("interviewer_id","starts_at");