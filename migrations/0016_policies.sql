CREATE TYPE "public"."policy_category" AS ENUM('conduct', 'handbook', 'performance', 'time', 'culture', 'other');--> statement-breakpoint
CREATE TABLE "org"."policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"category" "policy_category" NOT NULL,
	"version" text NOT NULL,
	"ack_required" boolean DEFAULT true NOT NULL,
	"summary" text,
	"doc_url" text,
	"effective_from" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "org"."policy_acks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"version" text NOT NULL,
	"acked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."policy_acks" ADD CONSTRAINT "policy_acks_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "org"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."policy_acks" ADD CONSTRAINT "policy_acks_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_acks_uq" ON "org"."policy_acks" USING btree ("policy_id","employee_id","version");--> statement-breakpoint
CREATE INDEX "policy_acks_employee_idx" ON "org"."policy_acks" USING btree ("employee_id");