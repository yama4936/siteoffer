"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useRef, useState } from "react";
import { resumeAuditAction } from "@/app/(ops)/ops/actions";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/ops/format";
export interface AuditRecoveryItem {
  auditId: string;
  companyId: string;
  companyName: string;
  status: string;
  decision: string | null;
  createdAt: string;
  blockedReason: string | null;
}
export function AuditRecovery({
  items,
  total,
  page,
  pages,
  previousHref,
  nextHref,
}: {
  items: AuditRecoveryItem[];
  total: number;
  page: number;
  pages: number;
  previousHref: string;
  nextHref: string;
}) {
  const router = useRouter();
  const sending = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  async function resume(auditId: string) {
    if (sending.current) return;
    sending.current = true;
    setPending(auditId);
    setMessage("");
    try {
      const r = await resumeAuditAction(auditId);
      setMessage(r.message);
      if (r.ok) router.refresh();
    } catch {
      setMessage(
        "受付結果を確認できませんでした。最新の状態を確認してください。同じ操作をやり直しても依頼は重複しません。",
      );
    } finally {
      sending.current = false;
      setPending(null);
    }
  }
  if (!total && !message) return null;
  return (
    <section
      id="audit-recovery"
      aria-label="診断結果からの再開"
      className="mb-6 scroll-mt-24 rounded-xl border border-amber-200 bg-amber-50/50 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-lg">保存済みの診断から再開 · {total}件</h2>
        <Button size="sm" variant="outline" disabled={!!pending} onClick={() => router.refresh()}>
          最新の状態を確認
        </Button>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        診断は完了していますが、判定の反映前に自動処理が終了した案件です。保存済みの結果を使い、採点を繰り返さず再開できます。
      </p>
      {message && (
        <p role="status" className="mt-3 rounded-md border bg-white p-3 text-sm">
          {message}
        </p>
      )}
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item.auditId} className="rounded-lg border bg-card p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  className="break-words font-semibold text-primary underline"
                  href={`/ops/companies/${item.companyId}`}
                >
                  {item.companyName}
                </Link>
                <p className="mt-1 text-muted-foreground">{fmtDate(item.createdAt)}の診断</p>
              </div>
              <span className="rounded-md bg-muted px-2 py-1 text-xs">
                {item.status === "unevaluable"
                  ? "評価不能・保留"
                  : item.decision === "create"
                    ? "改善提案の対象"
                    : item.decision === "skip"
                      ? "提案を見送る判定"
                      : "判定保留"}
              </span>
            </div>
            <p className={`mt-3 ${item.blockedReason ? "text-amber-900" : "text-muted-foreground"}`}>
              {item.blockedReason ??
                (item.decision === "create" && item.status === "evaluated"
                  ? "制作依頼を受け付けます。画像案の確認・承認は通常どおり行います。"
                  : "保存済みの見送り・保留判定を反映します。新しい制作は依頼しません。")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {!item.blockedReason && (
                <Button size="sm" disabled={!!pending} onClick={() => startTransition(() => resume(item.auditId))}>
                  {pending === item.auditId ? "受付を確認しています…" : "保存済みの結果で再開"}
                </Button>
              )}
              <Link className="rounded-md border px-3 py-2 text-primary" href={`/ops/companies/${item.companyId}`}>
                診断・企業情報を確認
              </Link>
            </div>
          </li>
        ))}
      </ul>
      {pages > 1 && (
        <nav
          aria-label="再開できる診断のページ"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"
        >
          {page > 1 ? (
            <Link className="rounded-md border bg-white px-3 py-2" href={previousHref}>
              前の20件
            </Link>
          ) : (
            <span />
          )}
          <span>
            {page} / {pages}ページ
          </span>
          {page < pages ? (
            <Link className="rounded-md border bg-white px-3 py-2" href={nextHref}>
              次の20件
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </section>
  );
}
