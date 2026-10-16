import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Actor, fixedClock, ok } from "@siteoffer/core";
import { auditEvents, type Db, findings, generationJobs, siteAudits } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureCollector, parseCollectRun } from "../src/collect.ts";
import { createGenerationEvaluationGenerator } from "../src/generation-adapter.ts";
import { createPythonRunner } from "../src/python.ts";
import { type AuditDeps, runSiteAudit } from "../src/service.ts";
import { COLLECTED_FIXTURE, evaluationFixture, fixedGenerator, seedWebsite, tempOptions } from "./helpers.ts";

const actor: Actor = { kind: "system", job: "audit-cancellation-test" };
const clock = fixedClock("2026-10-17T00:00:00Z");
let db: Db;
let close: () => Promise<void>;
let temp: Awaited<ReturnType<typeof tempOptions>>;
let deps: AuditDeps;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  temp = await tempOptions();
  deps = {
    collector: createFixtureCollector(COLLECTED_FIXTURE),
    generator: fixedGenerator(evaluationFixture()).gen,
    runner: createPythonRunner(),
    options: temp.options,
  };
});
afterEach(async () => {
  await close();
  await temp.cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("診断の中断", () => {
  it("開始前の中断では診断も外部処理も作らない", async () => {
    const { site } = await seedWebsite(db);
    const collect = vi.spyOn(deps.collector, "collect");
    expect(
      await runSiteAudit(db, clock, deps, { websiteId: site.id, actor, signal: AbortSignal.abort() }),
    ).toMatchObject({ ok: false, error: "aborted" });
    expect(await db.select().from(siteAudits)).toHaveLength(0);
    expect(collect).not.toHaveBeenCalled();
  });

  it.each(["collect", "generate", "score", "decide", "unevaluable-score", "unevaluable-decide"])(
    "%s の待機中に終了し、遅い結果を採用しない",
    async (phase) => {
      const { site } = await seedWebsite(db);
      const controller = new AbortController();
      const entered = deferred<void>();
      const gate = deferred<void>();
      const late = deferred<void>();
      let seenSignal: AbortSignal | undefined;
      const wait = async (signal?: AbortSignal) => {
        seenSignal = signal;
        entered.resolve();
        await gate.promise;
        late.resolve();
      };
      if (phase === "collect") {
        deps.collector = {
          async collect(_url, outDir, signal) {
            await wait(signal);
            return ok({
              kind: "fatal",
              reason: "late",
              collected: {},
              collectedPath: path.join(outDir, "collected.json"),
            });
          },
        };
      } else if (phase === "generate") {
        deps.generator = {
          async generate(input) {
            await wait(input.signal);
            return ok({ evaluation: evaluationFixture(), model: null });
          },
        };
      } else {
        if (phase.startsWith("unevaluable"))
          deps.collector = {
            async collect(_url, outDir) {
              return ok({
                kind: "fatal",
                reason: "blocked",
                collected: {},
                collectedPath: path.join(outDir, "collected.json"),
              });
            },
          };
        const runner = deps.runner;
        deps.runner = {
          async run(script, args, opts) {
            if (script.endsWith(phase.endsWith("decide") ? "decide.py" : "score.py")) {
              await wait(opts.signal);
              return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
            }
            return runner.run(script, args, opts);
          },
        };
      }
      const pending = runSiteAudit(db, clock, deps, { websiteId: site.id, actor, signal: controller.signal });
      try {
        await entered.promise;
        expect(seenSignal).toBe(controller.signal);
        controller.abort();
        expect(await pending).toMatchObject({
          ok: true,
          value: { status: "failed", failureReason: expect.stringContaining("中断") },
        });
        gate.resolve();
        await late.promise;
        expect(await db.select().from(findings)).toHaveLength(0);
        const [audit] = await db.select().from(siteAudits);
        expect(audit).toMatchObject({ status: "failed", totalScore: null, decision: null });
        const events = await db.select().from(auditEvents);
        expect(events.filter((e) => e.action === "site_audit.failed")).toHaveLength(1);
        expect(events.some((e) => ["site_audit.evaluated", "site_audit.unevaluable"].includes(e.action))).toBe(false);
      } finally {
        controller.abort();
        gate.resolve();
        await pending;
      }
    },
  );

  it("生成アダプター経由の中断で生成履歴も failed / aborted に閉じる", async () => {
    const { site } = await seedWebsite(db);
    const controller = new AbortController();
    const entered = deferred<void>();
    let generatorSignal: AbortSignal | undefined;
    deps.generator = createGenerationEvaluationGenerator({
      db,
      clock,
      generator: {
        kind: "mock",
        requestedModel: null,
        promptVersion: () => "cancellation-test",
        async generate(request) {
          generatorSignal = request.signal;
          entered.resolve();
          return new Promise(() => {});
        },
      },
    });
    const pending = runSiteAudit(db, clock, deps, { websiteId: site.id, actor, signal: controller.signal });
    await entered.promise;
    controller.abort();
    expect(await pending).toMatchObject({ ok: true, value: { status: "failed" } });
    expect(generatorSignal?.aborted).toBe(true);
    await vi.waitFor(async () => {
      const [job] = await db.select().from(generationJobs);
      expect(job).toMatchObject({ status: "failed", errorCode: "aborted", leaseUntil: null });
    });
  });

  it("予期しない例外も診断を閉じ、内部エラーの内容を表示しない", async () => {
    const { site } = await seedWebsite(db);
    deps.collector = {
      async collect() {
        throw new Error("private-runtime-detail");
      },
    };
    expect(await runSiteAudit(db, clock, deps, { websiteId: site.id, actor })).toMatchObject({
      ok: true,
      value: { status: "failed" },
    });
    const [audit] = await db.select().from(siteAudits);
    expect(audit!.failureReason).not.toContain("private-runtime-detail");
  });

  it("中断された取得は、残った fatal JSON を評価不能として採用しない", () => {
    expect(
      parseCollectRun(
        { exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: true },
        '{"fatal":"late"}',
        temp.dir,
      ),
    ).toMatchObject({ ok: false, error: "collect_failed" });
  });

  it("実Python子プロセスを中断して終了を確認する", async () => {
    const script = path.join(temp.dir, "wait.py");
    const pidFile = path.join(temp.dir, "pid.txt");
    await writeFile(
      script,
      "import os, sys, time\nfrom pathlib import Path\nPath(sys.argv[1]).write_text(str(os.getpid()))\ntime.sleep(60)\n",
    );
    const controller = new AbortController();
    const pending = createPythonRunner().run(script, [pidFile], {
      cwd: temp.dir,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    try {
      let pid = 0;
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(pidFile, "utf8"));
          expect(pid).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );
      controller.abort();
      expect(await pending).toMatchObject({ aborted: true, timedOut: false });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await pending;
    }
    expect(
      await createPythonRunner("nonexistent-python").run(script, [], {
        cwd: temp.dir,
        timeoutMs: 1000,
        signal: AbortSignal.abort(),
      }),
    ).toMatchObject({ aborted: true, stderr: "" });
  });
});
