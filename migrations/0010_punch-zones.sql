CREATE TABLE "org"."punch_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"lng" numeric(9, 6) NOT NULL,
	"radius_m" integer DEFAULT 250 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "punch_zones_name_unique" UNIQUE("name")
);
