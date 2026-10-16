"use client";
import type { listAuditPreparation } from "@siteoffer/worker/audit-preparation";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { requestPreparedAuditsAction } from "@/app/(ops)/ops/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Data = Extract<Awaited<ReturnType<typeof listAuditPreparation>>, { ok: true }>["value"];
export function AuditPreparation({
  data,
  searchFields,
  previousHref,
  nextHref,
}: {
  data: Data;
  searchFields: [string, string][];
  previousHref: string;
  nextHref: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [review, setReview] = useState<Data["items"]>([]);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<{ companyId: string; name: string; ok: boolean; message: string }[]>([]);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const operations = useRef(new Map<string, string>());
  const previousPage = useRef(data.page);
  useEffect(() => {
    if (previousPage.current !== data.page) {
      previousPage.current = data.page;
      setSelected([]);
      setConfirm(false);
    }
  }, [data.page]);
  const eligible = data.items.filter((r) => !r.blockedReason && r.websiteId && r.targetUrl);
  const chosen = eligible.filter((r) => selected.includes(r.companyId));
  const all = eligible.length > 0 && chosen.length === eligible.length;
  function toggle(id: string) {
    setConfirm(false);
    setSelected((old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));
  }
  function submit() {
    if (sending.current || !review.length) return;
    sending.current = true;
    const items = review.map((r) => {
      if (!operations.current.has(r.companyId)) operations.current.set(r.companyId, crypto.randomUUID());
      return {
        companyId: r.companyId,
        requestId: operations.current.get(r.companyId)!,
        websiteId: r.websiteId!,
        targetUrl: r.targetUrl!,
      };
    });
    startTransition(async () => {
      try {
        const result = await requestPreparedAuditsAction(items);
        if (!result.ok) {
          setMessage(result.message);
          return;
        }
        setResults(
          result.items.map((r) => ({
            ...r,
            name: review.find((c) => c.companyId === r.companyId)?.companyName ?? "企業",
          })),
        );
        const accepted = result.items.filter((r) => r.ok).map((r) => r.companyId);
        setMessage(
          `${accepted.length}社の受付を確認しました。${result.items.length - accepted.length}社は内容の確認が必要です。`,
        );
        setSelected((old) => old.filter((id) => !accepted.includes(id)));
        setConfirm(false);
        router.refresh();
      } catch {
        setMessage("受付結果を確認できませんでした。同じ選択で再度操作するか、診断依頼の一覧を確認してください。");
      } finally {
        sending.current = false;
      }
    });
  }
  return (
    <section
      id="audit-preparation"
      aria-label="診断の準備"
      className="mb-6 scroll-mt-24 rounded-xl border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-lg">診断の準備 · {data.total}社</h2>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => router.refresh()}>
          最新に更新
        </Button>
      </div>
      <p className="mt-2 text-muted-foreground text-sm">
        公式サイトを確認済みで、まだ診断を依頼していない企業です。対象を確認し、このページから最大20社をまとめて依頼できます。
      </p>
      <form action="/ops/processing#audit-preparation" method="get" className="mt-4 flex flex-wrap gap-2">
        {searchFields.map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <Input
          name="preparationQuery"
          aria-label="診断の準備を企業名・URLで検索"
          placeholder="企業名・対象URLで検索"
          defaultValue={data.query}
          maxLength={200}
          className="min-w-0 flex-1"
          disabled={pending}
        />
        <Button type="submit" variant="outline" disabled={pending}>
          検索
        </Button>
      </form>
      {message && (
        <div role="status" className="mt-4 rounded-lg border bg-muted p-3 text-sm">
          <p>{message}</p>
          <ul className="mt-2 space-y-2">
            {results.map((r) => (
              <li key={r.companyId}>
                <Link href={`/ops/companies/${r.companyId}#audit-request`} className="text-primary underline">
                  {r.name}
                </Link>
                ：{r.message}
              </li>
            ))}
          </ul>
          <Link href="/ops/processing#audit-requests" className="mt-2 inline-block text-primary underline">
            診断依頼の一覧で確認
          </Link>
        </div>
      )}
      {data.items.length ? (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <label className="flex min-h-10 items-center gap-2">
              <input
                type="checkbox"
                checked={all}
                disabled={pending || !eligible.length}
                onChange={() => {
                  setConfirm(false);
                  setSelected(all ? [] : eligible.map((r) => r.companyId));
                }}
              />
              このページの依頼可能な企業をすべて選択
            </label>
            <span aria-live="polite">{chosen.length}社を選択中</span>
          </div>
          {confirm && review.length > 0 ? (
            <div className="mt-4 rounded-lg bg-muted p-4 text-sm">
              <p className="font-semibold">選択した{review.length}社の診断を依頼します</p>
              <p className="mt-1">
                以下の公式サイトを取得・採点します。制作対象と判定された企業は、デザインの準備へ進みます。
              </p>
              <ul aria-label="依頼する診断対象" className="mt-3 space-y-2">
                {review.map((r) => (
                  <li key={r.companyId}>
                    <strong>{r.companyName}</strong>
                    <p className="break-all text-muted-foreground">{r.targetUrl}</p>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" disabled={pending} onClick={submit}>
                  {pending ? "受付を確認中…" : "選択した企業の診断を依頼"}
                </Button>
                <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirm(false)}>
                  戻る
                </Button>
              </div>
            </div>
          ) : (
            <Button
              className="mt-4"
              type="button"
              disabled={pending || !chosen.length}
              onClick={() => {
                setReview(chosen);
                setConfirm(true);
              }}
            >
              選択した{chosen.length}社の対象を確認
            </Button>
          )}
          <ul className="mt-2 space-y-2">
            {data.items.map((r) => (
              <li key={r.companyId} className="rounded-lg border p-3 text-sm">
                <div className="flex items-start gap-3">
                  <label className="flex size-10 shrink-0 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      className="size-4"
                      aria-label={`${r.companyName}を選択`}
                      checked={chosen.some((c) => c.companyId === r.companyId)}
                      disabled={pending || !!r.blockedReason}
                      onChange={() => toggle(r.companyId)}
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/ops/companies/${r.companyId}#audit-request`}
                      className="break-words font-semibold text-primary underline"
                    >
                      {r.companyName}
                    </Link>
                    <p className="mt-1 break-all text-muted-foreground">
                      {r.targetUrl ?? "診断対象を確認してください"}
                    </p>
                    {r.blockedReason && (
                      <p className="mt-2 text-amber-800">
                        {r.blockedReason}{" "}
                        <Link href={`/ops/companies/${r.companyId}`} className="underline">
                          企業情報を確認
                        </Link>
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          この条件に該当する未依頼の企業はありません。受付済みの診断は「診断依頼」で確認できます。
        </p>
      )}
      <nav aria-label="診断の準備のページ" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        {data.page > 1 ? (
          <Link href={previousHref} className="rounded-md border px-3 py-2">
            前の20社
          </Link>
        ) : (
          <span />
        )}
        <span>
          {data.page} / {data.pages}ページ · {data.total}社
        </span>
        {data.page < data.pages ? (
          <Link href={nextHref} className="rounded-md border px-3 py-2">
            次の20社
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </section>
  );
}
