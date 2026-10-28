-- T23: 既存の顧客アカウントは管理者（admin）にし、以後の既定は編集者（editor）にする
ALTER TABLE "content_access" ADD COLUMN "role" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_access" ALTER COLUMN "role" SET DEFAULT 'editor';
