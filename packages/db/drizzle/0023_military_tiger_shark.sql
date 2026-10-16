CREATE TABLE "audit_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"target_url" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_requests" ADD CONSTRAINT "audit_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_requests" ADD CONSTRAINT "audit_requests_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_requests_one_open_company" ON "audit_requests" USING btree ("company_id") WHERE "audit_requests"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "audit_requests_pending" ON "audit_requests" USING btree ("finished_at","next_attempt_at","lease_until");