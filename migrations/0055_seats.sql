CREATE TYPE "public"."seat" AS ENUM('dept_head', 'vp_hr_head', 'ta_head');--> statement-breakpoint
CREATE TABLE "org"."seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seat" "seat" NOT NULL,
	"department_id" uuid,
	"employee_id" uuid NOT NULL,
	"acting" boolean DEFAULT false NOT NULL,
	"assigned_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"ended_by" uuid,
	CONSTRAINT "seats_department_ck" CHECK (("org"."seats"."seat" = 'dept_head') = ("org"."seats"."department_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "org"."seats" ADD CONSTRAINT "seats_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "org"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."seats" ADD CONSTRAINT "seats_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."seats" ADD CONSTRAINT "seats_assigned_by_employees_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."seats" ADD CONSTRAINT "seats_ended_by_employees_id_fk" FOREIGN KEY ("ended_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seats_open_dept_uq" ON "org"."seats" USING btree ("seat","department_id") WHERE "org"."seats"."ended_at" IS NULL AND "org"."seats"."department_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seats_open_org_uq" ON "org"."seats" USING btree ("seat") WHERE "org"."seats"."ended_at" IS NULL AND "org"."seats"."department_id" IS NULL;--> statement-breakpoint
CREATE INDEX "seats_employee_idx" ON "org"."seats" USING btree ("employee_id");