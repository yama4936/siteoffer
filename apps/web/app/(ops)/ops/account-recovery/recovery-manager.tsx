"use client";
import type { IssueRecoveryInput, RecoveryView } from "@siteoffer/core";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cancelRecoveryAction, issueRecoveryAction, refreshRecoveriesAction } from "@/app/account-recovery-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { fmtDate } from "@/lib/ops/format";

type Listing = { total: number; page: number; items: RecoveryView[] };
type Job = { kind: "issue"; input: IssueRecoveryInput } | { kind: "cancel"; input: { id: string; revision: number } };
const labels: Record<string, string> = {
  requested: "本人確認待ち",
  issued: "本人の再設定待ち",
  consumed: "再設定済み",
  cancelled: "取り消し済み",
  expired: "期限切れ・変更済み",
};
export function RecoveryManager({ initial, history }: { initial: Listing; history: boolean }) {
  const [listing, setListing] = useState(initial),
    [selected, setSelected] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [job, setJob] = useState<Job | null>(null),
    [message, setMessage] = useState(""),
    [refreshError, setRefreshError] = useState(""),
    [url, setUrl] = useState<string | null>(null);
  useEffect(() => setListing(initial), [initial]);
  async function refresh() {
    if (pending) return;
    setPending(true);
    try {
      const r = await refreshRecoveriesAction({ page: listing.page, history });
      if (r.ok) {
        setListing(r.result);
        setJob(null);
        setSelected(null);
        setUrl(null);
        setMessage("一覧を更新しました");
        setRefreshError("");
      } else setMessage(r.message);
    } catch {
      setMessage("一覧を取得できませんでした。再度更新してください。");
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    if (selected || job || url || pending) return;
    let active = true,
      fetching = false;
    const timer = setInterval(async () => {
      if (!active || fetching || document.visibilityState !== "visible") return;
      fetching = true;
      try {
        const r = await refreshRecoveriesAction({ page: initial.page, history });
        if (active) {
          if (r.ok) {
            setListing(r.result);
            setRefreshError("");
          } else setRefreshError(r.message);
        }
      } catch {
        if (active) setRefreshError("一覧の自動更新ができていません。接続を確認して「一覧を更新」を押してください。");
      } finally {
        fetching = false;
      }
    }, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected, job, url, pending, initial.page, history]);
  async function run(work: Job) {
    if (pending) return;
    setPending(true);
    setJob(work);
    setMessage("");
    setUrl(null);
    try {
      const r = work.kind === "issue" ? await issueRecoveryAction(work.input) : await cancelRecoveryAction(work.input);
      if (!r.ok) {
        setMessage(r.message);
        setJob(null);
        return;
      }
      setListing((previous) => ({
        ...previous,
        items: previous.items.map((row) => (row.id === r.item.id ? r.item : row)),
      }));
      setSelected(null);
      setJob(null);
      if ("token" in r && r.token) {
        setUrl(`${window.location.origin}/account/recovery/${r.token}`);
        setMessage("案内を発行しました。本人確認した連絡先へお渡しください。");
      } else if ("replayed" in r && r.replayed)
        setMessage(
          "発行済みの受付結果を確認しました。案内URLは保存していません。お手元にない場合は、一覧の最新状態を確認して再発行してください。",
        );
      else setMessage("案内を取り消しました。既存のパスワードは変更していません。");
    } catch {
      setMessage("結果を確認できませんでした。同じ受付で結果を確認するか、一覧を更新してください。");
    } finally {
      setPending(false);
    }
  }
  const locked = pending || job !== null;
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          {listing.total}件 · {listing.page + 1}ページ目
        </p>
        <Button variant="outline" disabled={pending} onClick={() => void refresh()}>
          一覧を更新
        </Button>
      </div>
      {refreshError && (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          {refreshError}
        </p>
      )}
      {message && (
        <div role="status" className="rounded-lg border bg-white p-4 text-sm leading-7">
          {message}
          {job && !pending && (
            <Button className="mt-3 block" onClick={() => void run(job)}>
              同じ受付で結果を確認
            </Button>
          )}
        </div>
      )}
      {url && (
        <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <h2 className="font-semibold">本人に渡す再設定リンク</h2>
          <p className="text-sm">この表示を閉じるとURLは再表示できません。リンクは秘密として扱ってください。</p>
          <Input aria-label="再設定リンク" value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setMessage("再設定リンクをコピーしました");
              } catch {
                setMessage("コピーできませんでした。リンク欄を選択してコピーしてください。");
              }
            }}
          >
            リンクをコピー
          </Button>
        </div>
      )}
      {listing.items.length === 0 && (
        <div className="rounded-xl border bg-white p-8 text-center text-slate-500">
          {listing.total > 0
            ? "このページに依頼はありません。前のページを確認してください。"
            : "該当する復旧依頼はありません"}
        </div>
      )}
      <div className="space-y-4">
        {listing.items.map((row) => (
          <article key={row.id} className="rounded-xl border bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="font-semibold">
                  {row.displayName}{" "}
                  <span className="font-normal text-xs text-slate-500">
                    {row.role === "customer" ? "顧客" : "営業"}
                  </span>
                </h2>
                <p className="mt-1 break-all text-sm text-slate-600">{row.email}</p>
                <p className="mt-2 text-xs text-slate-500">受付：{fmtDate(row.requestedAt)}</p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs ${row.status === "requested" ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600"}`}
              >
                {row.linkExpired ? "案内の期限切れ" : labels[row.status]}
              </span>
            </div>
            {row.expiresAt && (
              <p className="mt-3 text-xs text-slate-500">案内の有効期限：{fmtDate(row.expiresAt)}（日本時間）</p>
            )}
            {row.unavailableReason && (
              <p className="mt-3 text-sm text-amber-800">{row.unavailableReason}。再発行には新しい依頼が必要です。</p>
            )}
            <div className="mt-4 flex flex-wrap gap-3">
              {row.canIssue && (
                <Button
                  variant="outline"
                  disabled={locked}
                  onClick={() => {
                    setSelected(selected === row.id ? null : row.id);
                    setMessage("");
                  }}
                >
                  {selected === row.id
                    ? "入力を閉じる"
                    : row.status === "issued"
                      ? "本人確認して再発行"
                      : "本人確認して案内を発行"}
                </Button>
              )}
              {["requested", "issued"].includes(row.status) && (
                <Button
                  variant="ghost"
                  disabled={locked}
                  onClick={() => {
                    if (
                      window.confirm(
                        `${row.displayName} さんの復旧依頼と案内を取り消します。現在のパスワードは変わりません。`,
                      )
                    )
                      void run({ kind: "cancel", input: { id: row.id, revision: row.revision } });
                  }}
                >
                  依頼・案内を取り消す
                </Button>
              )}
            </div>
            {selected === row.id && (
              <form
                key={`${row.id}:${row.revision}`}
                className="mt-5 space-y-4 border-t pt-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (locked) return;
                  const data = new FormData(event.currentTarget);
                  void run({
                    kind: "issue",
                    input: {
                      id: row.id,
                      revision: row.revision,
                      requestId: crypto.randomUUID(),
                      verificationMethod: String(data.get("method")) as IssueRecoveryInput["verificationMethod"],
                      confirmed: data.get("confirmed") === "on",
                      operatorPassword: String(data.get("password") ?? ""),
                    },
                  });
                }}
              >
                <fieldset disabled={locked} className="space-y-4">
                  <div className="space-y-2">
                    <label htmlFor={`method-${row.id}`} className="text-sm font-medium">
                      本人確認の方法
                    </label>
                    <NativeSelect id={`method-${row.id}`} name="method" required defaultValue="">
                      <option value="" disabled>
                        確認した方法を選択
                      </option>
                      <option value="known_contact">登録済みの連絡先で確認</option>
                      <option value="in_person">対面で本人を確認</option>
                    </NativeSelect>
                  </div>
                  <label htmlFor={`confirmed-${row.id}`} className="flex items-start gap-3 text-sm leading-6">
                    <Input id={`confirmed-${row.id}`} type="checkbox" name="confirmed" required className="mt-1" />
                    本人と復旧の意思を確認し、確認済みの本人だけに案内を渡します
                  </label>
                  <div className="space-y-2">
                    <label htmlFor={`password-${row.id}`} className="text-sm font-medium">
                      あなた（運営）の現在のパスワード
                    </label>
                    <Input
                      id={`password-${row.id}`}
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      maxLength={200}
                    />
                  </div>
                  <p className="text-xs leading-6 text-slate-500">
                    確認方法と担当者を履歴に記録します。本人確認書類やパスワードをメモに転記する必要はありません。再発行時は旧案内が無効になります。
                  </p>
                  <Button type="submit">{pending ? "処理しています…" : "30分間有効な案内を発行"}</Button>
                </fieldset>
              </form>
            )}
          </article>
        ))}
      </div>
      <nav aria-label="復旧依頼のページ" className="flex justify-between text-sm">
        {listing.page > 0 ? (
          <Link href={`/ops/account-recovery?page=${listing.page - 1}&history=${history ? 1 : 0}`}>前の20件</Link>
        ) : (
          <span />
        )}
        {(listing.page + 1) * 20 < listing.total && (
          <Link href={`/ops/account-recovery?page=${listing.page + 1}&history=${history ? 1 : 0}`}>次の20件</Link>
        )}
      </nav>
    </div>
  );
}
