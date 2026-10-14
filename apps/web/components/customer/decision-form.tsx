"use client";

// 承認・修正依頼のフォーム。入力の検証と判定はサーバー側（core の関数）で行い、ここでは結果を表示するだけ。
import { useActionState, useState } from "react";
import type { CustomerActionState } from "@/lib/customer/review";

type Action = (prev: CustomerActionState, formData: FormData) => Promise<CustomerActionState>;

export function CustomerMessage({ state }: { state: CustomerActionState }) {
  if (!state) return null;
  return (
    <div role={state.status === "error" ? "alert" : "status"} className={`msg msg-${state.status}`}>
      <p>{state.message}</p>
    </div>
  );
}

export function DecisionForm({
  action,
  token,
  versionId,
  commentMax,
}: {
  action: Action;
  token: string;
  versionId: string;
  commentMax: number;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [decision, setDecision] = useState<"approved" | "changes_requested">("approved");
  if (state?.status === "ok") return <CustomerMessage state={state} />;
  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="versionId" value={versionId} />
      <fieldset className="stack">
        <legend>ご確認の結果</legend>
        <label>
          <input
            type="radio"
            name="decision"
            value="approved"
            checked={decision === "approved"}
            onChange={() => setDecision("approved")}
          />{" "}
          この内容で承認する（公開の準備に進みます）
        </label>
        <label>
          <input
            type="radio"
            name="decision"
            value="changes_requested"
            checked={decision === "changes_requested"}
            onChange={() => setDecision("changes_requested")}
          />{" "}
          修正を依頼する
        </label>
      </fieldset>
      {decision === "approved" ? (
        <label>
          <input type="checkbox" name="confirmed" required />{" "}
          掲載内容（会社名・所在地・連絡先・サービス内容など）を確認しました
        </label>
      ) : null}
      <label>
        {decision === "changes_requested" ? "修正してほしい点（必須）" : "ご連絡事項（任意）"}
        <textarea name="comment" maxLength={commentMax} required={decision === "changes_requested"} />
      </label>
      <button type="submit" className="primary" disabled={pending}>
        {pending ? "送信しています…" : decision === "approved" ? "承認を送信する" : "修正依頼を送信する"}
      </button>
      <CustomerMessage state={state} />
    </form>
  );
}
