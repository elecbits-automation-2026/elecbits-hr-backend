ALTER TABLE "org"."payslips" ADD COLUMN "lta" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "pf_employer" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "pt_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "health_insurance" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "cnps_employer" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "reimbursement" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "performance_bonus" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "other_bonus" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "leave_encashment" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "advance" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."payslips" ADD COLUMN "final_pay" numeric(12, 2) DEFAULT '0' NOT NULL;