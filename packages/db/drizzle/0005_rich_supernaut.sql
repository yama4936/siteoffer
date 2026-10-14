ALTER TABLE "deliveries" ADD COLUMN "review_version_id" uuid;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;