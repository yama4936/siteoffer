CREATE TABLE "sales_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"product_terms_id" uuid NOT NULL,
	"proposal_version_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "sales_offer_id" uuid;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "sales_offer_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_product_terms_id_product_terms_id_fk" FOREIGN KEY ("product_terms_id") REFERENCES "public"."product_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_proposal_version_id_proposal_versions_id_fk" FOREIGN KEY ("proposal_version_id") REFERENCES "public"."proposal_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_offers_company_version" ON "sales_offers" USING btree ("company_id","version");--> statement-breakpoint
CREATE INDEX "sales_offers_terms" ON "sales_offers" USING btree ("product_terms_id");--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_sales_offer_id_sales_offers_id_fk" FOREIGN KEY ("sales_offer_id") REFERENCES "public"."sales_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_sales_offer_id_sales_offers_id_fk" FOREIGN KEY ("sales_offer_id") REFERENCES "public"."sales_offers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Only the latest recorded activation is authoritative. Missing or mismatched history stays unbound.
WITH latest AS (
 SELECT DISTINCT ON (target_id) id, target_id, actor_id, "after", created_at
 FROM audit_events WHERE action='company.make_sellable' AND target_type='company'
 ORDER BY target_id, created_at DESC, id DESC
)
INSERT INTO sales_offers(id,company_id,version,product_terms_id,proposal_version_id,created_by,created_at)
SELECT e.id,c.id,1,t.id,v.id,e.actor_id,e.created_at FROM latest e
JOIN companies c ON c.id::text=lower(e.target_id)
JOIN product_terms t ON t.id::text=lower(e."after"->>'productTermsId')
JOIN proposal_versions v ON v.id::text=lower(e."after"->>'proposalVersionId') AND v.status='approved'
JOIN proposals p ON p.id=v.proposal_id AND p.company_id=c.id;
--> statement-breakpoint
UPDATE assignments a SET sales_offer_id=o.id FROM sales_offers o
WHERE a.company_id=o.company_id AND o.created_at<=a.claimed_at
AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.assignment_id=a.id
 AND (c.product_terms_id IS DISTINCT FROM o.product_terms_id OR c.proposal_version_id IS DISTINCT FROM o.proposal_version_id));
--> statement-breakpoint
UPDATE contracts c SET sales_offer_id=o.id FROM sales_offers o
WHERE c.company_id=o.company_id AND c.product_terms_id=o.product_terms_id
AND c.proposal_version_id=o.proposal_version_id AND o.created_at<=c.reported_at;
