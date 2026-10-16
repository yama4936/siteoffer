CREATE TYPE "public"."sales_offer_change_status" AS ENUM('pending', 'accepted', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "sales_offer_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"sales_user_id" uuid NOT NULL,
	"from_offer_id" uuid NOT NULL,
	"to_offer_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "sales_offer_change_status" DEFAULT 'pending' NOT NULL,
	"response_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_offers" ADD COLUMN "is_public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_offer_changes" ADD CONSTRAINT "sales_offer_changes_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_offer_changes" ADD CONSTRAINT "sales_offer_changes_sales_user_id_users_id_fk" FOREIGN KEY ("sales_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_offer_changes" ADD CONSTRAINT "sales_offer_changes_from_offer_id_sales_offers_id_fk" FOREIGN KEY ("from_offer_id") REFERENCES "public"."sales_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_offer_changes" ADD CONSTRAINT "sales_offer_changes_to_offer_id_sales_offers_id_fk" FOREIGN KEY ("to_offer_id") REFERENCES "public"."sales_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_offer_changes" ADD CONSTRAINT "sales_offer_changes_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_offer_changes" ADD CONSTRAINT "sales_offer_changes_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_offer_changes_pending_assignment" ON "sales_offer_changes" USING btree ("assignment_id") WHERE "sales_offer_changes"."status"='pending';--> statement-breakpoint
CREATE INDEX "sales_offer_changes_history" ON "sales_offer_changes" USING btree ("assignment_id","created_at");