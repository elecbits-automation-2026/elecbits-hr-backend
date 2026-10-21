CREATE TABLE "org"."career_level_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"from_level" "level" NOT NULL,
	"to_level" "level" NOT NULL,
	"changed_by" uuid,
	"track_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."career_track_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."career_level_changes" ADD CONSTRAINT "career_level_changes_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."career_level_changes" ADD CONSTRAINT "career_level_changes_changed_by_employees_id_fk" FOREIGN KEY ("changed_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."career_level_changes" ADD CONSTRAINT "career_level_changes_track_id_career_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "org"."career_tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."career_track_notes" ADD CONSTRAINT "career_track_notes_track_id_career_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "org"."career_tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."career_track_notes" ADD CONSTRAINT "career_track_notes_author_id_employees_id_fk" FOREIGN KEY ("author_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "career_level_changes_employee_idx" ON "org"."career_level_changes" USING btree ("employee_id","created_at");--> statement-breakpoint
CREATE INDEX "career_track_notes_track_idx" ON "org"."career_track_notes" USING btree ("track_id","created_at");