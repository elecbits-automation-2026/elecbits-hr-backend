CREATE TYPE "public"."probation_outcome" AS ENUM('confirm', 'end');--> statement-breakpoint
CREATE TYPE "public"."probation_status" AS ENUM('pending', 'recommended', 'confirmed', 'ended');--> statement-breakpoint
CREATE TABLE "org"."probation_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"due_on" date NOT NULL,
	"status" "probation_status" DEFAULT 'pending' NOT NULL,
	"recommendation" "probation_outcome",
	"recommendation_note" text,
	"recommended_by" uuid,
	"recommended_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"auto_confirmed" boolean DEFAULT false NOT NULL,
	"exit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."probation_reviews" ADD CONSTRAINT "probation_reviews_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."probation_reviews" ADD CONSTRAINT "probation_reviews_recommended_by_employees_id_fk" FOREIGN KEY ("recommended_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."probation_reviews" ADD CONSTRAINT "probation_reviews_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."probation_reviews" ADD CONSTRAINT "probation_reviews_exit_id_exits_id_fk" FOREIGN KEY ("exit_id") REFERENCES "org"."exits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "probation_reviews_employee_uq" ON "org"."probation_reviews" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "probation_reviews_status_idx" ON "org"."probation_reviews" USING btree ("status");