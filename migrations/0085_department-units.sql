CREATE TYPE "public"."unit_kind" AS ENUM('division', 'department', 'chapter');--> statement-breakpoint
CREATE TABLE "org"."department_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."departments" ADD COLUMN "kind" "unit_kind" DEFAULT 'department' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."department_memberships" ADD CONSTRAINT "department_memberships_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "org"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."department_memberships" ADD CONSTRAINT "department_memberships_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."department_memberships" ADD CONSTRAINT "department_memberships_added_by_employees_id_fk" FOREIGN KEY ("added_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "department_memberships_uq" ON "org"."department_memberships" USING btree ("department_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "department_memberships_lead_uq" ON "org"."department_memberships" USING btree ("department_id") WHERE "org"."department_memberships"."is_lead";--> statement-breakpoint
CREATE INDEX "department_memberships_employee_idx" ON "org"."department_memberships" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_name_uq" ON "org"."departments" USING btree (lower("name"));