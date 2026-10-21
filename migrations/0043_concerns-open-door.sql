CREATE TYPE "public"."concern_note_kind" AS ENUM('note', 'reply', 'decision', 'system');--> statement-breakpoint
CREATE TYPE "public"."concern_status" AS ENUM('open', 'acknowledged', 'investigating', 'decided', 'resolved', 'closed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."concern_track" AS ENUM('dispute', 'complaint', 'whistleblower');--> statement-breakpoint
CREATE TYPE "public"."open_door_booking_status" AS ENUM('booked', 'done', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TABLE "org"."concern_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concern_id" uuid NOT NULL,
	"author_id" uuid,
	"kind" "concern_note_kind" NOT NULL,
	"level" integer,
	"body" text NOT NULL,
	"visible_to_raiser" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."concerns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"track" "concern_track" NOT NULL,
	"category" text NOT NULL,
	"decision_area" text,
	"subject_employee_id" uuid,
	"related_concern_id" uuid,
	"raised_by" uuid,
	"anonymous" boolean DEFAULT false NOT NULL,
	"follow_up_key_hash" text,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"status" "concern_status" DEFAULT 'open' NOT NULL,
	"level" integer,
	"level_decided_at" timestamp with time zone,
	"level_decided_by" uuid,
	"escalate_by" date,
	"ack_at" timestamp with time zone,
	"ack_by" uuid,
	"due_ack_on" date,
	"due_resolve_on" date,
	"extended_to" date,
	"extension_reason" text,
	"outcome" text,
	"resolution" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concerns_code_unique" UNIQUE("code"),
	CONSTRAINT "concerns_anonymous_ck" CHECK (("org"."concerns"."anonymous" AND "org"."concerns"."raised_by" IS NULL AND "org"."concerns"."follow_up_key_hash" IS NOT NULL) OR (NOT "org"."concerns"."anonymous" AND "org"."concerns"."raised_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "org"."open_door_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"topic" text,
	"status" "open_door_booking_status" DEFAULT 'booked' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."open_door_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"note" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_door_slots_time_ck" CHECK ("org"."open_door_slots"."end_time" > "org"."open_door_slots"."start_time"),
	CONSTRAINT "open_door_slots_capacity_ck" CHECK ("org"."open_door_slots"."capacity" BETWEEN 1 AND 20)
);
--> statement-breakpoint
ALTER TABLE "org"."concern_notes" ADD CONSTRAINT "concern_notes_concern_id_concerns_id_fk" FOREIGN KEY ("concern_id") REFERENCES "org"."concerns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."concern_notes" ADD CONSTRAINT "concern_notes_author_id_employees_id_fk" FOREIGN KEY ("author_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD CONSTRAINT "concerns_subject_employee_id_employees_id_fk" FOREIGN KEY ("subject_employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD CONSTRAINT "concerns_related_concern_id_concerns_id_fk" FOREIGN KEY ("related_concern_id") REFERENCES "org"."concerns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD CONSTRAINT "concerns_raised_by_employees_id_fk" FOREIGN KEY ("raised_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD CONSTRAINT "concerns_level_decided_by_employees_id_fk" FOREIGN KEY ("level_decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."concerns" ADD CONSTRAINT "concerns_ack_by_employees_id_fk" FOREIGN KEY ("ack_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."open_door_bookings" ADD CONSTRAINT "open_door_bookings_slot_id_open_door_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "org"."open_door_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."open_door_bookings" ADD CONSTRAINT "open_door_bookings_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."open_door_slots" ADD CONSTRAINT "open_door_slots_owner_id_employees_id_fk" FOREIGN KEY ("owner_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concern_notes_concern_idx" ON "org"."concern_notes" USING btree ("concern_id","created_at");--> statement-breakpoint
CREATE INDEX "concerns_track_status_idx" ON "org"."concerns" USING btree ("track","status");--> statement-breakpoint
CREATE INDEX "concerns_raised_by_idx" ON "org"."concerns" USING btree ("raised_by");--> statement-breakpoint
CREATE UNIQUE INDEX "open_door_bookings_slot_employee_uq" ON "org"."open_door_bookings" USING btree ("slot_id","employee_id");--> statement-breakpoint
CREATE INDEX "open_door_slots_date_idx" ON "org"."open_door_slots" USING btree ("date");