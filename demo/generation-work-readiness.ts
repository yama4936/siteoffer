import type { PendingWork } from "./generation-pending.ts";
import type { PreflightCheck } from "./generation-preflight.ts";

// pendingGenerationWork の通知件数。SQLの表示名が変わった場合も停止を推測しない。
const runtimeKind = "稼働通知（停止後45秒まで残ります）";

/** 読み取り済みの件数を表示するだけで、方式切替の判定・停止・再実行は行わない。 */
export function generationWorkReadiness(rows: readonly PendingWork[]): PreflightCheck[] {
  if (rows.some((row) => typeof row.kind !== "string" || !row.kind.trim() || !Number.isSafeInteger(row.n) || row.n < 0))
    throw new Error("未完了業務と稼働通知の件数を確認できません。");
  const runtimes = rows.filter((row) => row.kind === runtimeKind);
  const work = rows.filter((row) => row.kind !== runtimeKind);
  if (runtimes.length !== 1 || work.length === 0) throw new Error("未完了業務と稼働通知の件数を確認できません。");
  const pending = work.filter((row) => row.n > 0);
  const live = runtimes[0]!.n;
  return [
    {
      name: "未完了の業務処理",
      ok: pending.length === 0,
      message: pending.length
        ? `${pending.map((row) => `${row.kind} ${row.n}件`).join("、")}。元の生成方式で結果と必要な対応を確認してください。稼働通知は別に表示します。`
        : "未完了の受付・制作・キュー・工程は0件です。ワーカーの稼働通知は未完了業務に数えていません。",
    },
    {
      name: "方式切替前の稼働確認",
      ok: live === 0,
      message: live
        ? `直近45秒の稼働通知は${live}件です。${pending.length ? "未完了業務への対応後、" : ""}方式を切り替える直前に通常停止し、停止後45秒以上待って再確認してください。プロセスを自動停止していません。`
        : "直近45秒の稼働通知は0件です。プロセスの停止自体を証明するものではないため、方式を切り替える直前にも確認します。",
    },
  ];
}
