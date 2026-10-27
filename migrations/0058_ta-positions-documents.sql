CREATE TYPE "public"."position_status" AS ENUM('awaiting_docs', 'open', 'filled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ta_document_kind" AS ENUM('jd', 'scorecard');--> statement-breakpoint
CREATE TYPE "public"."ta_document_status" AS ENUM('draft', 'in_review', 'returned', 'approved');--> statement-breakpoint
ALTER TYPE "public"."approver_role" ADD VALUE 'dept_head';--> statement-breakpoint
CREATE TABLE "ta"."positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requisition_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" "position_status" DEFAULT 'awaiting_docs' NOT NULL,
	"recruiter_id" uuid,
	"opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ta"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requisition_id" uuid NOT NULL,
	"kind" "ta_document_kind" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "ta_document_status" DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"written_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"return_reason" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."goals" ADD COLUMN "position_id" uuid;--> statement-breakpoint
ALTER TABLE "ta"."positions" ADD CONSTRAINT "positions_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "ta"."requisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."positions" ADD CONSTRAINT "positions_recruiter_id_employees_id_fk" FOREIGN KEY ("recruiter_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."documents" ADD CONSTRAINT "documents_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "ta"."requisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ta"."documents" ADD CONSTRAINT "documents_written_by_employees_id_fk" FOREIGN KEY ("written_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "positions_req_number_uq" ON "ta"."positions" USING btree ("requisition_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "ta_documents_req_kind_uq" ON "ta"."documents" USING btree ("requisition_id","kind");--> statement-breakpoint
ALTER TABLE "org"."goals" ADD CONSTRAINT "goals_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "ta"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goals_position_cycle_uq" ON "org"."goals" USING btree ("position_id","cycle_id") WHERE "org"."goals"."position_id" IS NOT NULL;