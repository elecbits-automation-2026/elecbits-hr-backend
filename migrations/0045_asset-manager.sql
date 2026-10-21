CREATE TYPE "public"."asset_category_kind" AS ENUM('equipment', 'lab');--> statement-breakpoint
CREATE TYPE "public"."asset_condition" AS ENUM('new', 'good', 'fair', 'damaged');--> statement-breakpoint
CREATE TYPE "public"."asset_incident_kind" AS ENUM('damage', 'loss', 'theft');--> statement-breakpoint
CREATE TYPE "public"."asset_request_status" AS ENUM('open', 'in_progress', 'fulfilled', 'declined');--> statement-breakpoint
CREATE TYPE "public"."asset_request_type" AS ENUM('new', 'upgrade', 'replacement', 'repair', 'return');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('assigned', 'idle', 'in_use_shared', 'needs_repair', 'scrapped', 'gifted', 'lost');--> statement-breakpoint
CREATE TYPE "public"."gate_pass_status" AS ENUM('requested', 'approved', 'declined', 'returned');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_kind" AS ENUM('in', 'issue', 'transfer_out', 'transfer_in', 'adjust');--> statement-breakpoint
CREATE TABLE "ops"."asset_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code_prefix" text NOT NULL,
	"kind" "asset_category_kind" DEFAULT 'equipment' NOT NULL,
	"requires_gate_pass" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_categories_name_unique" UNIQUE("name"),
	CONSTRAINT "asset_categories_code_prefix_unique" UNIQUE("code_prefix")
);
--> statement-breakpoint
CREATE TABLE "ops"."asset_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"employee_id" uuid,
	"zone_id" uuid,
	"status" "asset_status",
	"condition" "asset_condition",
	"due_on" date,
	"prev_due_on" date,
	"note" text,
	"by_employee_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."asset_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"employee_id" uuid,
	"kind" "asset_incident_kind" NOT NULL,
	"description" text NOT NULL,
	"reported_by" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"outcome" text,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."asset_kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"designation" text NOT NULL,
	"category_id" uuid NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."asset_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by" uuid NOT NULL,
	"type" "asset_request_type" NOT NULL,
	"asset_id" uuid,
	"category_id" uuid,
	"note" text,
	"status" "asset_request_status" DEFAULT 'open' NOT NULL,
	"handled_by" uuid,
	"handler_note" text,
	"fulfilled_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_code" text NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid NOT NULL,
	"status" "asset_status" DEFAULT 'idle' NOT NULL,
	"zone_id" uuid NOT NULL,
	"holder_id" uuid,
	"loan_due_on" date,
	"make" text,
	"model" text,
	"serial_no" text,
	"purchased_on" date,
	"purchase_cost" numeric(12, 2),
	"vendor" text,
	"warranty_until" date,
	"condition" "asset_condition" DEFAULT 'good' NOT NULL,
	"notes" text,
	"gifted_to" uuid,
	"disposed_on" date,
	"dispose_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_asset_code_unique" UNIQUE("asset_code"),
	CONSTRAINT "assets_holder_matches_status" CHECK (("ops"."assets"."status" = 'assigned') = ("ops"."assets"."holder_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ops"."gate_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"purpose" text NOT NULL,
	"destination" text NOT NULL,
	"return_on" date NOT NULL,
	"original_return_on" date NOT NULL,
	"disclaimer_accepted_at" timestamp with time zone NOT NULL,
	"status" "gate_pass_status" DEFAULT 'requested' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decline_reason" text,
	"returned_at" timestamp with time zone,
	"returned_confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."stock_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_items_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "ops"."stock_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_levels_qty_non_negative" CHECK ("ops"."stock_levels"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ops"."stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"qty" integer NOT NULL,
	"employee_id" uuid,
	"transfer_id" uuid,
	"note" text,
	"by_employee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."asset_events" ADD CONSTRAINT "asset_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "ops"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_events" ADD CONSTRAINT "asset_events_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_events" ADD CONSTRAINT "asset_events_zone_id_punch_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "org"."punch_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_events" ADD CONSTRAINT "asset_events_by_employee_id_employees_id_fk" FOREIGN KEY ("by_employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_incidents" ADD CONSTRAINT "asset_incidents_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "ops"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_incidents" ADD CONSTRAINT "asset_incidents_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_incidents" ADD CONSTRAINT "asset_incidents_reported_by_employees_id_fk" FOREIGN KEY ("reported_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_incidents" ADD CONSTRAINT "asset_incidents_closed_by_employees_id_fk" FOREIGN KEY ("closed_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_kits" ADD CONSTRAINT "asset_kits_category_id_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "ops"."asset_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_requests" ADD CONSTRAINT "asset_requests_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_requests" ADD CONSTRAINT "asset_requests_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "ops"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_requests" ADD CONSTRAINT "asset_requests_category_id_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "ops"."asset_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_requests" ADD CONSTRAINT "asset_requests_handled_by_employees_id_fk" FOREIGN KEY ("handled_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_requests" ADD CONSTRAINT "asset_requests_fulfilled_asset_id_assets_id_fk" FOREIGN KEY ("fulfilled_asset_id") REFERENCES "ops"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."assets" ADD CONSTRAINT "assets_category_id_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "ops"."asset_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."assets" ADD CONSTRAINT "assets_zone_id_punch_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "org"."punch_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."assets" ADD CONSTRAINT "assets_holder_id_employees_id_fk" FOREIGN KEY ("holder_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."assets" ADD CONSTRAINT "assets_gifted_to_employees_id_fk" FOREIGN KEY ("gifted_to") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."gate_passes" ADD CONSTRAINT "gate_passes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "ops"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."gate_passes" ADD CONSTRAINT "gate_passes_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."gate_passes" ADD CONSTRAINT "gate_passes_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."gate_passes" ADD CONSTRAINT "gate_passes_returned_confirmed_by_employees_id_fk" FOREIGN KEY ("returned_confirmed_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stock_levels" ADD CONSTRAINT "stock_levels_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "ops"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stock_levels" ADD CONSTRAINT "stock_levels_zone_id_punch_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "org"."punch_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stock_movements" ADD CONSTRAINT "stock_movements_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "ops"."stock_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stock_movements" ADD CONSTRAINT "stock_movements_zone_id_punch_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "org"."punch_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stock_movements" ADD CONSTRAINT "stock_movements_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stock_movements" ADD CONSTRAINT "stock_movements_by_employee_id_employees_id_fk" FOREIGN KEY ("by_employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_events_asset_idx" ON "ops"."asset_events" USING btree ("asset_id","at");--> statement-breakpoint
CREATE INDEX "asset_incidents_asset_idx" ON "ops"."asset_incidents" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_kits_designation_category_uq" ON "ops"."asset_kits" USING btree ("designation","category_id");--> statement-breakpoint
CREATE INDEX "asset_requests_requested_by_idx" ON "ops"."asset_requests" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "assets_holder_idx" ON "ops"."assets" USING btree ("holder_id");--> statement-breakpoint
CREATE INDEX "assets_zone_idx" ON "ops"."assets" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "gate_passes_requested_by_idx" ON "ops"."gate_passes" USING btree ("requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_passes_one_open_uq" ON "ops"."gate_passes" USING btree ("asset_id") WHERE status IN ('requested', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "stock_levels_item_zone_uq" ON "ops"."stock_levels" USING btree ("item_id","zone_id");--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "ops"."stock_movements" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_employee_idx" ON "ops"."stock_movements" USING btree ("employee_id");