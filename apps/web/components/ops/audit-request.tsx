"use client";
import type { getCompanyAuditRequest } from "@siteoffer/worker/audit-request";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { requestCompanyAuditAction } from "@/app/(ops)/ops/actions";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/ops/format";

type Result = Awaited<ReturnType<typeof getCompanyAuditRequest>>;
type Data = Extract<Result, { ok: true }>["value"];
const labels = {
  queued: "受付済み・開始待ち",
  processing: "診断中・自動再試行中",
  completed: "診断完了",
  failed: "診断停止",
  blocked: "対象の再確認が必要",
};
export function AuditRequest({ companyId, data }: { companyId: string; data: Data }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const requestId = useRef<string | null>(null);
  const active = data.request && !data.request.finishedAt;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, 5000);
    return () => clearInterval(timer);
  }, [active, router]);
  function submit() {
    if (sending.current) return;
    sending.current = true;
    requestId.current ??= crypto.randomUUID();
    const id = requestId.current;
    startTransition(async () => {
      try {
        const result = await requestCompanyAuditAction({ companyId, requestId: id });
        setMessage(result.message);
        if (result.ok) {
          setConfirm(false);
          requestId.current = null;
          router.refresh();
        }
      } catch {
        setMessage("受付結果を確認できませんでした。同じ操作でもう一度確認してください。");
      } finally {
        sending.current = false;
      }
    });
  }
  return (
    <section id="audit-request" aria-label="診断の依頼" className="mb-5 space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">公式サイトの診断</h3>
        {data.request && <span className="rounded-md bg-muted px-2 py-1 text-sm">{labels[data.request.status]}</span>}
      </div>
      <p className="text-muted-foreground text-sm">
        公式サイトの取得・採点を行い、結果と改善点を保存します。制作対象と判定された場合は、デザインの準備へ進みます。
      </p>
      <dl className="grid gap-1 text-sm">
        <dt className="text-muted-foreground">現在の診断対象</dt>
        <dd className="break-all">{data.targetUrl ?? "公式サイトを確認してください"}</dd>
      </dl>
      {data.request && (
        <div className="space-y-1 text-sm">
          <p>前回の受付：{fmtDate(data.request.createdAt)}</p>
          <p>{data.request.message ?? "依頼は保存済みです。ワーカーが順次処理します。"}</p>
          {data.request.targetUrl !== data.targetUrl && (
            <p className="break-all text-muted-foreground">受付時の対象：{data.request.targetUrl}</p>
          )}
        </div>
      )}
      {data.blockedReason ? (
        <p className="text-sm">{data.blockedReason}</p>
      ) : confirm ? (
        <div className="space-y-3 rounded-lg bg-muted p-3">
          <p className="text-sm">このサイトを新しく診断します。以前の診断結果は残ります。</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={submit} disabled={pending}>
              {pending ? "受付中…" : "診断を依頼する"}
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirm(false)}>
              戻る
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" onClick={() => setConfirm(true)}>
          現在のサイトを診断
        </Button>
      )}
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
      <Link className="text-primary text-sm underline" href={`/ops/processing?company=${companyId}#audit-recovery`}>
        処理状況・保存済み結果の再開を確認
      </Link>
      {active && (
        <p className="text-muted-foreground text-xs">5秒ごとに状況を更新します。画面を閉じても依頼は残ります。</p>
      )}
    </section>
  );
}
