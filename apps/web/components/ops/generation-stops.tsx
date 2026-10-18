import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { fmtDate } from "@/lib/ops/format";
import { GENERATION_PURPOSE_LABELS } from "@/lib/ops/generation-stops";
import type { getProcessingOverview } from "@/lib/ops/processing";

type Data = Extract<Awaited<ReturnType<typeof getProcessingOverview>>, { ok: true }>["value"]["generationStops"];
export function GenerationStops({
  data,
  companyId,
  previousHref,
  nextHref,
}: {
  data: Data;
  companyId?: string;
  previousHref: string;
  nextHref: string;
}) {
  return (
    <section
      id="generation-stops"
      aria-label="生成の停止確認待ち"
      className={`mb-6 scroll-mt-24 rounded-xl border p-4 sm:p-5 ${data.total ? "border-amber-300 bg-amber-50/50" : "bg-card"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">生成の停止確認</h2>
        <Badge variant={data.total ? "warning" : "secondary"}>{data.total}件</Badge>
      </div>
      {!data.total ? (
        <p className="mt-2 text-sm text-muted-foreground">停止確認待ちの生成はありません。</p>
      ) : (
        <>
          <p className="mt-2 text-sm">
            同じ生成方式の新しい制作を保留しています。停止確認が済むまで、依頼を繰り返す必要はありません。
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            全案件の停止確認待ちを表示しています。停止を確認しても、遅れて届いた生成結果は採用しません。
          </p>
          <ul className="mt-4 space-y-3">
            {data.items.map((job) => (
              <li key={job.id} id={`generation-stop-${job.id}`} className="rounded-lg border bg-card p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 basis-64">
                    <h3 className="break-words font-semibold">
                      {job.companyName ?? "企業未指定の生成"} · {GENERATION_PURPOSE_LABELS[job.purpose]}
                    </h3>
                    {companyId && job.companyId !== companyId && (
                      <p className="mt-1 text-xs text-muted-foreground">表示中の企業とは別の生成です。</p>
                    )}
                    <p className="mt-2 font-medium text-amber-800">{job.next.label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {job.generator === "codex"
                        ? "実生成"
                        : job.generator === "mock"
                          ? "動作確認用"
                          : "生成方式の確認が必要"}{" "}
                      · 確認待ち {fmtDate(job.since ?? job.createdAt)}から
                    </p>
                  </div>
                  {job.companyId && (
                    <Link
                      className="rounded-md border px-3 py-2 text-primary"
                      href={`/ops/companies/${job.companyId}#generation-history`}
                    >
                      対象の生成履歴を確認
                    </Link>
                  )}
                </div>
                <details className="mt-3 border-t pt-3">
                  <summary className="cursor-pointer text-primary">次に確認すること</summary>
                  <p className="mt-2 leading-relaxed">{job.next.detail}</p>
                  <p className="mt-2 break-all text-xs text-muted-foreground">照会番号：{job.id}</p>
                </details>
              </li>
            ))}
          </ul>
          {data.pages > 1 && (
            <nav aria-label="停止確認待ちのページ" className="mt-4 flex flex-wrap items-center gap-3 text-sm">
              {data.page > 1 && (
                <Link className="rounded-md border bg-card px-3 py-2 text-primary" href={previousHref}>
                  前の20件
                </Link>
              )}
              <span>
                {data.page} / {data.pages}ページ · 全{data.total}件
              </span>
              {data.page < data.pages && (
                <Link className="rounded-md border bg-card px-3 py-2 text-primary" href={nextHref}>
                  次の20件
                </Link>
              )}
            </nav>
          )}
        </>
      )}
    </section>
  );
}
