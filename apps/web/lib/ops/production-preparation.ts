import { assessWorkerIntake } from "@siteoffer/core";
import type { workerRuntimes } from "@siteoffer/db";

type Runtime = typeof workerRuntimes.$inferSelect;
export type PreparationItem = {
  id: "audit" | "input" | "decision";
  title: string;
  status: "configured" | "demo" | "pending" | "unknown" | "attention";
  label: string;
  detail: string;
};

/** Reject unknown, stale and inconsistent notifications. Never forward raw capabilities. */
export function productionPreparation(rows: Runtime[], now: Date): PreparationItem[] {
  const live = rows.filter((r) => assessWorkerIntake(r, now).live && !r.capabilities?.discoveryOnly);
  const snapshot = live.map((r) => (assessWorkerIntake(r, now).known ? r.capabilities?.preparation : undefined));
  const titles = { audit: "診断に使う取得元", input: "制作に渡す情報", decision: "提案を作る自動判定" } as const;
  function item(
    id: PreparationItem["id"],
    status: PreparationItem["status"],
    label: string,
    detail: string,
  ): PreparationItem {
    return { id, title: titles[id], status, label, detail };
  }
  const unknown = (id: PreparationItem["id"]) =>
    item(
      id,
      "unknown",
      "未確認",
      live.length
        ? "この設定を確認できない稼働通知があります。更新した制作ワーカーで起動し直し、再読み込みしてください。"
        : "制作ワーカーの稼働を確認できません。処理の状況で起動・接続を確認してください。",
    );
  function mode(
    id: "audit" | "input",
    key: "auditCollector" | "generationInput",
    real: string,
    fixture: string,
    realLabel: string,
    demoLabel: string,
  ) {
    const values = snapshot.map((s) => s?.[key]);
    if (!values.length || values.some((v) => v !== real && v !== fixture)) return unknown(id);
    if (new Set(values).size !== 1)
      return item(
        id,
        "attention",
        "ワーカー間で設定が異なります",
        "依頼を処理するワーカーによって結果が変わるため、全制作ワーカーの設定を揃えてください。",
      );
    return values[0] === real
      ? item(
          id,
          "configured",
          realLabel,
          id === "audit"
            ? "実サイトを取得する設定です。取得の成功・根拠は案件ごとの診断結果で確認します。"
            : "会社・診断・承認画像をもとに入力を組み立てます。情報の確認と画像の承認は案件ごとに必要です。",
        )
      : item(
          id,
          "demo",
          demoLabel,
          id === "audit"
            ? "保存済みの架空サンプルを使います。対象企業の実サイトを取得した診断ではありません。"
            : "固定サンプルを使います。実企業への提案や納品の内容として扱わないでください。",
        );
  }
  const result = [
    mode("audit", "auditCollector", "python", "fixture", "実サイトの取得を設定済み", "架空サンプルで動作確認"),
    mode("input", "generationInput", "default", "fixture", "案件ごとの情報を使用", "固定サンプルで動作確認"),
  ];
  const policies = snapshot.map((s) => s?.decision);
  const valid =
    policies.length > 0 &&
    policies.every(
      (p) =>
        p &&
        ["configured", "pending", "invalid"].includes(p.status) &&
        typeof p.demo === "boolean" &&
        (p.threshold === null ||
          (typeof p.threshold === "number" &&
            Number.isFinite(p.threshold) &&
            p.threshold >= 0 &&
            p.threshold <= 100)) &&
        (p.criticalFlagsTrigger === null || typeof p.criticalFlagsTrigger === "boolean") &&
        (p.status !== "configured" || (p.threshold !== null && p.criticalFlagsTrigger !== null)) &&
        (p.status !== "pending" || p.threshold === null || p.criticalFlagsTrigger === null),
    );
  if (!valid) result.push(unknown("decision"));
  else if (policies.some((p) => p!.status === "invalid"))
    result.push(
      item(
        "decision",
        "attention",
        "判定設定を読み取れません",
        "制作ワーカーの評価設定を管理者が確認してください。自動判定の準備ができたとは扱いません。",
      ),
    );
  else if (
    new Set(policies.map((p) => JSON.stringify([p!.status, p!.threshold, p!.criticalFlagsTrigger, p!.demo]))).size !== 1
  )
    result.push(
      item(
        "decision",
        "attention",
        "ワーカー間で判定設定が異なります",
        "全制作ワーカーの評価設定を揃えてください。判定結果は案件ごとの診断で確認します。",
      ),
    );
  else {
    const p = policies[0]!;
    const threshold = p.threshold === null ? "点数の閾値は未設定" : `総合点が${p.threshold}点未満なら対象`;
    const critical =
      p.criticalFlagsTrigger === null
        ? "致命項目の扱いは未決"
        : p.criticalFlagsTrigger
          ? "致命項目でも対象"
          : "致命項目だけでは対象にしない";
    result.push(
      item(
        "decision",
        p.demo ? "demo" : p.status === "configured" ? "configured" : "pending",
        p.demo ? "動作確認用の判定条件" : p.status === "pending" ? "運営の判断が必要" : "判定条件を設定済み",
        `${threshold}。${critical}。${p.status === "pending" ? "条件によって判定保留になります。運営が評価データを確認して条件を決めてください。" : "評価不能・根拠不足の場合は保留します。設定済みでも提案やサイトの承認は自動では行いません。"}`,
      ),
    );
  }
  return result;
}
