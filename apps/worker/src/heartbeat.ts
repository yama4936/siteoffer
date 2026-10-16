import { randomUUID } from "node:crypto";
import { type IntakePhase, type WorkerCapabilities, type WorkerProgress, workerRuntimes } from "@siteoffer/db";
import { eq, lt } from "drizzle-orm";
import type { WorkerDeps } from "./deps.ts";

export async function startWorkerHeartbeat(deps: WorkerDeps, mode: string, intakeIntervalMs = 5000) {
  const id = randomUUID();
  const kind = deps.generation.generator.kind;
  const capabilities: WorkerCapabilities = {
    version: 1,
    discoveryOnly: !!deps.discoveryOnly,
    imageConfigured: !deps.discoveryOnly && !!process.env.OPENAI_API_KEY?.trim(),
    generator: kind === "mock" || kind === "codex" ? kind : "unknown",
    intakeIntervalMs,
  };
  let progress: WorkerProgress = {
    phase: "starting",
    since: deps.clock.now().toISOString(),
    completedAt: null,
    lastErrorAt: null,
  };
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  const beat = async () => {
    const snapshot = { heartbeatAt: deps.clock.now(), capabilities, progress: { ...progress } };
    await deps.db
      .insert(workerRuntimes)
      .values({ id, mode, providers: Object.keys(deps.discovery.providers), ...snapshot })
      .onConflictDoUpdate({ target: workerRuntimes.id, set: snapshot });
  };
  await deps.db
    .delete(workerRuntimes)
    .where(lt(workerRuntimes.heartbeatAt, new Date(deps.clock.now().getTime() - 86_400_000)));
  await beat();
  const enqueue = () => {
    if (stopped) return pending;
    pending = pending.then(beat).catch(() => deps.logger.warn("ワーカーの稼働通知に失敗しました"));
    return pending;
  };
  const timer = setInterval(() => {
    void enqueue();
  }, 10_000);
  timer.unref();
  const report = async (phase: IntakePhase) => {
    if (stopped) return;
    const now = deps.clock.now().toISOString();
    progress = {
      ...progress,
      phase,
      since: now,
      ...(phase === "idle" ? { completedAt: now } : {}),
      ...(phase === "error" ? { lastErrorAt: now } : {}),
    };
    await enqueue();
  };
  const stop = async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
    await deps.db.delete(workerRuntimes).where(eq(workerRuntimes.id, id));
  };
  return Object.assign(stop, { report });
}
