CREATE TYPE "public"."image_asset_rights_status" AS ENUM('unknown', 'customer_claimed', 'license_verified', 'use_approved');--> statement-breakpoint
CREATE TYPE "public"."image_asset_source" AS ENUM('original_site', 'customer_upload', 'generated', 'operator_upload');--> statement-breakpoint
CREATE TABLE "image_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"label" text NOT NULL,
	"source_type" "image_asset_source" NOT NULL,
	"source_url" text,
	"rights_status" "image_asset_rights_status" DEFAULT 'unknown' NOT NULL,
	"allow_sales_demo" boolean DEFAULT false NOT NULL,
	"allow_production" boolean DEFAULT false NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_assets_company" ON "image_assets" USING btree ("company_id");