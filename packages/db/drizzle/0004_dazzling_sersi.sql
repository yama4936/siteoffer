ALTER TABLE "generation_jobs" ADD COLUMN "output" jsonb;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "error_code" text;