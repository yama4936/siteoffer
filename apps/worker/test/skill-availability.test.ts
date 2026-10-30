import { workerRuntimes } from "@siteoffer/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startWorkerHeartbeat } from "../src/heartbeat.ts";
import { skillAvailability } from "../src/skills/index.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
beforeEach(async () => {
  e = await setupEnv();
});
afterEach(async () => {
  await e.cleanup();
});

it.each([
  { kind: null, reported: "none", ready: false, text: "スキル実行が設定されていません" },
  { kind: "codex", reported: "codex", ready: true, text: "隔離コンテナのCodex SDK" },
  { kind: "fixture", reported: "fixture", ready: true, text: "固定の試験成果物" },
  { kind: "fake", reported: "none", ready: false, text: "スキル実行が設定されていません" },
])("実行器 $kind の稼働通知と受付案内を区別する", async ({ kind, reported, ready, text }) => {
  const execute = vi.fn(async () => {
    throw new Error("受付案内から実行器を呼んではいけません");
  });
  if (kind)
    e.deps.skills = {
      executor: { kind, requestedModel: null, execute },
      repoRoot: e.dir,
      reportsRoot: e.dir,
      workRoot: e.dir,
    };
  const stop = await startWorkerHeartbeat(e.deps, "standard");
  try {
    const [row] = await e.db.select().from(workerRuntimes);
    expect(row!.capabilities?.skillRunner).toBe(reported);
    const availability = await skillAvailability(e.db, e.clock);
    expect(availability).toMatchObject({ ready, reason: expect.stringContaining(text) });
    if (kind === "fixture") {
      expect(availability.reason).toContain("Codex・外部APIは実行しません");
      expect(availability.reason).not.toContain("隔離コンテナのCodex SDK");
      e.clock.advance(45_001);
      expect(await skillAvailability(e.db, e.clock)).toMatchObject({
        ready: false,
        reason: expect.stringContaining("ワーカーの稼働を確認できません"),
      });
    }
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await stop();
  }
});
