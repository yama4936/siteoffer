"use client";
import type { DeliveryDetail } from "@siteoffer/core";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { requestDeliveryChangeAction } from "@/app/delivery-change-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fmtDate } from "@/lib/ops/format";
export function DeliveryChange({
  delivery,
  changes,
  versions,
}: Pick<DeliveryDetail, "delivery" | "changes" | "versions">) {
  const id = useId(),
    router = useRouter(),
    [busy, start] = useTransition();
  const [reason, setReason] = useState(""),
    [requestedChanges, setChanges] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const [editing, setEditing] = useState<{ status: string; version: string | null } | null>(null);
  const observed = editing ?? { status: delivery.status, version: delivery.lockedVersionId };
  const receipt = useRef<{ signature: string; id: string } | null>(null),
    sending = useRef(false);
  const editable = ["ready", "published", "delivered"].includes(delivery.status) && !!delivery.lockedVersionId;
  const stale = observed.status !== delivery.status || observed.version !== delivery.lockedVersionId;
  const open = changes.find((c) => !c.approvedVersionId);
  const version = (value: string) => `第${versions.find((v) => v.id === value)?.version ?? "?"}版`;
  function edited() {
    setEditing(observed);
    setConfirmed(false);
    setMessage(null);
    receipt.current = null;
  }
  async function save() {
    if (sending.current) return;
    sending.current = true;
    const payload = {
      deliveryId: delivery.id,
      fromVersionId: observed.version,
      expectedStatus: observed.status,
      reason,
      requestedChanges,
      confirmed,
    };
    const signature = JSON.stringify(payload);
    if (receipt.current?.signature !== signature) receipt.current = { signature, id: crypto.randomUUID() };
    try {
      const r = await requestDeliveryChangeAction({ ...payload, requestId: receipt.current.id });
      setMessage(r);
      if (r.ok) {
        setEditing(null);
        setReason("");
        setChanges("");
        setConfirmed(false);
        receipt.current = null;
      }
      if (r.ok || r.code === "conflict") router.refresh();
    } catch {
      setMessage({ ok: false, message: "通信結果を確認できません。同じ内容で再試行できます。" });
    } finally {
      sending.current = false;
    }
  }
  return (
    <section aria-label="承認後の変更" className="space-y-3 text-sm">
      {open && (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="font-semibold">承認後の変更に対応中</h3>
          <p>
            {version(open.fromVersionId)}から変更 · 受付 {fmtDate(open.createdAt)}
          </p>
          <p className="whitespace-pre-wrap break-words">{open.requestedChanges}</p>
          <p>新しい版を制作・確認し、顧客に再承認を依頼してください。以前の共有リンクは停止しています。</p>
          <p>外部で公開中のサイトは、この操作では停止・更新されません。</p>
        </div>
      )}
      {message && <p role={message.ok ? "status" : "alert"}>{message.message}</p>}
      {(editable || (!message?.ok && (reason || requestedChanges))) && (
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-semibold">承認後の変更・再制作</summary>
          <p className="mt-3">
            変更前の承認・公開記録を保存して、制作情報の確認へ戻します。契約範囲内の変更内容を記録してください。追加契約や価格変更は行いません。
          </p>
          {stale && (
            <p role="alert" className="mt-3">
              別の操作で状態が変わりました。入力は保持しています。入力を控えて画面を開き直し、最新の状態を確認してください。
            </p>
          )}
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              start(save);
            }}
          >
            <div>
              <label htmlFor={`${id}-reason`}>受付理由（社内記録）</label>
              <Textarea
                id={`${id}-reason`}
                required
                maxLength={1000}
                value={reason}
                disabled={busy}
                onChange={(e) => {
                  setReason(e.target.value);
                  edited();
                }}
              />
            </div>
            <div>
              <label htmlFor={`${id}-changes`}>制作に引き継ぐ変更内容</label>
              <Textarea
                id={`${id}-changes`}
                required
                maxLength={4000}
                value={requestedChanges}
                disabled={busy}
                placeholder="例：使用許可が取り消された写真を外し、許可済みの外観写真に差し替える"
                onChange={(e) => {
                  setChanges(e.target.value);
                  edited();
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">パスワードなどの秘密情報は記入しないでください。</p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                required
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                以前の共有リンクが停止し、新しい版の顧客承認が必要になることを確認しました。外部公開中のサイトは別途対応が必要です。
              </span>
            </label>
            <Button type="submit" disabled={busy || stale || !editable || !confirmed}>
              {busy ? "受け付けています…" : "変更を受け付けて制作準備へ戻す"}
            </Button>
          </form>
        </details>
      )}
      {!!changes.length && (
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-medium">承認後の変更履歴（直近{changes.length}件）</summary>
          <ol className="mt-3 space-y-3">
            {changes.map((c) => (
              <li key={c.id} className="space-y-1 border-t pt-3">
                <p className="font-medium">
                  {version(c.fromVersionId)} →{" "}
                  {c.approvedVersionId ? `${version(c.approvedVersionId)}を再承認済み` : "変更対応中"}
                </p>
                <p>
                  受付 {fmtDate(c.createdAt)}
                  {c.approvedAt ? ` · 再承認 ${fmtDate(c.approvedAt)}` : ""}
                </p>
                <p className="whitespace-pre-wrap break-words">受付理由：{c.reason}</p>
                <p className="whitespace-pre-wrap break-words">変更内容：{c.requestedChanges}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
