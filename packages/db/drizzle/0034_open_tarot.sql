CREATE TABLE "auth_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "credential_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_attempts_window" ON "auth_attempts" USING btree ("window_started_at");
