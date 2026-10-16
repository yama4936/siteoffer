CREATE TYPE "public"."consultation_status" AS ENUM('open', 'in_progress', 'resolved');--> statement-breakpoint
CREATE TABLE "consultation_cases" (
	"activity_id" uuid PRIMARY KEY NOT NULL,
	"status" "consultation_status" DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consultation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"receipt_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consultation_events_receipt_key_unique" UNIQUE("receipt_key")
);
--> statement-breakpoint
ALTER TABLE "consultation_cases" ADD CONSTRAINT "consultation_cases_activity_id_sales_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."sales_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_cases" ADD CONSTRAINT "consultation_cases_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_events" ADD CONSTRAINT "consultation_events_activity_id_sales_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."sales_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_events" ADD CONSTRAINT "consultation_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consultation_cases_status_assignee" ON "consultation_cases" USING btree ("status","assigned_to");--> statement-breakpoint
CREATE UNIQUE INDEX "consultation_events_activity_revision" ON "consultation_events" USING btree ("activity_id","revision");