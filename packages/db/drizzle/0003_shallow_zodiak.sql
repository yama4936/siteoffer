ALTER TABLE "site_audits" ADD COLUMN "target_url" text NOT NULL;--> statement-breakpoint
ALTER TABLE "site_audits" ADD COLUMN "final_url" text;--> statement-breakpoint
ALTER TABLE "site_audits" ADD COLUMN "score_confirmed" boolean;--> statement-breakpoint
ALTER TABLE "site_audits" ADD COLUMN "critical_flags" jsonb;--> statement-breakpoint
ALTER TABLE "site_audits" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "site_audits" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "site_audits" ADD COLUMN "evaluator_model" text;--> statement-breakpoint
ALTER TABLE "site_audits" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "findings_audit_item" ON "findings" USING btree ("audit_id","item_code");--> statement-breakpoint
CREATE INDEX "site_audits_website" ON "site_audits" USING btree ("website_id","created_at");