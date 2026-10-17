import { assessWorkerIntake, type Clock } from "@siteoffer/core";
import { type DbOrTx, workerRuntimes } from "@siteoffer/db";
import { gte } from "drizzle-orm";

export const DISCOVERY_PROVIDERS = ["fixture", "nta-corporate-number"] as const;
export const WORKER_FRESH_MS = 45_000;
export async function discoveryAvailability(db: DbOrTx, clock: Clock) {
  const rows = await db
    .select()
    .from(workerRuntimes)
    .where(gte(workerRuntimes.heartbeatAt, new Date(clock.now().getTime() - WORKER_FRESH_MS)));
  const live = rows.filter((row) => assessWorkerIntake(row, clock.now()).live);
  return DISCOVERY_PROVIDERS.map((provider) => {
    const configured = live.length > 0 && live.every((worker) => worker.providers.includes(provider));
    const ready = configured && live.some((worker) => !assessWorkerIntake(worker, clock.now()).dispatchAttention);
    const demo = live.length > 0 && live.every((worker) => worker.mode === "demo");
    const reason = ready
      ? "稼働中のワーカーが受け付けます"
      : configured
        ? "取得元は設定済みですが、受付エラーまたは受付待機の更新遅れがあります。処理の状況でワーカーを確認してください。登録済みの依頼を重ねる必要はありません。"
        : !live.length
          ? "収集ワーカーの稼働を確認できません。起動・DB接続を確認してください（45秒間応答なし）"
          : live.some((worker) => worker.providers.includes(provider))
            ? "ワーカー間で取得元の設定が異なります。共有キューを使う全ワーカーの取得元設定を揃えてください"
            : demo
              ? "デモ起動のため実データ収集は無効です。国税庁APIの設定後、実収集モードで起動してください"
              : provider === "nta-corporate-number"
                ? "この取得元は無効です。NTA_APPLICATION_ID と SITEOFFER_DISCOVERY_PROVIDERS=nta を設定してワーカーを再起動してください"
                : "架空企業の動作確認は無効です。デモを使う場合は start-demo.cmd で起動してください";
    return {
      provider,
      ready,
      reason,
      mode: demo ? "demo" : "standard",
    };
  });
}
