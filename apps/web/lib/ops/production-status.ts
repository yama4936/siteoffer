import { type Actor, type Clock, err, ok } from "@siteoffer/core";
import { type DbOrTx, generationJobs, runReadQueries, users, workerRuntimes } from "@siteoffer/db";
import { and, desc, eq } from "drizzle-orm";
import { isUuid } from "./form";
import { assessWorkers } from "./processing";
import { productionPreparation } from "./production-preparation";

type ImageState = ReturnType<typeof assessWorkers>["image"];

/** A key on the Web server says nothing about the worker that will execute a request. */
export function imageRequestReadiness(model: string | undefined, image: ImageState) {
  if (!model?.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.trim()))
    return {
      ready: false,
      message: "画像生成モデルの指定が必要です。管理者に確認するか、用意したデザイン画像を取り込んで進められます。",
    };
  if (image.status !== "ready")
    return { ready: false, message: `${image.label}。${image.detail} 用意したデザイン画像の取り込みは利用できます。` };
  return {
    ready: true,
    message:
      "モデルの指定と画像処理ワーカーの稼働通知を確認しました。API接続・生成の成功は、依頼後の結果で確認します。",
  };
}

/** Only public readiness and timestamps leave this boundary; no job output, keys or runtime IDs. */
export async function getProductionStatusForOps(db: DbOrTx, clock: Clock, actor: Actor | null) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  if (!user) return err("forbidden");
  const now = clock.now();
  const [runtimes, stopped] = await runReadQueries(db, [
    () => db.select().from(workerRuntimes).orderBy(desc(workerRuntimes.heartbeatAt)),
    () =>
      db
        .selectDistinct({ generator: generationJobs.generator })
        .from(generationJobs)
        .where(
          and(eq(generationJobs.status, "needs_review"), eq(generationJobs.errorCode, "sandbox_stop_unconfirmed")),
        ),
  ]);
  const { image, site } = assessWorkers(
    runtimes,
    now,
    stopped.map((row) => row.generator),
  );
  return ok({ image, site, preparation: productionPreparation(runtimes, now), checkedAt: now.toISOString() });
}
