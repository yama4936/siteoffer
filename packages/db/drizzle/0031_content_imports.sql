CREATE TABLE "content_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"format" text NOT NULL,
	"imported_count" integer NOT NULL,
	"skipped_count" integer NOT NULL,
	"entry_ids" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_imports_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "content_entries" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "content_entries" ADD COLUMN "original_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_entries" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "content_imports" ADD CONSTRAINT "content_imports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_imports" ADD CONSTRAINT "content_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_imports_company" ON "content_imports" USING btree ("company_id","created_at");--> statement-breakpoint
ALTER TABLE "content_entries" ADD CONSTRAINT "content_entries_import_id_content_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."content_imports"("id") ON DELETE no action ON UPDATE no action;