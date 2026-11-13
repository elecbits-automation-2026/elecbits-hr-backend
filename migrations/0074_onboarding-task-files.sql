CREATE TABLE "org"."onboarding_task_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_task_files_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
ALTER TABLE "org"."onboarding_task_files" ADD CONSTRAINT "onboarding_task_files_task_id_onboarding_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "org"."onboarding_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."onboarding_task_files" ADD CONSTRAINT "onboarding_task_files_uploaded_by_employees_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;