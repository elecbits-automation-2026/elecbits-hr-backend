ALTER TABLE "org"."policies" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org"."policies" ADD COLUMN "retired_by" uuid;--> statement-breakpoint
ALTER TABLE "org"."policies" ADD CONSTRAINT "policies_retired_by_employees_id_fk" FOREIGN KEY ("retired_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;