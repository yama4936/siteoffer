/**
 * ワーカーの起動入口（`pnpm --filter @siteoffer/worker start`）と公開API。
 * 直接実行されたときだけ起動する。import しただけでは何も起動しない（テスト・web から関数を使えるようにする）。
 */
import { pathToFileURL } from "node:url";
import { systemClock } from "@siteoffer/core";
import { createDb } from "@siteoffer/db";
import { PgBoss } from "pg-boss";
import { createBossQueue, registerQueues } from "./boss.ts";
import { buildWorkerDeps, describeConfig, resolveWorkerConfig } from "./config.ts";
import { consoleLogger } from "./deps.ts";
import { startWorkerHeartbeat } from "./heartbeat.ts";
import { type IntakeLoop, startIntakeLoop } from "./intake.ts";
import { createWorkerRuntime } from "./runtime.ts";

export * from "./boss.ts";
export * from "./config.ts";
export * from "./content.ts";
export * from "./deps.ts";
export * from "./execute.ts";
export * from "./input.ts";
export * from "./intake.ts";
export * from "./ledger.ts";
export * from "./pipeline/audit.ts";
export * from "./pipeline/discovery.ts";
export * from "./pipeline/proposal.ts";
export * from "./pipeline/status.ts";
export * from "./queues.ts";
export * from "./runtime.ts";
export * from "./site-builder.ts";
export * from "./url.ts";

export interface RunningWorker {
  stop(): Promise<void>;
}

/** pg-boss を起動し、キューと定期ジョブを登録する。SIGINT・SIGTERM で止める */
export async function startWorker(env: Record<string, string | undefined> = process.env): Promise<RunningWorker> {
  const logger = consoleLogger;
  const resolved = resolveWorkerConfig(env);
  if (!resolved.ok) throw new Error(`ワーカーの設定が不正：${resolved.message}`);
  const config = resolved.value;
  if (!config.databaseUrl) throw new Error("環境変数 DATABASE_URL が未設定");

  const { db, close } = createDb(config.databaseUrl);
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss" });
  boss.on("error", (e: unknown) => logger.error("pg-boss のエラー", { message: (e as Error).message }));
  await boss.start();

  const deps = buildWorkerDeps(config, { db, clock: systemClock, queue: createBossQueue(boss), logger });
  const runtime = createWorkerRuntime(deps);
  await registerQueues(boss, runtime, config, logger);
  const stopHeartbeat =
    config.intakeIntervalMs > 0
      ? await startWorkerHeartbeat(
          deps,
          env.SITEOFFER_DEMO_MODE === "true" ? "demo" : "standard",
          config.intakeIntervalMs,
        )
      : null;
  // webが作った収集ジョブ・制作中の納品をDBから拾う（webからキューへ直接送る経路はない）
  const intake: IntakeLoop | null =
    config.intakeIntervalMs > 0
      ? startIntakeLoop(deps, config.intakeIntervalMs, undefined, stopHeartbeat?.report)
      : null;
  logger.info("ワーカーを起動した", describeConfig(config));

  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      logger.info("ワーカーを停止する（実行中のジョブの完了を待つ）");
      await stopHeartbeat?.();
      await intake?.stop();
      await boss.stop({ graceful: true, timeout: 60_000 });
      await close();
    })();
    return stopping;
  };
  return { stop };
}

function isMain(): boolean {
  const entry = process.argv[1];
  return !!entry && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  startWorker()
    .then((worker) => {
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, () => {
          worker.stop().then(
            () => process.exit(0),
            (e: unknown) => {
              consoleLogger.error("停止に失敗した", { message: (e as Error).message });
              process.exit(1);
            },
          );
        });
      }
    })
    .catch((e: unknown) => {
      consoleLogger.error("ワーカーを起動できなかった", { message: (e as Error).message });
      process.exit(1);
    });
}
