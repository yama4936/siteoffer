CREATE TABLE "consultation_drafts" (
	"activity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"values" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consultation_drafts_user_id_activity_id_pk" PRIMARY KEY("user_id","activity_id")
);
--> statement-breakpoint
ALTER TABLE "consultation_drafts" ADD CONSTRAINT "consultation_drafts_activity_id_sales_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."sales_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_drafts" ADD CONSTRAINT "consultation_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;