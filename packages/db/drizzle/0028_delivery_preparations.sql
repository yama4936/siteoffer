CREATE TABLE "delivery_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"proposal_version_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"reason" text NOT NULL,
	"confirmed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_preparations_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "delivery_builds" ADD COLUMN "preparation_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_preparations" ADD CONSTRAINT "delivery_preparations_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_preparations" ADD CONSTRAINT "delivery_preparations_proposal_version_id_proposal_versions_id_fk" FOREIGN KEY ("proposal_version_id") REFERENCES "public"."proposal_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_preparations" ADD CONSTRAINT "delivery_preparations_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_preparations_revision" ON "delivery_preparations" USING btree ("delivery_id","revision");--> statement-breakpoint
ALTER TABLE "delivery_builds" ADD CONSTRAINT "delivery_builds_preparation_id_delivery_preparations_id_fk" FOREIGN KEY ("preparation_id") REFERENCES "public"."delivery_preparations"("id") ON DELETE no action ON UPDATE no action;