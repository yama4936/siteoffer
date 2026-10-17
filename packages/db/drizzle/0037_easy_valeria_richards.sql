CREATE TABLE "publication_check_operations" (
	"key" text PRIMARY KEY NOT NULL,
	"payload_hash" text NOT NULL,
	"deployment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication_material_checks" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"outcome" text NOT NULL,
	"replacement_id" uuid,
	"observed_url" text NOT NULL,
	"note" text NOT NULL,
	"checked_by" uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revocation_note" text
);
--> statement-breakpoint
ALTER TABLE "publication_check_operations" ADD CONSTRAINT "publication_check_operations_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_material_checks" ADD CONSTRAINT "publication_material_checks_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_material_checks" ADD CONSTRAINT "publication_material_checks_replacement_id_deployments_id_fk" FOREIGN KEY ("replacement_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_material_checks" ADD CONSTRAINT "publication_material_checks_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_material_checks" ADD CONSTRAINT "publication_material_checks_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;