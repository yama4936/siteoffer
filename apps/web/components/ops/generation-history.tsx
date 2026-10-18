import type { generationJobs } from "@siteoffer/db";
import { GENERATION_INTERRUPTED_MESSAGE, generationConnectionLost } from "@siteoffer/generation/lease";
import Link from "next/link";
import { DiscoveryRefresh } from "@/components/ops/discovery-refresh";
import { Badge } from "@/components/ui/badge";
import { fmtDate, JOB_STATUS_LABEL } from "@/lib/ops/format";
import { type GenerationRetryDetail, generationRetryPresentation } from "@/lib/ops/generation-retries";

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
  sandbox_stop_unconfirmed:
    "生成処理の停止確認を待っています。自動再試行と新しい生成を止めています。ワーカーの稼働を確認してください。",
  sandbox_stop_pending:
    "別の生成処理の停止確認を待っているため開始しませんでした。確認後、元の依頼から再試行できます。",
  sandbox_stop_confirmed:
    "停止を確認しました。遅れて届いた結果は採用していません。必要な場合は元の依頼から再試行できます。",
  empty_response: "生成結果が返りませんでした。",
  invalid_json: "生成結果の形式を読み取れませんでした。",
  schema_violation: "必要な内容を満たす生成結果が得られませんでした。",
  fact_violation: "生成結果を確認済みの企業情報と照合できませんでした。会社情報と制作条件を確認してください。",
};

export function GenerationHistory({
  jobs,
  retries = {},
  companyId,
  now,
}: {
  jobs: GenerationJob[];
  retries?: Record<string, GenerationRetryDetail>;
  companyId: string;
  now: Date;
}) {
  return (
    <section aria-label="生成の実行履歴" id="generation-history" className="mt-4 space-y-3 scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">生成の実行履歴</h3>
        <Link className="text-sm text-primary underline" href={`/ops/processing?company=${companyId}`}>
          この企業の処理状況を確認
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">直近20件。生成の完了と、サイトの検査・承認・公開は別の工程です。</p>
      <details className="rounded-lg border bg-muted/30 p-3 text-sm">
        <summary className="cursor-pointer font-medium">再試行・停止の見方</summary>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-xs leading-relaxed text-muted-foreground">
          <li>
            「検査後の再試行中」は、同じ依頼内で検査結果を次の生成へ渡しています。重ねて同じ制作を依頼する必要はありません。
          </li>
          <li>
            確認事項が記録されている試行では、対象項目を開いて確認できます。過去の履歴に記録がない場合は、修正して再試行したと推測しません。
          </li>
          <li>「停止確認待ち」は、新しい生成も止めています。この企業の処理状況で次の確認を見てください。</li>
        </ul>
      </details>
      {jobs.some(
        (j) => j.status === "queued" || j.status === "running" || j.errorCode === "sandbox_stop_unconfirmed",
      ) && <DiscoveryRefresh />}
      {!jobs.length && (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">生成履歴はまだありません。</p>
      )}
      <ul className="space-y-3">
        {jobs.map((j) => {
          const lost = generationConnectionLost(j, now);
          const active = j.status === "queued" || j.status === "running";
          const stopPending = j.errorCode === "sandbox_stop_unconfirmed";
          const failed = lost || j.status === "failed" || j.status === "needs_review";
          const retry = generationRetryPresentation(j.attempts, retries[j.id]);
          return (
            <li key={j.id} className="rounded-xl border bg-card p-4 text-sm" data-generation-id={j.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-semibold">{PURPOSES[j.purpose]}</h4>
                <Badge variant={failed ? "warning" : j.status === "succeeded" ? "success" : "secondary"}>
                  {lost
                    ? "接続切れ"
                    : stopPending
                      ? "停止確認待ち"
                      : active && !j.leaseUntil
                        ? "稼働未確認"
                        : j.status === "running" && retry
                          ? "検査後の再試行中"
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
                      : retry
                        ? "検査結果を渡して、同じ依頼内で再試行しています。重ねて制作を依頼する必要はありません。"
                        : "生成処理を実行しています。この画面を開いたままにする必要はありません。"}
                </p>
              ) : null}
              {retry && (
                <details
                  className="mt-3 rounded-lg border border-blue-200 bg-blue-50/60 p-3"
                  open={active && !lost && !stopPending}
                >
                  <summary className="cursor-pointer font-medium text-blue-900">{retry.title}</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-blue-900">
                    {retry.rules.map((rule) => (
                      <li key={rule}>{rule}</li>
                    ))}
                  </ul>
                  {retry.fields.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">対象：{retry.fields.join("・")}</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    この試行の開始時に渡した内容です。修正済み・承認済み・公開済みを示すものではありません。
                  </p>
                  {failed && !stopPending && retry.companyInfo && (
                    <Link
                      className="mt-2 inline-block text-xs text-primary underline"
                      href={`/ops/companies/${companyId}#company-profile`}
                    >
                      確認済みの会社情報を見る
                    </Link>
                  )}
                </details>
              )}
              {failed && !stopPending && (
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
