import type { generationJobs } from "@siteoffer/db";
import { GENERATION_INTERRUPTED_MESSAGE, generationConnectionLost } from "@siteoffer/generation/lease";
import Link from "next/link";
import { DiscoveryRefresh } from "@/components/ops/discovery-refresh";
import { Badge } from "@/components/ui/badge";
import { fmtDate, JOB_STATUS_LABEL } from "@/lib/ops/format";

type GenerationJob = typeof generationJobs.$inferSelect;

const PURPOSES: Record<GenerationJob["purpose"], string> = {
  evaluation: "サイト診断",
  proposal_text: "改善提案文",
  call_script: "営業台本",
  faq: "想定問答",
  demo_site: "提案サイト",
  delivery_site: "納品サイト",
};
const REASONS: Record<string, string> = {
  aborted: "元の処理が中断されたため、この生成を終了しました。",
  timeout: "生成が制限時間を超えました。",
  sandbox_error: "生成の実行環境でエラーが発生しました。認証・ワーカーの設定を確認してください。",
  empty_response: "生成結果が返りませんでした。",
  invalid_json: "生成結果の形式を読み取れませんでした。",
  schema_violation: "必要な内容を満たす生成結果が得られませんでした。",
  fact_violation: "生成結果が確認済みの企業情報と一致しませんでした。入力情報を確認してください。",
};

export function GenerationHistory({ jobs, companyId, now }: { jobs: GenerationJob[]; companyId: string; now: Date }) {
  return (
    <section aria-label="生成の実行履歴" id="generation-history" className="mt-4 space-y-3 scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">生成の実行履歴</h3>
        <Link className="text-sm text-primary underline" href={`/ops/processing?company=${companyId}`}>
          この企業の処理状況を確認
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">直近20件。生成の完了と、サイトの検査・承認・公開は別の工程です。</p>
      {jobs.some((j) => j.status === "queued" || j.status === "running") && <DiscoveryRefresh />}
      {!jobs.length && (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">生成履歴はまだありません。</p>
      )}
      <ul className="space-y-3">
        {jobs.map((j) => {
          const lost = generationConnectionLost(j, now);
          const active = j.status === "queued" || j.status === "running";
          const failed = lost || j.status === "failed";
          return (
            <li key={j.id} className="rounded-xl border bg-card p-4 text-sm" data-generation-id={j.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-semibold">{PURPOSES[j.purpose]}</h4>
                <Badge variant={failed ? "warning" : j.status === "succeeded" ? "success" : "secondary"}>
                  {lost
                    ? "接続切れ"
                    : active && !j.leaseUntil
                      ? "稼働未確認"
                      : (JOB_STATUS_LABEL[j.status] ?? j.status)}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                登録：{fmtDate(j.createdAt)} · 試行 {j.attempts}回{j.generator === "mock" ? " · 動作確認用" : ""}
              </p>
              {lost ? (
                <p className="mt-2 text-amber-800">{GENERATION_INTERRUPTED_MESSAGE}</p>
              ) : failed ? (
                <p className="mt-2 text-amber-800">
                  {REASONS[j.errorCode ?? ""] ??
                    "生成を完了できませんでした。元の依頼で停止理由と設定を確認してください。"}
                </p>
              ) : active ? (
                <p className="mt-2 text-muted-foreground">
                  {!j.leaseUntil
                    ? "稼働確認に未対応の履歴です。処理状況でワーカーを確認してください。"
                    : j.status === "queued"
                      ? "生成の実行枠を待っています。この画面を開いたままにする必要はありません。"
                      : "生成処理を実行しています。この画面を開いたままにする必要はありません。"}
                </p>
              ) : null}
              {failed && (
                <p className="mt-2 text-xs text-muted-foreground">
                  過去の実行履歴です。元の依頼が再試行・完了している場合は、追加の再実行は不要です。
                </p>
              )}
              <details className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                <summary className="cursor-pointer">実行の詳細</summary>
                <dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr] [&_dd]:min-w-0 [&_dd]:break-all">
                  <dt>生成方式</dt>
                  <dd>{j.generator}</dd>
                  <dt>要求／応答モデル</dt>
                  <dd>
                    {j.requestedModel ?? "未記録"} / {j.responseModel ?? "未記録"}
                  </dd>
                  <dt>プロンプト版</dt>
                  <dd>{j.promptVersion}</dd>
                  <dt>開始／終了</dt>
                  <dd>
                    {fmtDate(j.startedAt)} / {fmtDate(j.finishedAt)}
                  </dd>
                  <dt>稼働確認の期限</dt>
                  <dd>{fmtDate(j.leaseUntil)}</dd>
                  <dt>結果の分類</dt>
                  <dd>{lost ? "interrupted" : (j.errorCode ?? "—")}</dd>
                </dl>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
