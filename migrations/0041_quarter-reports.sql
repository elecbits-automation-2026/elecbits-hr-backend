CREATE TABLE "org"."quarter_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"rm_id" uuid,
	"department_name" text,
	"goals" jsonb NOT NULL,
	"fundamental" integer,
	"corporate" integer,
	"general" integer,
	"computed_score" integer,
	"computed_band" text,
	"final_score" integer,
	"final_band" text,
	"adjust_reason" text,
	"adjusted_by" uuid,
	"adjusted_at" timestamp with time zone,
	"updates" jsonb NOT NULL,
	"attendance" jsonb NOT NULL,
	"recognitions" integer DEFAULT 0 NOT NULL,
	"feedback" jsonb NOT NULL,
	"at_risk_goals" integer DEFAULT 0 NOT NULL,
	"pip_candidate" boolean DEFAULT false NOT NULL,
	"appraisal_eligible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."review_cycles" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org"."review_cycles" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "org"."quarter_reports" ADD CONSTRAINT "quarter_reports_cycle_id_review_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "org"."review_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."quarter_reports" ADD CONSTRAINT "quarter_reports_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."quarter_reports" ADD CONSTRAINT "quarter_reports_rm_id_employees_id_fk" FOREIGN KEY ("rm_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."quarter_reports" ADD CONSTRAINT "quarter_reports_adjusted_by_employees_id_fk" FOREIGN KEY ("adjusted_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quarter_reports_cycle_employee_uq" ON "org"."quarter_reports" USING btree ("cycle_id","employee_id");--> statement-breakpoint
CREATE INDEX "quarter_reports_rm_idx" ON "org"."quarter_reports" USING btree ("cycle_id","rm_id");--> statement-breakpoint
ALTER TABLE "org"."review_cycles" ADD CONSTRAINT "review_cycles_closed_by_employees_id_fk" FOREIGN KEY ("closed_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;