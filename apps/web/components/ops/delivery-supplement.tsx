"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { saveDeliveryPreparationAction } from "@/app/delivery-preparation-actions";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { DeliveryPreparationData } from "@/lib/ops/delivery-preparation";
export function DeliverySupplement({
  deliveryId,
  companyId,
  data,
}: {
  deliveryId: string;
  companyId: string;
  data: DeliveryPreparationData["supplementation"];
}) {
  const formId = useId();
  const router = useRouter(),
    [busy, start] = useTransition();
  const [revision, setRevision] = useState(data.revision),
    [proposal, setProposal] = useState(data.proposalVersionId ?? ""),
    [scope, setScope] = useState(data.scopeText),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const receipt = useRef<{ signature: string; id: string } | null>(null),
    sending = useRef(false);
  const changed = data.revision > revision;
  const selected = data.options.find((o) => o.id === proposal);
  function edited() {
    setConfirmed(false);
    receipt.current = null;
    setMessage(null);
  }
  async function save() {
    if (sending.current) return;
    sending.current = true;
    const payload = {
      deliveryId,
      expectedRevision: revision,
      proposalVersionId: proposal,
      scopeText: scope,
      reason,
      confirmed,
    };
    const signature = JSON.stringify(payload);
    if (receipt.current?.signature !== signature) receipt.current = { signature, id: crypto.randomUUID() };
    try {
      const r = await saveDeliveryPreparationAction({ ...payload, requestId: receipt.current.id });
      setMessage(r);
      if (r.ok) {
        setRevision(r.revision);
        setConfirmed(false);
        setReason("");
        receipt.current = null;
        router.refresh();
      } else if (r.code === "conflict") router.refresh();
    } catch {
      setMessage({ ok: false, message: "通信結果を確認できません。同じ内容で再試行できます。" });
    } finally {
      sending.current = false;
    }
  }
  return (
    <section
      aria-label="不足した制作情報の補完"
      className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/50 p-4"
    >
      <h4 className="font-semibold text-sm">不足した制作情報を補う</h4>
      <p className="text-sm">
        契約資料と照合し、納品に使う承認済み提案と制作範囲を記録します。契約原本・価格・報酬は変更しません。
      </p>
      {changed && (
        <div role="alert" className="space-y-2 text-sm">
          <p>
            別の担当が補完内容を更新しました。以下の入力は保持しています。最新の記録と比較してから入力し直してください。
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRevision(data.revision);
              setProposal(data.proposalVersionId ?? "");
              setScope(data.scopeText);
              setReason("");
              edited();
            }}
          >
            最新の記録を読み込んで入力し直す
          </Button>
        </div>
      )}
      {!data.editable ? (
        <p className="text-sm">制作中・顧客確認中の内容は変更できません。</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start(save);
          }}
          className="space-y-3"
        >
          <div className="space-y-1 text-sm">
            <label htmlFor={`${formId}-proposal`}>制作に使う承認済み提案</label>
            <NativeSelect
              id={`${formId}-proposal`}
              value={proposal}
              disabled={busy || changed}
              onChange={(e) => {
                setProposal(e.target.value);
                edited();
              }}
              required
            >
              <option value="">提案を選ぶ</option>
              {data.options.map((o) => (
                <option key={o.id} value={o.id}>
                  提案 第{o.version}版 / デザイン 第{o.designVersion}版
                </option>
              ))}
            </NativeSelect>
          </div>
          {selected && (
            <a
              href={`/ops/designs/${selected.designId}/image`}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm text-primary underline"
            >
              選んだデザイン画像を別タブで確認
            </a>
          )}
          {data.options.length === 0 && (
            <p className="text-sm">
              選べる提案がありません。
              <Link href={`/ops/designs?company=${companyId}`} className="text-primary underline">
                デザインと提案の承認を確認する
              </Link>
            </p>
          )}
          {data.missingScope ? (
            <div className="space-y-1 text-sm">
              <label htmlFor={`${formId}-scope`}>契約資料で確認した制作範囲</label>
              <Textarea
                id={`${formId}-scope`}
                value={scope}
                disabled={busy || changed}
                onChange={(e) => {
                  setScope(e.target.value);
                  edited();
                }}
                rows={4}
                maxLength={6000}
                required
                placeholder="対象ページ、更新機能、移行する内容、修正範囲など"
              />
            </div>
          ) : (
            <p className="text-sm">提供範囲は契約時の記録を使用します。</p>
          )}
          <div className="space-y-1 text-sm">
            <label htmlFor={`${formId}-reason`}>照合した資料・確認の理由</label>
            <Textarea
              id={`${formId}-reason`}
              value={reason}
              disabled={busy || changed}
              onChange={(e) => {
                setReason(e.target.value);
                edited();
              }}
              rows={2}
              maxLength={2000}
              required
              placeholder="例：契約資料の制作範囲と承認済みデザインを照合した"
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || changed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1"
            />
            <span>契約内容と照合し、この提案と制作範囲で進めることを確認しました。</span>
          </label>
          <Button
            type="submit"
            disabled={
              busy || changed || !confirmed || !proposal || !reason.trim() || (data.missingScope && !scope.trim())
            }
          >
            {busy ? "記録しています…" : "確認した制作情報を記録"}
          </Button>
        </form>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className="text-sm">
          {message.message}
        </p>
      )}
      {data.history.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">補完の確認履歴（最新5件）</summary>
          <ol className="mt-2 space-y-3">
            {data.history.map((h) => (
              <li key={h.id} className="rounded-lg border bg-background p-3">
                <p>
                  補完 第{h.revision}版 · {h.by} · {new Date(h.at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words">{h.reason}</p>
                {typeof h.scope === "string" && (
                  <p className="mt-1 whitespace-pre-wrap break-words">制作範囲：{h.scope}</p>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
