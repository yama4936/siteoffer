"use client";

// 「提案を共有」のフォーム。発行したURLはこの画面の状態にだけ持ち、再表示はしない（再発行で対応）。
// 権限・承認状態・営業抑止の判定はサーバー側（core の share-link）で行う。
import { useActionState } from "react";
import type { SalesAction } from "@/lib/sales/action-state";
import { ActionMessage } from "./forms";

const TTL_OPTIONS = [
  { value: "", label: "既定（運営設定の期間）" },
  { value: "24", label: "24時間" },
  { value: "72", label: "3日" },
  { value: "168", label: "7日" },
] as const;

export function IssueShareForm({ action, proposalVersionId }: { action: SalesAction; proposalVersionId: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="proposalVersionId" value={proposalVersionId} />
      <label>
        有効期間
        <select name="ttlHours" defaultValue="">
          {TTL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="primary" disabled={pending}>
        {pending ? "発行しています…" : "共有リンクを発行する"}
      </button>
      <ActionMessage state={state} />
      {state?.status === "ok" && state.shareUrl && (
        <div className="disclaimer">
          <p>
            共有URL（有効期限：
            {state.shareExpiresAt
              ? new Date(state.shareExpiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
              : "—"}
            ）
          </p>
          <input type="text" readOnly value={state.shareUrl} onFocus={(e) => e.currentTarget.select()} />
          <p className="hint">
            <a href={state.shareUrl} target="_blank" rel="noopener noreferrer">
              改善デモを開いて確認する（別ウィンドウ）
            </a>
          </p>
          <p className="hint">
            このURLは今だけ表示しています。再表示はできないため、控え忘れた場合は取り消して新しく発行してください。
          </p>
        </div>
      )}
    </form>
  );
}

export function RevokeShareButton({ action, linkId }: { action: SalesAction; linkId: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction}>
      <input type="hidden" name="linkId" value={linkId} />
      <button type="submit" disabled={pending}>
        取り消す
      </button>
      <ActionMessage state={state} />
    </form>
  );
}
