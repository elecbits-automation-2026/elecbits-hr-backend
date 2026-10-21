CREATE SCHEMA "org";
--> statement-breakpoint
CREATE SCHEMA "access";
--> statement-breakpoint
CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE TYPE "public"."action" AS ENUM('create', 'read', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."asset_request_status" AS ENUM('open', 'in_progress', 'fulfilled', 'declined');--> statement-breakpoint
CREATE TYPE "public"."asset_request_type" AS ENUM('new', 'replacement', 'repair', 'return');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('in_service', 'off_premises', 'in_repair', 'retired');--> statement-breakpoint
CREATE TYPE "public"."clearance_status" AS ENUM('pending', 'cleared', 'auto_cleared');--> statement-breakpoint
CREATE TYPE "public"."custodian_type" AS ENUM('employee', 'location');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('invited', 'active', 'exiting', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."exit_status" AS ENUM('initiated', 'clearing', 'cleared', 'closed');--> statement-breakpoint
CREATE TYPE "public"."gate_pass_status" AS ENUM('requested', 'approved', 'declined', 'checked_out', 'returned', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."level" AS ENUM('L1', 'L2', 'L3', 'L4', 'L5', 'L6');--> statement-breakpoint
CREATE TYPE "public"."portal" AS ENUM('ta', 'hrbp', 'pr', 'ops');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('pending', 'approved', 'approved_narrower', 'declined', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."scope" AS ENUM('me', 'team_direct', 'team', 'dept', 'org');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"employee_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_employee_id_unique" UNIQUE("employee_id")
);
--> statement-breakpoint
CREATE TABLE "org"."departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"employee_code" text NOT NULL,
	"email" text NOT NULL,
	"department_id" uuid,
	"level" "level" NOT NULL,
	"reports_to" uuid,
	"status" "employee_status" DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_employee_code_unique" UNIQUE("employee_code"),
	CONSTRAINT "employees_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "access"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access"."batch_assign_rights" (
	"batch_id" uuid NOT NULL,
	"assignable_batch_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access"."batch_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"action" "action" NOT NULL,
	"scope" "scope" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access"."batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batches_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "access"."employee_batches" (
	"employee_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access"."individual_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"action" "action" NOT NULL,
	"scope" "scope" NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access"."modules" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_key" text
);
--> statement-breakpoint
CREATE TABLE "access"."org_owner" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"employee_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_owner_only_row" CHECK ("access"."org_owner"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "access"."superadmins" (
	"employee_id" uuid PRIMARY KEY NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access"."grant_request_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"batch_id" uuid,
	"module_key" text,
	"action" "action",
	"scope" "scope",
	"granted" text DEFAULT 'requested' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access"."grant_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"note" text,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."asset_custody" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"custodian_type" "custodian_type" NOT NULL,
	"custodian_employee_id" uuid,
	"custodian_location_id" uuid,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."asset_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by" uuid NOT NULL,
	"type" "asset_request_type" NOT NULL,
	"asset_id" uuid,
	"note" text,
	"status" "asset_request_status" DEFAULT 'open' NOT NULL,
	"handled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_code" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"status" "asset_status" DEFAULT 'in_service' NOT NULL,
	"custodian_type" "custodian_type" NOT NULL,
	"custodian_employee_id" uuid,
	"custodian_location_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_asset_code_unique" UNIQUE("asset_code")
);
--> statement-breakpoint
CREATE TABLE "ops"."gate_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"purpose" text NOT NULL,
	"destination" text NOT NULL,
	"expected_return_at" timestamp with time zone NOT NULL,
	"status" "gate_pass_status" DEFAULT 'requested' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."exit_clearances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exit_id" uuid NOT NULL,
	"portal" "portal" NOT NULL,
	"status" "clearance_status" DEFAULT 'pending' NOT NULL,
	"cleared_by" uuid,
	"note" text,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org"."exits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"last_working_day" date NOT NULL,
	"initiated_by" uuid NOT NULL,
	"rm_acknowledged_at" timestamp with time zone,
	"status" "exit_status" DEFAULT 'initiated' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."departments" ADD CONSTRAINT "departments_parent_id_departments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "org"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD CONSTRAINT "employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "org"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."employees" ADD CONSTRAINT "employees_reports_to_employees_id_fk" FOREIGN KEY ("reports_to") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."batch_assign_rights" ADD CONSTRAINT "batch_assign_rights_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "access"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."batch_assign_rights" ADD CONSTRAINT "batch_assign_rights_assignable_batch_id_batches_id_fk" FOREIGN KEY ("assignable_batch_id") REFERENCES "access"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."batch_grants" ADD CONSTRAINT "batch_grants_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "access"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."batch_grants" ADD CONSTRAINT "batch_grants_module_key_modules_key_fk" FOREIGN KEY ("module_key") REFERENCES "access"."modules"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."employee_batches" ADD CONSTRAINT "employee_batches_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."employee_batches" ADD CONSTRAINT "employee_batches_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "access"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."employee_batches" ADD CONSTRAINT "employee_batches_granted_by_employees_id_fk" FOREIGN KEY ("granted_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."individual_grants" ADD CONSTRAINT "individual_grants_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."individual_grants" ADD CONSTRAINT "individual_grants_module_key_modules_key_fk" FOREIGN KEY ("module_key") REFERENCES "access"."modules"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."individual_grants" ADD CONSTRAINT "individual_grants_granted_by_employees_id_fk" FOREIGN KEY ("granted_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."modules" ADD CONSTRAINT "modules_parent_key_modules_key_fk" FOREIGN KEY ("parent_key") REFERENCES "access"."modules"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."org_owner" ADD CONSTRAINT "org_owner_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."superadmins" ADD CONSTRAINT "superadmins_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."superadmins" ADD CONSTRAINT "superadmins_granted_by_employees_id_fk" FOREIGN KEY ("granted_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."grant_request_items" ADD CONSTRAINT "grant_request_items_request_id_grant_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "access"."grant_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."grant_request_items" ADD CONSTRAINT "grant_request_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "access"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."grant_requests" ADD CONSTRAINT "grant_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."grant_requests" ADD CONSTRAINT "grant_requests_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access"."grant_requests" ADD CONSTRAINT "grant_requests_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_custody" ADD CONSTRAINT "asset_custody_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "ops"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_custody" ADD CONSTRAINT "asset_custody_custodian_employee_id_employees_id_fk" FOREIGN KEY ("custodian_employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_custody" ADD CONSTRAINT "asset_custody_custodian_location_id_locations_id_fk" FOREIGN KEY ("custodian_location_id") REFERENCES "ops"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_custody" ADD CONSTRAINT "asset_custody_assigned_by_employees_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_requests" ADD CONSTRAINT "asset_requests_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_requests" ADD CONSTRAINT "asset_requests_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "ops"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."asset_requests" ADD CONSTRAINT "asset_requests_handled_by_employees_id_fk" FOREIGN KEY ("handled_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."assets" ADD CONSTRAINT "assets_custodian_employee_id_employees_id_fk" FOREIGN KEY ("custodian_employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."assets" ADD CONSTRAINT "assets_custodian_location_id_locations_id_fk" FOREIGN KEY ("custodian_location_id") REFERENCES "ops"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."gate_passes" ADD CONSTRAINT "gate_passes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "ops"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."gate_passes" ADD CONSTRAINT "gate_passes_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."gate_passes" ADD CONSTRAINT "gate_passes_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."exit_clearances" ADD CONSTRAINT "exit_clearances_exit_id_exits_id_fk" FOREIGN KEY ("exit_id") REFERENCES "org"."exits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."exit_clearances" ADD CONSTRAINT "exit_clearances_cleared_by_employees_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD CONSTRAINT "exits_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."exits" ADD CONSTRAINT "exits_initiated_by_employees_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "org"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "employees_reports_to_idx" ON "org"."employees" USING btree ("reports_to");--> statement-breakpoint
CREATE INDEX "employees_department_idx" ON "org"."employees" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "access"."audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_assign_rights_uq" ON "access"."batch_assign_rights" USING btree ("batch_id","assignable_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_grants_uq" ON "access"."batch_grants" USING btree ("batch_id","module_key","action","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_batches_uq" ON "access"."employee_batches" USING btree ("employee_id","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "individual_grants_uq" ON "access"."individual_grants" USING btree ("employee_id","module_key","action","scope");--> statement-breakpoint
CREATE INDEX "asset_custody_asset_idx" ON "ops"."asset_custody" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "assets_custodian_employee_idx" ON "ops"."assets" USING btree ("custodian_employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "exit_clearances_uq" ON "org"."exit_clearances" USING btree ("exit_id","portal");