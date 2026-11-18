ALTER TABLE "org"."employee_salary" ADD COLUMN "esic_ip_number" text;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "esic_employee" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "esic_employer" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "esic_eligible" boolean;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "esic_period_start" date;