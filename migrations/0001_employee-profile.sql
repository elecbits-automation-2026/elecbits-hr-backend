CREATE TABLE "org"."employee_salary" (
	"employee_id" uuid PRIMARY KEY NOT NULL,
	"ctc" numeric(14, 2),
	"payroll_cost_center" text,
	"salary_currency" text DEFAULT 'INR' NOT NULL,
	"salary_mode" text,
	"pan_number" text,
	"provident_fund_account" text,
	"employee_advance_account" text,
	"bank_name" text,
	"bank_account_no" text,
	"ifsc_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "salutation" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "middle_name" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "designation" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "grade" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "employment_type" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "date_of_joining" date;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "job_applicant" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "confirmation_date" date;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "notice_days" integer;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "offer_date" date;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "contract_end_date" date;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "retirement_date" date;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "personal_email" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "preferred_contact_email" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "unsubscribed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "current_address" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "permanent_address" text;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "expense_approver" uuid;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "shift_request_approver" uuid;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD COLUMN "leave_approver" uuid;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD COLUMN "resignation_letter_date" date;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD COLUMN "exit_interview_held_on" date;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD COLUMN "leave_encashed" boolean;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD COLUMN "relieving_date" date;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD COLUMN "new_workplace" text;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD COLUMN "reason_for_leaving" text;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD COLUMN "feedback" text;--> statement-breakpoint
ALTER TABLE "org"."employee_salary" ADD CONSTRAINT "employee_salary_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD CONSTRAINT "employees_expense_approver_employees_id_fk" FOREIGN KEY ("expense_approver") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD CONSTRAINT "employees_shift_request_approver_employees_id_fk" FOREIGN KEY ("shift_request_approver") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD CONSTRAINT "employees_leave_approver_employees_id_fk" FOREIGN KEY ("leave_approver") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;