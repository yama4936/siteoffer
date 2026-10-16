CREATE TYPE "public"."delivery_build_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "delivery_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"previous_id" uuid,
	"status" "delivery_build_status" DEFAULT 'queued' NOT NULL,
	"owner_id" uuid,
	"lease_until" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "current_build_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_versions" ADD COLUMN "build_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_builds" ADD CONSTRAINT "delivery_builds_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_builds_delivery" ON "delivery_builds" USING btree ("delivery_id","created_at");--> statement-breakpoint
ALTER TABLE "delivery_versions" ADD CONSTRAINT "delivery_versions_build_id_delivery_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."delivery_builds"("id") ON DELETE no action ON UPDATE no action;