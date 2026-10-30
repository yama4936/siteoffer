/** Owned QA child: real queue/runtime/intake, with fixture skill output and no AI SDK execution. */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { systemClock } from "@siteoffer/core";
import { createDb } from "@siteoffer/db";
import { PgBoss } from "pg-boss";
import { createBossQueue, registerQueues } from "../src/boss.ts";
import { buildWorkerDeps, resolveWorkerConfig } from "../src/config.ts";
import type { Logger } from "../src/deps.ts";
import { startWorkerHeartbeat } from "../src/heartbeat.ts";
import { startIntakeLoop } from "../src/intake.ts";
import { createWorkerRuntime, type WorkerRuntime } from "../src/runtime.ts";
import type { SkillExecutor } from "../src/skills/executor.ts";
import { makePrecheckSite } from "./precheck-fixture.ts";

if (!process.send || !process.env.SITEOFFER_SKILL_REVIEW_CHILD) throw Error("Owned QA parent IPC is required");
type Setup = { connectionString: string; artifactRoot: string; repoRoot: string; worker: string };
let stop: (() => Promise<void>) | undefined;
const notify = (message: unknown) => process.send?.(message);
process.once("message", async (raw) => {
  const setup = raw as Setup;
  const privateLog = path.join(setup.artifactRoot, `private-worker-${setup.worker}.log`);
  const logError = (message: string, meta?: unknown) => {
    try {
      appendFileSync(privateLog, `${JSON.stringify({ at: new Date().toISOString(), message, meta })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      notify({ type: "error", worker: setup.worker, code: "private_log_error" });
    }
  };
  try {
    await writeFile(privateLog, "", { flag: "wx", mode: 0o600 });
    const config = resolveWorkerConfig({
      DATABASE_URL: setup.connectionString,
      SITEOFFER_GENERATOR: "mock",
      SITEOFFER_GENERATION_INPUT: "fixture",
      SITEOFFER_DISCOVERY_PROVIDERS: "fixture",
      SITEOFFER_SEARCH_PROVIDER: "fixture",
      SITEOFFER_AUDIT_COLLECTOR: "fixture",
      SITEOFFER_EVAL_CONFIG: "config/site-evaluation.demo.json",
      SITEOFFER_DEMO_ARTIFACT_DIR: path.join(setup.artifactRoot, "demos"),
      SITEOFFER_DELIVERY_ARTIFACT_DIR: path.join(setup.artifactRoot, "deliveries"),
      SITEOFFER_INTAKE_INTERVAL_MS: "500",
      SITEOFFER_PROPOSAL_CONCURRENCY: "1",
    });
    if (!config.ok) throw Error("Invalid QA worker configuration");
    config.value.auditOptions.paths.artifactRoot = path.join(setup.artifactRoot, "audits");
    const { db, close } = createDb(setup.connectionString);
    const boss = new PgBoss({ connectionString: setup.connectionString, max: 4 });
    boss.on("error", () => notify({ type: "error", worker: setup.worker, code: "queue_error" }));
    await boss.start();
    const logger: Logger = {
      info() {},
      warn() {},
      error(message, meta) {
        logError(message, meta);
        notify({ type: "error", worker: setup.worker, code: "worker_error" });
      },
    };
    const deps = buildWorkerDeps(config.value, { db, clock: systemClock, queue: createBossQueue(boss), logger });
    const executor: SkillExecutor = {
      kind: "fixture",
      requestedModel: null,
      async execute(spec) {
        const outRel = spec.prompt.match(/(reports\/(?:sites|discovery)\/[^\s（）]+)/)?.[1];
        if (!outRel?.startsWith("reports/sites/") || outRel.includes("..")) throw Error("Invalid fixture output");
        const outDir = path.join(spec.workDir, outRel);
        await mkdir(outDir, { recursive: true });
        // site-proposal also mentions config/site-evaluation.json; inspect the explicit skill reference.
        const skill = spec.prompt.match(
          /\.agents\/skills\/(site-evaluation|site-proposal|site-rebuild)\/SKILL\.md/,
        )?.[1];
        if (skill === "site-evaluation") {
          await writeFile(
            path.join(outDir, "collected.json"),
            await readFile(path.join(setup.repoRoot, "fixtures/audit/collected/kakuu-koumuten.collected.json")),
          );
          const evaluation = JSON.parse(
            await readFile(
              path.join(setup.repoRoot, "fixtures/audit/evaluations/kakuu-koumuten.evaluation.json"),
              "utf8",
            ),
          );
          delete evaluation._fixture;
          evaluation.company.name = "株式会社例";
          await writeFile(path.join(outDir, "evaluation.json"), JSON.stringify(evaluation));
          execFileSync(
            "python3",
            [
              "-E",
              "-s",
              path.join(spec.workDir, ".agents/skills/site-evaluation/scripts/score.py"),
              path.join(outDir, "evaluation.json"),
              "--config",
              path.join(spec.workDir, "config/site-evaluation.json"),
            ],
            { stdio: "pipe" },
          );
        } else if (skill === "site-proposal") {
          await writeFile(
            path.join(outDir, "proposal.json"),
            JSON.stringify({
              summary: {
                headline: "株式会社例の会社情報を読みやすくする",
                direction: "架空データによる通し検証用の提案です",
              },
              actions: [
                {
                  id: "P-01",
                  title: "会社案内",
                  issue_ids: ["D1"],
                  priority: "high",
                  target: { url: "https://kakuu-koumuten.example/", location: "会社案内" },
                  current: "固定幅の会社情報",
                  problem: "スマホで読みづらい",
                  change: { description: "会社情報を画面幅に合わせて表示する" },
                  scope: "in_scope",
                },
              ],
            }),
          );
        } else if (skill === "site-rebuild") {
          // Regression fixture: valid PNGs and declared quality evidence, not actual browser quality review.
          makePrecheckSite(path.join(outDir, "site"));
        } else throw Error("Unexpected fixture skill");
        notify({ type: "fixture_execution", worker: setup.worker, skill, runId: spec.runId });
        return {
          ok: true,
          finalResponse: JSON.stringify({
            status: "completed",
            summary: `QA fixture ${skill}; no model call`,
            output_dir: outRel,
          }),
          threadId: null,
          usage: null,
          stopped: true,
        };
      },
    };
    deps.skills = {
      executor,
      workRoot: path.join(setup.artifactRoot, "skill-work"),
      reportsRoot: path.join(setup.artifactRoot, "reports"),
      repoRoot: setup.repoRoot,
    };
    const runtime = createWorkerRuntime(deps);
    const traced: WorkerRuntime = {
      async run(name, data, options) {
        notify({ type: "start", worker: setup.worker, queue: name });
        const result = await runtime.run(name, data, options);
        notify({ type: "finish", worker: setup.worker, queue: name, status: result.status });
        return result;
      },
    };
    await registerQueues(boss, traced, config.value, logger);
    const heartbeat = await startWorkerHeartbeat(deps, "qa-fixture-no-model", config.value.intakeIntervalMs);
    const intake = startIntakeLoop(deps, config.value.intakeIntervalMs, undefined, heartbeat.report);
    stop = async () => {
      await intake.stop();
      await heartbeat();
      await boss.stop({ graceful: true, timeout: 20_000 });
      await close();
    };
    notify({ type: "ready", worker: setup.worker, pid: process.pid });
  } catch (error) {
    logError("QA worker setup failed", error instanceof Error ? { message: error.message, stack: error.stack } : {});
    notify({ type: "fatal", worker: setup.worker });
    process.exit(1);
  }
});
process.on("message", (message) => {
  if (message === "stop")
    Promise.resolve(stop?.()).then(
      () => process.exit(0),
      () => process.exit(1),
    );
});
process.once("disconnect", () => {
  Promise.resolve(stop?.()).finally(() => process.exit(1));
});
