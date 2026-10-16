import { randomUUID } from "node:crypto";
import { workerRuntimes } from "@siteoffer/db";
import { eq, lt } from "drizzle-orm";
import type { WorkerDeps } from "./deps.ts";

export async function startWorkerHeartbeat(deps: WorkerDeps, mode: string) {
  const id = randomUUID();
  let pending: Promise<void> = Promise.resolve();
  const beat = async () => {
    await deps.db
      .insert(workerRuntimes)
      .values({ id, mode, providers: Object.keys(deps.discovery.providers), heartbeatAt: deps.clock.now() })
      .onConflictDoUpdate({ target: workerRuntimes.id, set: { heartbeatAt: deps.clock.now() } });
  };
  await deps.db
    .delete(workerRuntimes)
    .where(lt(workerRuntimes.heartbeatAt, new Date(deps.clock.now().getTime() - 86_400_000)));
  await beat();
  const timer = setInterval(() => {
    pending = pending.then(beat).catch(() => deps.logger.warn("ワーカーの稼働通知に失敗しました"));
  }, 10_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
    await deps.db.delete(workerRuntimes).where(eq(workerRuntimes.id, id));
  };
}
