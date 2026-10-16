"use client";
import { startTransition, useEffect, useRef, useState } from "react";
import { recoverCustomerReviewAction } from "@/app/(ops)/ops/review-link-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CustomerReviewLinkState } from "@/lib/ops/delivery-state";

export function CustomerReviewLinkResult({
  deliveryId,
  state,
}: {
  deliveryId: string;
  state: NonNullable<CustomerReviewLinkState>;
}) {
  const [message, setMessage] = useState(""),
    [unavailable, setUnavailable] = useState(false),
    [pending, setPending] = useState(false);
  const sending = useRef(false);
  useEffect(() => {
    setUnavailable(false);
    setMessage("");
    if (!state.linkId || !state.expiresAt) return;
    const deadline = Date.parse(state.expiresAt);
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      const left = deadline - Date.now();
      if (left <= 0) {
        setUnavailable(true);
        setMessage("このリンクは有効期限を過ぎました。");
      } else timer = setTimeout(check, Math.min(left, 2147483647));
    }
    check();
    return () => clearTimeout(timer);
  }, [state.linkId, state.expiresAt]);
  useEffect(() => {
    function revoked(event: Event) {
      if (event instanceof CustomEvent && event.detail === state.linkId) {
        setUnavailable(true);
        setMessage("このリンクは取り消されました。");
      }
    }
    window.addEventListener("siteoffer:customer-review-revoked", revoked);
    return () => window.removeEventListener("siteoffer:customer-review-revoked", revoked);
  }, [state.linkId]);
  async function copy() {
    if (!state.linkId || sending.current) return;
    sending.current = true;
    setPending(true);
    setMessage("");
    try {
      const current = await recoverCustomerReviewAction(deliveryId, state.linkId);
      if (current.status !== "ok") {
        setUnavailable(true);
        setMessage(current.message);
        return;
      }
      setUnavailable(false);
      try {
        await navigator.clipboard.writeText(current.reviewUrl);
        setMessage("顧客確認のURLをコピーしました。");
      } catch {
        setMessage("コピーできませんでした。URL欄を選択してコピーしてください。");
      }
    } catch {
      setUnavailable(true);
      setMessage("現在の状態を確認できませんでした。もう一度確認してください。");
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-sm">
      <p>{state.message}</p>
      <p>
        顧客確認のURL（有効期限：
        {state.expiresAt ? new Date(state.expiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—"}）
      </p>
      {!unavailable && state.reviewUrl && (
        <>
          <Input
            aria-label="顧客確認のURL"
            readOnly
            value={state.reviewUrl}
            className="w-full font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <a href={state.reviewUrl} target="_blank" rel="noopener noreferrer" className="block text-primary underline">
            顧客確認の画面を開く（別タブ）
          </a>
        </>
      )}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(copy)}>
        {pending ? "リンクを確認しています…" : unavailable ? "リンクを再確認してコピー" : "URLをコピー"}
      </Button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
