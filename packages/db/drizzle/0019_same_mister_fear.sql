CREATE TABLE "delivery_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"session_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_previews_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "delivery_previews" ADD CONSTRAINT "delivery_previews_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_previews" ADD CONSTRAINT "delivery_previews_version_id_delivery_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."delivery_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_previews_expiry" ON "delivery_previews" USING btree ("expires_at");