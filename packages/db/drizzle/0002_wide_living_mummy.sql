ALTER TABLE "discovery_jobs" ADD COLUMN "max_results" integer;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD COLUMN "failures" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "role" text DEFAULT 'company' NOT NULL;