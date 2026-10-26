CREATE TYPE "public"."image_asset_placement" AS ENUM('reference', 'hero', 'logo');--> statement-breakpoint
CREATE TABLE "image_asset_files" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"png_base64" text NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_builds" ADD COLUMN "image_asset_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "image_assets" ADD COLUMN "placement" "image_asset_placement" DEFAULT 'reference' NOT NULL;--> statement-breakpoint
ALTER TABLE "image_asset_files" ADD CONSTRAINT "image_asset_files_asset_id_image_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."image_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_asset_files" ADD CONSTRAINT "image_asset_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "image_assets_placement" ON "image_assets" USING btree ("company_id","placement") WHERE "image_assets"."placement" <> 'reference';
--> statement-breakpoint
ALTER TABLE "image_assets" ADD COLUMN "policy_revision" integer DEFAULT 0 NOT NULL;
