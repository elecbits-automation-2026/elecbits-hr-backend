CREATE TYPE "public"."career_track_status" AS ENUM('open', 'met', 'closed');--> statement-breakpoint
CREATE TABLE "org"."career_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"band_code" "level" NOT NULL,
	"target_band" "level" NOT NULL,
	"note" text,
	"opened_by" uuid NOT NULL,
	"status" "career_track_status" DEFAULT 'open' NOT NULL,
	"closed_by" uuid,
	"close_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."career_tracks" ADD CONSTRAINT "career_tracks_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."career_tracks" ADD CONSTRAINT "career_tracks_opened_by_employees_id_fk" FOREIGN KEY ("opened_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."career_tracks" ADD CONSTRAINT "career_tracks_closed_by_employees_id_fk" FOREIGN KEY ("closed_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "career_tracks_open_uq" ON "org"."career_tracks" USING btree ("employee_id") WHERE "org"."career_tracks"."status" = 'open';