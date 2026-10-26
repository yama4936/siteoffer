CREATE TABLE "delivery_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"from_version_id" uuid NOT NULL,
	"from_build_id" uuid,
	"prior_status" "delivery_status" NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"reason" text NOT NULL,
	"requested_changes" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_version_id" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "delivery_changes_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "delivery_builds" ADD COLUMN "change_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_changes" ADD CONSTRAINT "delivery_changes_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_changes" ADD CONSTRAINT "delivery_changes_from_version_id_delivery_versions_id_fk" FOREIGN KEY ("from_version_id") REFERENCES "public"."delivery_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_changes" ADD CONSTRAINT "delivery_changes_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_changes" ADD CONSTRAINT "delivery_changes_approved_version_id_delivery_versions_id_fk" FOREIGN KEY ("approved_version_id") REFERENCES "public"."delivery_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_changes_delivery" ON "delivery_changes" USING btree ("delivery_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_changes_open" ON "delivery_changes" USING btree ("delivery_id") WHERE "delivery_changes"."approved_version_id" is null;--> statement-breakpoint
ALTER TABLE "delivery_builds" ADD CONSTRAINT "delivery_builds_change_id_delivery_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."delivery_changes"("id") ON DELETE no action ON UPDATE no action;