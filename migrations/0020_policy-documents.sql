CREATE TABLE "org"."policy_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_documents_policy_id_unique" UNIQUE("policy_id")
);
--> statement-breakpoint
ALTER TABLE "org"."policy_documents" ADD CONSTRAINT "policy_documents_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "org"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."policy_documents" ADD CONSTRAINT "policy_documents_uploaded_by_employees_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;