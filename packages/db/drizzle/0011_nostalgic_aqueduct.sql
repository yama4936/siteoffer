CREATE TABLE "activity_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"values" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_submissions" (
	"request_key" text PRIMARY KEY NOT NULL,
	"activity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_activities" ADD COLUMN "next_action_mode" text DEFAULT 'keep' NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_drafts" ADD CONSTRAINT "activity_drafts_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_drafts" ADD CONSTRAINT "activity_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_submissions" ADD CONSTRAINT "activity_submissions_activity_id_sales_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."sales_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_draft_owner_assignment" ON "activity_drafts" USING btree ("user_id","assignment_id");
--> statement-breakpoint
UPDATE "sales_activities" SET "next_action_mode" = 'replace' WHERE "next_action_at" IS NOT NULL;
