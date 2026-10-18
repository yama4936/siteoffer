/** Dedicated child of postgres-pipeline.ts. Credentials arrive only over this process's IPC channel. */
import { systemClock } from "@siteoffer/core";
import { createDb } from "@siteoffer/db";
import type { GenerateRequest } from "@siteoffer/generation";
import { PgBoss } from "pg-boss";
import { createBossQueue, registerQueues } from "../src/boss.ts";
import { buildWorkerDeps, resolveWorkerConfig } from "../src/config.ts";
import type { Logger } from "../src/deps.ts";
import { startWorkerHeartbeat } from "../src/heartbeat.ts";
import { startIntakeLoop } from "../src/intake.ts";
import { createWorkerRuntime, type WorkerRuntime } from "../src/runtime.ts";

if (!process.send || !process.env.SITEOFFER_PG_PIPELINE_CHILD) throw Error("QA parent IPC is required");
type Setup = { connectionString: string; artifactRoot: string; worker: string; pauseEvaluation?: boolean };
let stop: (() => Promise<void>) | undefined;
let pauseEvaluation = false;
const gates = new Set<() => void>();
const notify = (message: unknown) => process.send?.(message);
process.once("message", async (raw) => {
  const setup = raw as Setup;
  try {
    const config = resolveWorkerConfig({
      DATABASE_URL: setup.connectionString,
      SITEOFFER_GENERATOR: "mock",
      SITEOFFER_GENERATION_INPUT: "fixture",
      SITEOFFER_DISCOVERY_PROVIDERS: "fixture",
      SITEOFFER_SEARCH_PROVIDER: "fixture",
      SITEOFFER_AUDIT_COLLECTOR: "fixture",
      SITEOFFER_EVAL_CONFIG: "config/site-evaluation.demo.json",
      SITEOFFER_DEMO_ARTIFACT_DIR: `${setup.artifactRoot}/demos`,
      SITEOFFER_DELIVERY_ARTIFACT_DIR: `${setup.artifactRoot}/deliveries`,
      SITEOFFER_INTAKE_INTERVAL_MS: "500",
      SITEOFFER_PROPOSAL_CONCURRENCY: "1",
    });
    if (!config.ok) throw Error("Invalid QA configuration");
    config.value.auditOptions.paths.artifactRoot = `${setup.artifactRoot}/audits`;
    const { db, close } = createDb(setup.connectionString);
    const boss = new PgBoss({ connectionString: setup.connectionString, max: 4 });
    boss.on("error", () => notify({ type: "error", worker: setup.worker, code: "queue_error" }));
    await boss.start();
    const logger: Logger = {
      info() {},
      warn() {},
      error() {
        notify({ type: "error", worker: setup.worker, code: "intake_error" });
      },
    };
    const deps = buildWorkerDeps(config.value, { db, clock: systemClock, queue: createBossQueue(boss), logger });
    pauseEvaluation = !!setup.pauseEvaluation;
    const generate = deps.generation.generator.generate.bind(deps.generation.generator);
    deps.generation.generator.generate = async <T>(request: GenerateRequest<T>) => {
      if (pauseEvaluation && request.purpose === "evaluation") {
        await new Promise<void>((resolve) => {
          const release = () => {
            gates.delete(release);
            request.signal?.removeEventListener("abort", release);
            resolve();
          };
          gates.add(release);
          if (request.signal?.aborted) release();
          else request.signal?.addEventListener("abort", release, { once: true });
          notify({ type: "generation_paused", worker: setup.worker, jobId: request.jobId });
        });
      }
      return generate(request);
    };
    const runtime = createWorkerRuntime(deps);
    const traced: WorkerRuntime = {
      run: async (name, data, options) => {
        notify({ type: "start", worker: setup.worker, queue: name });
        const result = await runtime.run(name, data, options);
        notify({ type: "finish", worker: setup.worker, queue: name, status: result.status });
        return result;
      },
    };
    await registerQueues(boss, traced, config.value, logger);
    const heartbeat = await startWorkerHeartbeat(deps, "demo", config.value.intakeIntervalMs);
    const intake = startIntakeLoop(deps, config.value.intakeIntervalMs, undefined, heartbeat.report);
    stop = async () => {
      await intake.stop();
      await heartbeat();
      await boss.stop({ graceful: true, timeout: 20_000 });
      await close();
    };
    notify({ type: "ready", worker: setup.worker, pid: process.pid });
  } catch {
    notify({ type: "fatal", worker: setup.worker });
    process.exit(1);
  }
});
process.on("message", (message) => {
  if (message === "pause_generations") {
    pauseEvaluation = true;
    return;
  }
  if (message === "release_generations") {
    pauseEvaluation = false;
    for (const release of gates) release();
    return;
  }
  if (message !== "stop") return;
  Promise.resolve(stop?.()).then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
process.once("disconnect", () => {
  Promise.resolve(stop?.()).finally(() => process.exit(1));
});
