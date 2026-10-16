ALTER TABLE "approvals" ADD COLUMN "receipt_key" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_receipt_key_unique" UNIQUE("receipt_key");