CREATE TABLE "worker_runtimes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"providers" jsonb NOT NULL,
	"mode" text NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD COLUMN "retry_of_job_id" uuid;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_retry_of_job_id_unique" UNIQUE("retry_of_job_id");