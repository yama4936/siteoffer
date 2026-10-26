CREATE TABLE "consultation_reads" (
	"activity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consultation_reads_user_id_activity_id_pk" PRIMARY KEY("user_id","activity_id")
);
--> statement-breakpoint
ALTER TABLE "consultation_reads" ADD CONSTRAINT "consultation_reads_activity_id_sales_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."sales_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_reads" ADD CONSTRAINT "consultation_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;