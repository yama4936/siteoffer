"use client";

// 顧客確認に回すフォーム。顧客に渡すURLはこの画面の状態にだけ持ち、再表示はしない。
// 送信後に画面を最新化しても表示中のURLが消えないよう、運営確認中・顧客確認中の両方で同じ位置に置く。
import { useActionState } from "react";
import type { CustomerReviewLinkAction } from "@/lib/ops/delivery-state";

export function CustomerReviewForm({
  action,
  deliveryId,
  versions,
  reissue,
}: {
  action: CustomerReviewLinkAction;
  deliveryId: string;
  /** 回せる版（新しい順）。顧客確認中は確認中の版だけ */
  versions: { id: string; label: string }[];
  /** 顧客確認中の同じ版のリンクを再発行する */
  reissue: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <div>
      <form action={formAction} className="inline">
        <input type="hidden" name="deliveryId" value={deliveryId} />
        <label>
          版
          <select name="versionId" defaultValue={versions[0]?.id}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          有効期間（時間・空欄は既定）
          <input name="ttlHours" inputMode="numeric" size={5} />
        </label>
        <button type="submit" disabled={pending}>
          {reissue ? "顧客確認のリンクを再発行する" : "この版を顧客確認に回す"}
        </button>
      </form>
      {state?.status === "error" ? (
        <p className="flash err" role="alert">
          {state.message}
        </p>
      ) : null}
      {state?.status === "ok" && state.reviewUrl ? (
        <div className="flash ok">
          <p>{state.message}</p>
          <p>
            顧客確認のURL（有効期限：
            {state.expiresAt ? new Date(state.expiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—"}）
          </p>
          <input
            type="text"
            readOnly
            value={state.reviewUrl}
            style={{ width: "100%" }}
            onFocus={(e) => e.currentTarget.select()}
          />
          <p>
            <a href={state.reviewUrl} target="_blank" rel="noopener noreferrer">
              顧客確認の画面を開く（別ウィンドウ・デモ用）
            </a>
          </p>
        </div>
      ) : null}
    </div>
  );
}
