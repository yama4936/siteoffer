ALTER TABLE "content_entries" ADD COLUMN "legacy_path" text;--> statement-breakpoint
ALTER TABLE "content_entries" ADD COLUMN "legacy_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "content_company_legacy_path" ON "content_entries" USING btree ("company_id","legacy_path");