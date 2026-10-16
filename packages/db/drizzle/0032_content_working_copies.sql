CREATE TABLE "content_operations" (
	"key" text PRIMARY KEY NOT NULL,
	"payload_hash" text NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_working_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"revision" integer NOT NULL,
	"values" jsonb,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_entries" ADD COLUMN "publication_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_operations" ADD CONSTRAINT "content_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_operations" ADD CONSTRAINT "content_operations_entry_id_content_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."content_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_working_copies" ADD CONSTRAINT "content_working_copies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_working_copies" ADD CONSTRAINT "content_working_copies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_working_copy_owner_scope" ON "content_working_copies" USING btree ("user_id","company_id","scope");