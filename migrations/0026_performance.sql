CREATE TABLE "org"."goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"title" text NOT NULL,
	"metric" text,
	"target" text,
	"weight" numeric(5, 1) NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"due_on" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."review_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_cycles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "org"."work_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"note" text NOT NULL,
	"score" integer,
	"feedback" text,
	"kpi_hits" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."goals" ADD CONSTRAINT "goals_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."goals" ADD CONSTRAINT "goals_cycle_id_review_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "org"."review_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."goals" ADD CONSTRAINT "goals_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."work_updates" ADD CONSTRAINT "work_updates_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goals_employee_cycle_idx" ON "org"."goals" USING btree ("employee_id","cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_updates_employee_date_uq" ON "org"."work_updates" USING btree ("employee_id","date");