CREATE TYPE "public"."recognition_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TYPE "public"."recognition_type" AS ENUM('spot', 'owner', 'customer', 'innov', 'team');--> statement-breakpoint
CREATE TABLE "org"."recognitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"type" "recognition_type" NOT NULL,
	"citation" text NOT NULL,
	"value_inr" integer NOT NULL,
	"nominated_by" uuid NOT NULL,
	"status" "recognition_status" DEFAULT 'pending' NOT NULL,
	"cycle" text,
	"decided_by" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."recognitions" ADD CONSTRAINT "recognitions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."recognitions" ADD CONSTRAINT "recognitions_nominated_by_employees_id_fk" FOREIGN KEY ("nominated_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."recognitions" ADD CONSTRAINT "recognitions_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recognitions_employee_idx" ON "org"."recognitions" USING btree ("employee_id","created_at");--> statement-breakpoint
CREATE INDEX "recognitions_status_idx" ON "org"."recognitions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recognitions_type_cycle_idx" ON "org"."recognitions" USING btree ("type","cycle");