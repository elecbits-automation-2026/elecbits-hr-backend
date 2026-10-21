CREATE TYPE "public"."feedback_type" AS ENUM('appreciation', 'concern');--> statement-breakpoint
CREATE TABLE "org"."feedback_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"type" "feedback_type" NOT NULL,
	"body" text NOT NULL,
	"evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."feedback_notes" ADD CONSTRAINT "feedback_notes_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."feedback_notes" ADD CONSTRAINT "feedback_notes_author_id_employees_id_fk" FOREIGN KEY ("author_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_notes_employee_idx" ON "org"."feedback_notes" USING btree ("employee_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_notes_author_idx" ON "org"."feedback_notes" USING btree ("author_id","created_at");