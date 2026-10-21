CREATE TABLE "org"."claim_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_receipts_claim_id_unique" UNIQUE("claim_id")
);
--> statement-breakpoint
ALTER TABLE "org"."claim_receipts" ADD CONSTRAINT "claim_receipts_claim_id_reimbursement_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "org"."reimbursement_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."claim_receipts" ADD CONSTRAINT "claim_receipts_uploaded_by_employees_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;