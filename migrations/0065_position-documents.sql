DROP INDEX "ta"."ta_documents_req_kind_uq";--> statement-breakpoint
ALTER TABLE "ta"."documents" ADD COLUMN "position_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ta"."documents" ADD CONSTRAINT "documents_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "ta"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ta_documents_position_kind_uq" ON "ta"."documents" USING btree ("position_id","kind");