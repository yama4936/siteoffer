"use client";
import type { listAuditRequests } from "@siteoffer/worker/audit-request-management";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { cancelCompanyAuditAction } from "@/app/(ops)/ops/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { auditRequestMessages, auditRequestLabels as labels } from "@/lib/ops/audit-request-display";
import { fmtDate } from "@/lib/ops/format";

type Data = Extract<Awaited<ReturnType<typeof listAuditRequests>>, { ok: true }>["value"];

export function AuditRequests({
  data,
  filters,
  searchFields,
  previousHref,
  nextHref,
}: {
  data: Data;
  filters: { key: string; label: string; count: number; href: string }[];
  searchFields: [string, string][];
  previousHref: string;
  nextHref: string;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  function cancel(id: string) {
    if (sending.current) return;
    sending.current = true;
    startTransition(async () => {
      try {
        const r = await cancelCompanyAuditAction(id);
        setMessage(r.message);
        if (r.ok) setConfirm(null);
        router.refresh();
      } catch {
        setMessage("取消結果を確認できませんでした。同じ操作でもう一度確認してください。");
      } finally {
        sending.current = false;
      }
    });
  }
  return (
    <section
      id="audit-requests"
      aria-label="診断依頼の一覧"
      className="mb-6 scroll-mt-24 rounded-xl border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-lg">診断依頼 · {data.total}件</h2>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => router.refresh()}>
          最新に更新
        </Button>
      </div>
      <p className="mt-2 text-muted-foreground text-sm">
        企業画面で受け付けた診断を確認できます。開始前の依頼は取り消せます。開始済みの診断は自動で処理を続けます。
      </p>
      <nav aria-label="診断依頼の表示対象" className="mt-4 flex flex-wrap gap-2 text-sm">
        {filters.map((f) => (
          <Link
            key={f.key}
            href={f.href}
            aria-current={f.key === data.view ? "page" : undefined}
            className={`rounded-md border px-3 py-2 ${f.key === data.view ? "bg-primary text-primary-foreground" : "text-primary"}`}
          >
            {f.label} {f.count}
          </Link>
        ))}
      </nav>
      <form key={data.query} action="/ops/processing#audit-requests" method="get" className="mt-4 flex flex-wrap gap-2">
        {searchFields.map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <Input
          name="requestQuery"
          aria-label="診断依頼を企業名・URLで検索"
          placeholder="企業名・対象URLで検索"
          defaultValue={data.query}
          maxLength={200}
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="outline">
          検索
        </Button>
      </form>
      {message && (
        <p role="status" className="mt-3 rounded-md border bg-muted p-3 text-sm">
          {message}
        </p>
      )}
      {!data.items.length && (
        <p className="mt-4 text-sm text-muted-foreground">この条件に該当する診断依頼はありません。</p>
      )}
      <ul className="mt-4 space-y-3">
        {data.items.map((item) => (
          <li key={item.id} className="rounded-lg border p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Link
                className="min-w-0 break-words font-semibold text-primary underline"
                href={`/ops/companies/${item.companyId}#audit-request`}
              >
                {item.companyName}
              </Link>
              <span
                className={`rounded-md px-2 py-1 text-xs ${item.status === "failed" || item.status === "blocked" ? "bg-amber-50 text-amber-900" : "bg-muted"}`}
              >
                {labels[item.status]}
              </span>
            </div>
            <p className="mt-2 break-all text-muted-foreground">{item.targetUrl}</p>
            <p className="mt-1 text-muted-foreground">
              受付 {fmtDate(item.createdAt)}
              {item.finishedAt ? ` · 終了 ${fmtDate(item.finishedAt)}` : ""}
            </p>
            <p className="mt-2">{item.message ?? auditRequestMessages[item.status]}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Link className="text-primary underline" href={`/ops/companies/${item.companyId}#audit-request`}>
                診断・企業情報を確認
              </Link>
              {(item.status === "failed" || item.status === "blocked") && (
                <Link
                  className="text-primary underline"
                  href={`/ops/processing?company=${item.companyId}#audit-recovery`}
                >
                  保存済み結果の再開を確認
                </Link>
              )}
              {item.canCancel &&
                (confirm === item.id ? (
                  <div className="w-full rounded-lg bg-muted p-3">
                    <p className="mb-2">
                      この企業の診断依頼を取り消します。再度必要になった場合は、企業画面から新しく依頼できます。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => cancel(item.id)}
                      >
                        {pending ? "取消を確認中…" : "診断依頼を取り消す"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => setConfirm(null)}
                      >
                        戻る
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setConfirm(item.id)}
                  >
                    開始前の依頼を取り消す
                  </Button>
                ))}
            </div>
          </li>
        ))}
      </ul>
      <nav aria-label="診断依頼のページ" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        {data.page > 1 ? (
          <Link className="rounded-md border px-3 py-2" href={previousHref}>
            前の20件
          </Link>
        ) : (
          <span />
        )}
        <span>
          {data.page} / {data.pages}ページ · {data.total}件
        </span>
        {data.page < data.pages ? (
          <Link className="rounded-md border px-3 py-2" href={nextHref}>
            次の20件
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </section>
  );
}
