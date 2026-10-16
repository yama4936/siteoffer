CREATE TABLE "image_submission_operations" (
	"key" text PRIMARY KEY NOT NULL,
	"payload_hash" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_submissions" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"submitted_by" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"rights_basis" text NOT NULL,
	"rights_note" text NOT NULL,
	"requested_demo" boolean NOT NULL,
	"requested_production" boolean NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_submission_operations" ADD CONSTRAINT "image_submission_operations_asset_id_image_submissions_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."image_submissions"("asset_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_submissions" ADD CONSTRAINT "image_submissions_asset_id_image_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."image_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_submissions" ADD CONSTRAINT "image_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_submissions" ADD CONSTRAINT "image_submissions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_submissions_status" ON "image_submissions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "image_submissions_submitter" ON "image_submissions" USING btree ("submitted_by");