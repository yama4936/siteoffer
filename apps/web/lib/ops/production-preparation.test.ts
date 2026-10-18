import { randomUUID } from "node:crypto";
import type { workerRuntimes } from "@siteoffer/db";
import { expect, it } from "vitest";
import { productionPreparation } from "./production-preparation";

const now = new Date("2026-10-19T00:00:00Z");
type Runtime = typeof workerRuntimes.$inferSelect;
function worker(): Runtime {
  return {
    id: randomUUID(),
    mode: "standard",
    providers: [],
    heartbeatAt: now,
    capabilities: {
      version: 1,
      discoveryOnly: false,
      imageConfigured: false,
      generator: "codex",
      intakeIntervalMs: 5000,
      preparation: {
        auditCollector: "python",
        generationInput: "default",
        decision: { status: "configured", threshold: 55, criticalFlagsTrigger: false, demo: false },
      },
    },
    progress: { phase: "idle", since: now.toISOString(), completedAt: now.toISOString(), lastErrorAt: null },
  };
}
it("設定済みと実行成功を区別し、通知の内部データを返さない", () => {
  const row = worker();
  const result = productionPreparation([row], now);
  expect(result.map((r) => r.status)).toEqual(["configured", "configured", "configured"]);
  expect(result[2]!.detail).toContain("55点未満");
  expect(result[0]!.detail).toContain("診断結果で確認");
  const encoded = JSON.stringify(result);
  for (const privateValue of [row.id, "providers", "capabilities", "generationInput", "auditCollector"])
    expect(encoded).not.toContain(privateValue);
});
it("架空の取得元・固定入力・デモの判定条件を実運用と表示しない", () => {
  const row = worker();
  row.capabilities!.preparation = {
    auditCollector: "fixture",
    generationInput: "fixture",
    decision: { status: "configured", threshold: 55, criticalFlagsTrigger: false, demo: true },
  };
  expect(productionPreparation([row], now).map((r) => r.status)).toEqual(["demo", "demo", "demo"]);
});
it("点数と致命項目の未決を正確に表示し、致命項目だけの作成も隠さない", () => {
  const row = worker();
  row.capabilities!.preparation!.decision = {
    status: "pending",
    threshold: null,
    criticalFlagsTrigger: true,
    demo: false,
  };
  const policy = productionPreparation([row], now)[2]!;
  expect(policy.status).toBe("pending");
  expect(policy.detail).toContain("閾値は未設定");
  expect(policy.detail).toContain("致命項目でも対象");
});
it("停止・未来・旧ワーカー・収集専用を準備完了にしない", () => {
  for (const patch of [
    { heartbeatAt: new Date(now.getTime() - 45001) },
    { heartbeatAt: new Date(now.getTime() + 5001) },
    { capabilities: null },
    { capabilities: { ...worker().capabilities!, preparation: undefined } },
    { capabilities: { ...worker().capabilities!, discoveryOnly: true } },
  ])
    expect(productionPreparation([{ ...worker(), ...patch }], now).map((r) => r.status)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
});
it("動いている旧ワーカーを無視して新ワーカーだけで完了と断定しない", () => {
  const old = worker();
  delete old.capabilities!.preparation;
  expect(productionPreparation([worker(), old], now).every((r) => r.status === "unknown")).toBe(true);
  old.heartbeatAt = new Date(now.getTime() - 45001);
  expect(productionPreparation([worker(), old], now).every((r) => r.status === "configured")).toBe(true);
});
it("各ワーカーの入力・取得元・判定条件の違いを示す", () => {
  const different = worker();
  different.capabilities!.preparation!.auditCollector = "fixture";
  different.capabilities!.preparation!.generationInput = "fixture";
  different.capabilities!.preparation!.decision.threshold = 60;
  expect(productionPreparation([worker(), different], now).map((r) => r.status)).toEqual([
    "attention",
    "attention",
    "attention",
  ]);
});
it("不正な通知と評価設定の読み取り失敗を区別する", () => {
  const row = worker();
  row.capabilities!.preparation!.decision.status = "invalid";
  expect(productionPreparation([row], now)[2]!.status).toBe("attention");
  row.capabilities!.preparation!.decision = {
    status: "configured",
    threshold: null,
    criticalFlagsTrigger: false,
    demo: false,
  };
  expect(productionPreparation([row], now)[2]!.status).toBe("unknown");
});
