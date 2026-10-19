import Link from "next/link";
import { notFound } from "next/navigation";
import { AuditView } from "@/components/ops/audit-view";
import { Forbidden } from "@/components/ops/ui";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { EmptyState, PageHeader, Section } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import type { AuditFindingSummary } from "@/lib/ops/audit-comparison";
import { getCompanyAuditHistory } from "@/lib/ops/audit-history";
import { AUDIT_HISTORY_STATUS, auditHistoryHref, parseAuditHistoryQuery } from "@/lib/ops/audit-history-query";
import { fmtDate, shortId } from "@/lib/ops/format";
import { getCurrentActor } from "@/lib/session";

const decision = { create: "提案書を作る", skip: "作らない", hold: "判定保留" };
export default async function AuditHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { companyId } = await params,
    sp = await searchParams,
    urlParams = new URLSearchParams();
  for (const key of ["status", "sort", "page", "audit"]) {
    const value = sp[key];
    if (Array.isArray(value)) for (const entry of value) urlParams.append(key, entry);
    else if (value !== undefined) urlParams.set(key, value);
  }
  const query = parseAuditHistoryQuery(urlParams);
  if (!query) notFound();
  const result = await getCompanyAuditHistory(getDb(), await getCurrentActor(), companyId, query);
  if (!result.ok) return result.error === "forbidden" ? <Forbidden /> : notFound();
  const data = result.value,
    base = auditHistoryHref(data.company.id),
    { selected, previous, comparison } = data;
  return (
    <>
      <Link
        className="mb-4 inline-block text-primary text-sm underline"
        href={`/ops/companies/${data.company.id}#company-audit`}
      >
        企業の診断結果へ戻る
      </Link>
      <PageHeader
        title={`${data.company.name}の診断履歴`}
        description="保存済みの結果と根拠を確認します。この画面では新しい診断を実行しません。"
      />
      <Section
        title="診断を選ぶ"
        id="audit-history"
        description={`保存済み ${data.allTotal}件。日時が新しい順・古い順、診断の状態で探せます。`}
      >
        <form
          method="get"
          action={base}
          key={auditHistoryHref(data.company.id, data.query)}
          className="mb-4 grid grid-cols-2 items-end gap-3 rounded-xl border bg-card p-4 sm:flex sm:flex-wrap"
          aria-label="診断履歴の絞り込み"
        >
          <Field htmlFor="audit-history-status" label="診断の状態" className="min-w-0 sm:flex-1">
            <NativeSelect id="audit-history-status" name="status" defaultValue={data.query.status}>
              {Object.entries(AUDIT_HISTORY_STATUS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field htmlFor="audit-history-sort" label="並び順" className="min-w-0 sm:flex-1">
            <NativeSelect id="audit-history-sort" name="sort" defaultValue={data.query.sort}>
              <option value="newest">新しい順</option>
              <option value="oldest">古い順</option>
            </NativeSelect>
          </Field>
          <button type="submit" className={`${buttonVariants({ size: "sm" })} justify-self-start`}>
            絞り込む
          </button>
          <a href={base} className="text-primary text-sm underline">
            すべて表示
          </a>
        </form>
        <section
          className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm"
          aria-label="診断履歴のページ"
        >
          <p role="status">
            {data.total ? ((data.page - 1) * data.pageSize + 1).toLocaleString("ja-JP") : 0}〜
            {Math.min(data.page * data.pageSize, data.total).toLocaleString("ja-JP")}件 /{" "}
            {data.total.toLocaleString("ja-JP")}件 · {data.page} / {data.pages}ページ
          </p>
          <nav aria-label="診断履歴の前後のページ" className="flex gap-3">
            {data.page > 1 ? (
              <Link
                className="text-primary underline"
                href={auditHistoryHref(data.company.id, { ...data.query, audit: undefined, page: data.page - 1 })}
              >
                前の25件
              </Link>
            ) : (
              <span className="text-muted-foreground">前の25件</span>
            )}
            {data.page < data.pages ? (
              <Link
                className="text-primary underline"
                href={auditHistoryHref(data.company.id, { ...data.query, audit: undefined, page: data.page + 1 })}
              >
                次の25件
              </Link>
            ) : (
              <span className="text-muted-foreground">次の25件</span>
            )}
          </nav>
        </section>
        {data.items.length ? (
          <>
            <div className="grid gap-3 sm:hidden">
              {data.items.map((item) => (
                <article
                  key={item.id}
                  className={`min-w-0 rounded-xl border p-4 ${item.id === selected?.id ? "border-primary/30 bg-primary/5" : "bg-card"}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <Link
                        href={auditHistoryHref(data.company.id, { ...data.query, audit: item.id }, true)}
                        className="text-primary text-sm font-medium underline"
                        aria-current={item.id === selected?.id ? "true" : undefined}
                      >
                        {fmtDate(item.createdAt)}
                      </Link>
                      <p className="mt-1 text-xs">
                        {AUDIT_HISTORY_STATUS[item.status]} · {shortId(item.id)}
                        {item.id === selected?.id ? "（選択中）" : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-muted-foreground text-xs">総合点</p>
                      <p className="font-semibold tabular-nums">
                        {item.totalScore ?? "—"}
                        {item.scoreConfirmed !== true && item.totalScore !== null ? (
                          <span className="ml-1 text-xs text-amber-800">未確定</span>
                        ) : null}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 break-all text-xs text-muted-foreground">{item.targetUrl}</p>
                  <p className="mt-2 text-xs">判定：{item.decision ? decision[item.decision] : "未記録"}</p>
                </article>
              ))}
            </div>
            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>受付日時・結果</TableHead>
                    <TableHead>診断対象</TableHead>
                    <TableHead>総合点</TableHead>
                    <TableHead>判定</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((item) => (
                    <TableRow key={item.id} className={item.id === selected?.id ? "bg-primary/5" : undefined}>
                      <TableCell className="min-w-40">
                        <Link
                          href={auditHistoryHref(data.company.id, { ...data.query, audit: item.id }, true)}
                          className="text-primary underline"
                          aria-current={item.id === selected?.id ? "true" : undefined}
                        >
                          {fmtDate(item.createdAt)}
                        </Link>
                        <p className="mt-1 text-xs">
                          {AUDIT_HISTORY_STATUS[item.status]} · {shortId(item.id)}
                          {item.id === selected?.id ? "（選択中）" : ""}
                        </p>
                      </TableCell>
                      <TableCell className="min-w-64 max-w-80 break-all whitespace-normal text-xs">
                        {item.targetUrl}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {item.totalScore ?? "—"}
                        {item.scoreConfirmed !== true && item.totalScore !== null ? (
                          <span className="ml-1 text-xs text-amber-800">未確定</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {item.decision ? decision[item.decision] : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : (
          <EmptyState>{data.allTotal ? "条件に合う診断はありません。" : "診断はまだありません。"}</EmptyState>
        )}
      </Section>
      {selected && (
        <Section
          id="audit-detail"
          title="選択した診断の結果"
          className="scroll-mt-24"
          description={`${fmtDate(selected.createdAt)} · 記録番号 ${selected.id}`}
          actions={
            <Link href="#audit-history" className="text-primary text-sm underline">
              履歴一覧へ
            </Link>
          }
        >
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge variant="outline">保存済みの診断</Badge>
            <p className="text-muted-foreground text-sm">
              現在のサイトの状態や、営業開始の承認を示すものではありません。
            </p>
          </div>
          {data.selectedOutsideFilter && (
            <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm">
              この診断は現在の絞り込みの対象外ですが、指定した記録を表示しています。
            </p>
          )}
          <section aria-label="同じ対象の前回診断との比較" className="mb-5 space-y-3 rounded-xl border bg-card p-4">
            <h3 className="font-semibold">同じ対象の前回診断との比較</h3>
            {previous && comparison ? (
              <>
                <p className="text-sm">
                  前回：
                  <Link
                    href={auditHistoryHref(data.company.id, { audit: previous.id }, true)}
                    className="text-primary underline"
                  >
                    {fmtDate(previous.createdAt)} の保存結果
                  </Link>
                </p>
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="text-sm">
                    総合点 {previous.totalScore ?? "—"} → {selected.totalScore ?? "—"}
                  </span>
                  <strong className="text-xl tabular-nums">
                    {comparison.scoreDelta === null
                      ? "点差は表示しません"
                      : `点差 ${Number(comparison.scoreDelta) > 0 ? "+" : ""}${comparison.scoreDelta}`}
                  </strong>
                </div>
                {comparison.reasons.map((reason) => (
                  <p key={reason} className="text-sm text-amber-900">
                    {reason}
                  </p>
                ))}
                {comparison.coverageChanged && (
                  <p className="text-sm text-amber-900">
                    カバー率が異なります。取得できた項目と根拠も確認してください。
                  </p>
                )}
                <dl className="grid gap-3 rounded-lg bg-muted/30 p-3 text-xs sm:grid-cols-3">
                  <div className="min-w-0 break-words">
                    <dt className="text-muted-foreground">評価基準の版（前回 → 今回）</dt>
                    <dd className="mt-1">
                      {previous.rubricVersion ?? "未記録"} → {selected.rubricVersion ?? "未記録"}
                    </dd>
                  </div>
                  <div className="min-w-0 break-words">
                    <dt className="text-muted-foreground">採点モデル（前回 → 今回）</dt>
                    <dd className="mt-1">
                      {previous.evaluatorModel ?? "未記録"} → {selected.evaluatorModel ?? "未記録"}
                    </dd>
                  </div>
                  <div className="min-w-0 break-words">
                    <dt className="text-muted-foreground">提案書の判定（前回 → 今回）</dt>
                    <dd className="mt-1">
                      {previous.decision ? decision[previous.decision] : "未記録"} →{" "}
                      {selected.decision ? decision[selected.decision] : "未記録"}
                    </dd>
                  </div>
                </dl>
                <p className="text-xs text-muted-foreground">
                  保存された採点値・判定・理由・改善案の差を表示します。点差だけで、サイト改善の効果や営業成果は判断できません。
                </p>
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer font-medium text-sm">
                    変更のあった項目（{comparison.changes.length}件）
                  </summary>
                  <div className="mt-3 space-y-3">
                    {comparison.changes.length ? (
                      comparison.changes.map((change) => (
                        <div key={change.itemCode} className="rounded-lg border p-3">
                          <h4 className="font-semibold text-sm">{change.itemCode}</h4>
                          <div className="mt-2 grid gap-3 sm:grid-cols-2">
                            <FindingChange title="前回" item={change.before} />
                            <FindingChange title="今回" item={change.after} />
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        採点値・判定・理由・改善案に変更はありません。観測時点や根拠は各診断で確認できます。
                      </p>
                    )}
                  </div>
                </details>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                同じサイト・対象URLで、これより前に完了した診断はありません。他の対象との点数比較は行いません。
              </p>
            )}
          </section>
          <AuditView audit={selected} findings={data.selectedFindings} />
        </Section>
      )}
    </>
  );
}
function FindingChange({ title, item }: { title: string; item: AuditFindingSummary | null }) {
  const status = { scored: "採点", unevaluable: "評価不能", not_applicable: "対象外" };
  return (
    <div className="min-w-0 space-y-1 break-words text-xs">
      <p className="font-medium text-muted-foreground">{title}</p>
      {item ? (
        <>
          <p>
            {status[item.status]}
            {item.status === "scored" && item.score !== null ? ` · レベル ${item.score}` : ""}
            {item.critical ? " · 致命項目" : ""}
            {item.inference ? " · 推測" : ""}
          </p>
          <p>{item.reason ?? "理由の記録なし"}</p>
          {item.improvementHint && <p>改善案：{item.improvementHint}</p>}
        </>
      ) : (
        <p>項目の記録なし</p>
      )}
    </div>
  );
}
