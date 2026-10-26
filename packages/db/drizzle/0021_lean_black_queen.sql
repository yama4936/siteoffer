ALTER TABLE "generation_jobs" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "generation_jobs_lease" ON "generation_jobs" USING btree ("status","lease_until");
--> statement-breakpoint
-- 更新前の未完了ジョブにも移行時から2分の猶予を与える。更新時は旧ワーカーを停止してから再起動する。
UPDATE "generation_jobs" SET "lease_until" = now() + interval '2 minutes' WHERE "status" IN ('queued', 'running');
