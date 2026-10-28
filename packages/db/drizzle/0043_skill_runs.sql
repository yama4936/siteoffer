CREATE TABLE "skill_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"company_id" uuid,
	"audit_id" uuid,
	"parent_run_id" uuid,
	"target_key" text NOT NULL,
	"retry_of_run_id" uuid,
	"result" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_runs_retry_of_run_id_unique" UNIQUE("retry_of_run_id")
);
--> statement-breakpoint
CREATE TABLE "skill_schedules" (
	"skill" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"interval_hours" integer NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_audit_id_site_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."site_audits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_schedules" ADD CONSTRAINT "skill_schedules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_runs_one_open_target" ON "skill_runs" USING btree ("target_key") WHERE "skill_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "skill_runs_status_created" ON "skill_runs" USING btree ("status","created_at");