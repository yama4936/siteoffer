import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { workerRuntimes } from "@siteoffer/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildWorkerDeps, resolveWorkerConfig } from "../src/config.ts";
import { startWorkerHeartbeat } from "../src/heartbeat.ts";
import { decisionPreparation, readWorkerPreparation } from "../src/preparation.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
beforeEach(async () => {
  e = await setupEnv();
});
afterEach(async () => {
  await e.cleanup();
});

it("未決の点数・致命項目を勝手に確定せず、無効な値と区別する", () => {
  expect(decisionPreparation({ proposal: { threshold: null, critical_flags_trigger: null } }, false)).toEqual({
    status: "pending",
    threshold: null,
    criticalFlagsTrigger: null,
    demo: false,
  });
  expect(decisionPreparation({ proposal: { threshold: null, critical_flags_trigger: true } }, false)).toMatchObject({
    status: "pending",
    criticalFlagsTrigger: true,
  });
  expect(decisionPreparation({ proposal: { threshold: 0, critical_flags_trigger: false } }, false)).toMatchObject({
    status: "configured",
    threshold: 0,
  });
  for (const raw of [
    null,
    [],
    { proposal: [] },
    { proposal: { threshold: "50" } },
    { proposal: { threshold: NaN } },
    { proposal: { threshold: 101 } },
    { proposal: { threshold: -1 } },
    { proposal: { min_coverage: 2 } },
    { proposal: { critical_flags_trigger: "true" } },
  ])
    expect(decisionPreparation(raw, false).status).toBe("invalid");
});

it("部品を組み立てた構成を通知し、認証・パス・未採用モデルを公開しない", async () => {
  const config = resolveWorkerConfig({
    SITEOFFER_GENERATION_INPUT: "fixture",
    SITEOFFER_EVAL_CONFIG: e.deps.audit.options.paths.configPath,
  });
  if (!config.ok) throw Error("Expected test configuration");
  const deps = buildWorkerDeps(config.value, e.deps);
  const generated = vi.spyOn(deps.generation.generator, "generate");
  const stop = await startWorkerHeartbeat(deps, "demo");
  try {
    const [row] = await e.db.select().from(workerRuntimes);
    expect(row!.capabilities?.preparation).toMatchObject({
      auditCollector: "fixture",
      generationInput: "fixture",
      decision: { status: "pending", threshold: null },
    });
    const encoded = JSON.stringify(row!.capabilities);
    for (const privateValue of [
      e.deps.audit.options.paths.configPath,
      "codexAuthFile",
      "requestedModel",
      "OPENAI_API_KEY",
    ])
      expect(encoded).not.toContain(privateValue);
    expect(generated).not.toHaveBeenCalled();
  } finally {
    await stop();
  }
});

it("設定変更を次の稼働通知で読み直し、書き換えや生成を行わない", async () => {
  const stop = await startWorkerHeartbeat(e.deps, "demo");
  try {
    const file = e.deps.audit.options.paths.configPath;
    const cfg = JSON.parse(await readFile(file, "utf8"));
    cfg.proposal.threshold = 55;
    cfg.proposal.critical_flags_trigger = false;
    const saved = JSON.stringify(cfg);
    await writeFile(file, saved);
    await stop.report("idle", "dispatch");
    const [row] = await e.db.select().from(workerRuntimes);
    expect(row!.capabilities?.preparation?.decision).toEqual({
      status: "configured",
      threshold: 55,
      criticalFlagsTrigger: false,
      demo: false,
    });
    expect(await readFile(file, "utf8")).toBe(saved);
    expect(row!.capabilities?.preparation?.auditCollector).toBe("unknown");
  } finally {
    await stop();
  }
});

it("壊れた・過大・欠落した評価設定は公開情報へ出さず、通知自体は止めない", async () => {
  const file = e.deps.audit.options.paths.configPath;
  for (const text of [
    "test-only-private-parser-text",
    " ".repeat(65537),
    "",
    JSON.stringify({ proposal: { threshold: "test-only-private" } }),
  ]) {
    await writeFile(file, text);
    const snapshot = await readWorkerPreparation(e.deps);
    expect(snapshot.decision.status).toBe("invalid");
    expect(JSON.stringify(snapshot)).not.toContain("test-only-private");
  }
  e.deps.audit.options.paths.configPath = `${file}.missing`;
  const stop = await startWorkerHeartbeat(e.deps, "demo");
  try {
    expect((await e.db.select().from(workerRuntimes))[0]!.capabilities?.preparation?.decision.status).toBe("invalid");
  } finally {
    await stop();
  }
});

it("動作確認専用の判定設定を実運用の採用条件と区別する", async () => {
  e.deps.audit.options.paths.configPath = fileURLToPath(
    new URL("../../../config/site-evaluation.demo.json", import.meta.url),
  );
  expect((await readWorkerPreparation(e.deps)).decision).toMatchObject({
    demo: true,
    status: "configured",
    threshold: 70,
  });
});
