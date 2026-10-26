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
      search: searchDescription(live.map((worker) => worker.capabilities?.siteSearch)),
    };
  });
}

function searchDescription(searches: ({ provider: string; maxPerRun: number } | undefined)[]) {
  if (
    !searches.length ||
    searches.some(
      (search) =>
        !search ||
        !["fixture", "none", "tavily"].includes(search.provider) ||
        !Number.isSafeInteger(search.maxPerRun) ||
        search.maxPerRun < 1 ||
        search.maxPerRun > 1000,
    )
  )
    return "サイト検索の設定を確認できません。ワーカーの通常の再起動後に再確認してください。";
  const first = searches[0]!;
  if (searches.some((search) => search!.provider !== first.provider || search!.maxPerRun !== first.maxPerRun))
    return "ワーカー間でサイト検索の設定が異なります。全ワーカーの設定を揃えてください。";
  if (first.provider === "fixture") return "サイト検索は架空の結果による動作確認です。実サイトの検索は行いません。";
  if (first.provider === "none") return "サイト検索は無効です。法人情報の収集までを行います。";
  return `Tavilyによるサイト候補検索を設定済み（1試行あたり最大${first.maxPerRun}回）。接続・残高は未確認です。検索結果は公式サイトと断定せず、運営が確認します。再試行では検索料金が再度発生する場合があります。`;
}
