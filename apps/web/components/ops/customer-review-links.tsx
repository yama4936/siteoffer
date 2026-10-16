"use client";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import {
  customerReviewHistoryAction,
  recoverCustomerReviewAction,
  revokeCustomerReviewAction,
} from "@/app/(ops)/ops/review-link-actions";
import { CustomerReviewLinkResult } from "@/components/ops/customer-review-link-result";
import { Button } from "@/components/ui/button";
import type { CustomerReviewLinkState } from "@/lib/ops/delivery-state";

type History = Extract<Awaited<ReturnType<typeof customerReviewHistoryAction>>, { status: "ok" }>;
export function CustomerReviewLinks({ deliveryId, revision }: { deliveryId: string; revision: string }) {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<History>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<string>(),
    [shown, setShown] = useState<CustomerReviewLinkState>();
  const request = useRef(0),
    sending = useRef(false);
  const load = useCallback(
    async (page = 1, preserveMessage = false) => {
      const seq = ++request.current;
      if (!preserveMessage) setMessage("");
      try {
        const r = await customerReviewHistoryAction(deliveryId, page);
        if (seq !== request.current) return;
        if (r.status === "ok") setHistory(r);
        else setMessage(r.message);
      } catch {
        if (seq === request.current) setMessage("発行履歴を読み込めませんでした。履歴を更新してください。");
      }
    },
    [deliveryId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: A server revision change must refresh this metadata even when the delivery ID is unchanged.
  useEffect(() => {
    setHistory(undefined);
    setShown(undefined);
    setConfirm(undefined);
    setMessage("");
    if (expanded) void load();
    return () => {
      request.current++;
    };
  }, [load, revision, expanded]);
  async function act(id: string, revoke = false) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setMessage("");
    setShown(undefined);
    try {
      const r = revoke
        ? await revokeCustomerReviewAction(deliveryId, id)
        : await recoverCustomerReviewAction(deliveryId, id);
      setMessage(r.message);
      if (r.status === "ok") {
        setConfirm(undefined);
        if (!revoke) setShown(r);
        else window.dispatchEvent(new CustomEvent("siteoffer:customer-review-revoked", { detail: id }));
        await load(history?.page, true);
      }
    } catch {
      setMessage("結果を確認できませんでした。同じ操作をもう一度確認できます。");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      open={expanded}
      onToggle={(e) => setExpanded(e.currentTarget.open)}
      className="space-y-3 rounded-lg border p-4"
      aria-label="顧客確認リンクの発行履歴"
    >
      <summary className="cursor-pointer text-sm font-semibold">顧客確認リンクの発行履歴</summary>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">{history ? `全${history.total}件` : "発行したリンクの状態"}</p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(history?.page)}>
          履歴を更新
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        現在確認中の版は、発行した本人が同じリンクを再表示できます。有効期限は延長しません。不要なリンクは取り消せます。
      </p>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {shown?.status === "ok" && <CustomerReviewLinkResult deliveryId={deliveryId} state={shown} />}
      {!history ? (
        <p className="text-sm">{message ? "履歴を更新して再確認できます。" : "発行履歴を読み込んでいます。"}</p>
      ) : !history.links.length ? (
        <p className="text-sm text-muted-foreground">発行したリンクはありません。</p>
      ) : (
        <ul className="space-y-3">
          {history.links.map((l) => (
            <li key={l.id} className="space-y-2 border-t pt-3 text-sm">
              <p className="font-medium">
                第{l.version}版 ·{" "}
                {{ active: "有効", expired: "期限切れ", revoked: "取り消し済み", closed: "確認受付終了" }[l.state]}
              </p>
              <p className="text-xs text-muted-foreground">
                発行：{l.creator} · {new Date(l.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                <br />
                有効期限：{new Date(l.expiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
              </p>
              {l.state === "active" && !l.recoverable && (
                <p className="text-xs">旧形式のリンクは再表示できません。必要なら新しいリンクを発行してください。</p>
              )}
              {l.state === "active" && l.recoverable && !l.own && (
                <p className="text-xs">再表示は発行した本人が行えます。</p>
              )}
              <div className="flex flex-wrap gap-2">
                {l.state === "active" && l.recoverable && l.own && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => startTransition(() => act(l.id))}>
                    リンクを表示
                  </Button>
                )}
                {l.state !== "revoked" && l.state !== "expired" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setConfirm(l.id);
                      setShown(undefined);
                    }}
                  >
                    リンクを取り消す
                  </Button>
                )}
              </div>
              {confirm === l.id && (
                <fieldset className="space-y-2 rounded bg-amber-50 p-3" aria-label="リンク取り消しの確認">
                  <p>このリンクから閲覧・回答できなくなります。すでに記録された顧客の判断は変更しません。</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => startTransition(() => act(l.id, true))}>
                      取り消しを確定
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(undefined)}>
                      戻る
                    </Button>
                  </div>
                </fieldset>
              )}
            </li>
          ))}
        </ul>
      )}
      {history && history.pages > 1 && (
        <nav className="flex flex-wrap items-center gap-3 text-sm" aria-label="顧客確認リンク履歴のページ">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || history.page <= 1}
            onClick={() => void load(history.page - 1)}
          >
            前の20件
          </Button>
          <span>
            {history.page} / {history.pages}ページ · 全{history.total}件
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || history.page >= history.pages}
            onClick={() => void load(history.page + 1)}
          >
            次の20件
          </Button>
        </nav>
      )}
    </details>
  );
}
