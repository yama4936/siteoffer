ALTER TABLE "share_links" ADD COLUMN "receipt_key" text;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "recovery_key_id" text;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_receipt_key_unique" UNIQUE("receipt_key");