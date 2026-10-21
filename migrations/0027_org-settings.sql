CREATE TABLE "org"."org_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."org_settings" ADD CONSTRAINT "org_settings_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;