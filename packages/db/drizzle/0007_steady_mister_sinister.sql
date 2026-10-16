CREATE TYPE "public"."design_status" AS ENUM('draft', 'queued', 'generating', 'in_review', 'approved', 'rejected', 'failed');--> statement-breakpoint
CREATE TABLE "design_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"request_key" text NOT NULL,
	"status" "design_status" NOT NULL,
	"brief" jsonb NOT NULL,
	"company_snapshot" jsonb NOT NULL,
	"prompt" text NOT NULL,
	"source" text NOT NULL,
	"model" text,
	"request_id" text,
	"usage" jsonb,
	"image_base64" text,
	"image_sha256" text,
	"width" integer,
	"height" integer,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"build_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_versions_request_key_unique" UNIQUE("request_key")
);
--> statement-breakpoint
CREATE TABLE "proposal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_key" text NOT NULL,
	"design_version_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"pdf_base64" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_documents_document_key_unique" UNIQUE("document_key")
);
--> statement-breakpoint
ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_audit_id_site_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."site_audits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_documents" ADD CONSTRAINT "proposal_documents_design_version_id_design_versions_id_fk" FOREIGN KEY ("design_version_id") REFERENCES "public"."design_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "design_company_version" ON "design_versions" USING btree ("company_id","version");--> statement-breakpoint
CREATE INDEX "design_status_idx" ON "design_versions" USING btree ("status");