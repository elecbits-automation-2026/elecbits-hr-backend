ALTER TABLE "org"."attendance" ADD COLUMN "regularized_by" uuid;--> statement-breakpoint
ALTER TABLE "org"."attendance" ADD COLUMN "regularized_reason" text;--> statement-breakpoint
ALTER TABLE "org"."attendance" ADD CONSTRAINT "attendance_regularized_by_employees_id_fk" FOREIGN KEY ("regularized_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;