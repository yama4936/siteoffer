ALTER TYPE "public"."user_role" ADD VALUE 'customer';--> statement-breakpoint
CREATE TABLE "content_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"email" text NOT NULL,
	"user_id" uuid,
	"status" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"request_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "content_access_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "content_access_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "content_access" ADD CONSTRAINT "content_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access" ADD CONSTRAINT "content_access_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access" ADD CONSTRAINT "content_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_access" ADD CONSTRAINT "content_access_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_access_company_email" ON "content_access" USING btree ("company_id","email");