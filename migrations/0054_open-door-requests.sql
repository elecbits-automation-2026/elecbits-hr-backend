CREATE TYPE "public"."open_door_request_status" AS ENUM('requested', 'offered', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "org"."open_door_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"host_id" uuid,
	"concern_id" uuid,
	"preferred_from" date NOT NULL,
	"preferred_to" date NOT NULL,
	"topic" text,
	"status" "open_door_request_status" DEFAULT 'requested' NOT NULL,
	"slot_id" uuid,
	"decline_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_door_requests_target_ck" CHECK ("org"."open_door_requests"."host_id" IS NOT NULL OR "org"."open_door_requests"."concern_id" IS NOT NULL),
	CONSTRAINT "open_door_requests_range_ck" CHECK ("org"."open_door_requests"."preferred_to" >= "org"."open_door_requests"."preferred_from")
);
--> statement-breakpoint
ALTER TABLE "org"."open_door_requests" ADD CONSTRAINT "open_door_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."open_door_requests" ADD CONSTRAINT "open_door_requests_host_id_employees_id_fk" FOREIGN KEY ("host_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."open_door_requests" ADD CONSTRAINT "open_door_requests_concern_id_concerns_id_fk" FOREIGN KEY ("concern_id") REFERENCES "org"."concerns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."open_door_requests" ADD CONSTRAINT "open_door_requests_slot_id_open_door_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "org"."open_door_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."open_door_requests" ADD CONSTRAINT "open_door_requests_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "open_door_requests_status_idx" ON "org"."open_door_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "open_door_requests_employee_idx" ON "org"."open_door_requests" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "open_door_requests_host_idx" ON "org"."open_door_requests" USING btree ("host_id");