CREATE TABLE "password_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_revision" integer NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"token_hash" text,
	"issue_request_id" uuid,
	"issued_by" uuid,
	"verification_method" text,
	"consumed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "password_recoveries_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "password_recoveries_issue_request_id_unique" UNIQUE("issue_request_id")
);
--> statement-breakpoint
ALTER TABLE "password_recoveries" ADD CONSTRAINT "password_recoveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_recoveries" ADD CONSTRAINT "password_recoveries_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_recoveries_requested" ON "password_recoveries" USING btree ("requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "password_recoveries_one_open" ON "password_recoveries" USING btree ("user_id") WHERE "password_recoveries"."status" in ('requested','issued');