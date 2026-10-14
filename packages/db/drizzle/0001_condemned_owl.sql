CREATE TYPE "public"."reward_adjustment_kind" AS ENUM('amount_change', 'cancellation');--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "reward_adjustments" ADD COLUMN "kind" "reward_adjustment_kind" DEFAULT 'amount_change' NOT NULL;--> statement-breakpoint
ALTER TABLE "rewards" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domain_preferences" ADD COLUMN "confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_preferences" ADD CONSTRAINT "domain_preferences_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_one_open_per_assignment" ON "contracts" USING btree ("assignment_id") WHERE "contracts"."status" in ('reported', 'under_review', 'completed');--> statement-breakpoint
CREATE INDEX "payments_contract" ON "payments" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "domain_preferences_company" ON "domain_preferences" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_preferences_assignment" ON "domain_preferences" USING btree ("assignment_id");