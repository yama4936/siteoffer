"use client";

// 承認・修正依頼のフォーム。入力の検証と判定はサーバー側（core の関数）で行い、ここでは結果を表示するだけ。
import { CircleAlert, CircleCheck } from "lucide-react";
import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CustomerActionState } from "@/lib/customer/review";
import { cn } from "@/lib/utils";

type Action = (prev: CustomerActionState, formData: FormData) => Promise<CustomerActionState>;

export function CustomerMessage({ state }: { state: CustomerActionState }) {
  if (!state) return null;
  const ok = state.status !== "error";
  return (
    <Alert role={ok ? "status" : "alert"} variant={ok ? "success" : "destructive"}>
      {ok ? <CircleCheck /> : <CircleAlert />}
      <AlertDescription>
        <p>{state.message}</p>
      </AlertDescription>
    </Alert>
  );
}

/** 選択肢を枠で囲み、選んでいるものを強調する */
function choiceClass(selected: boolean) {
  return cn(
    "cursor-pointer items-start rounded-lg border p-4 font-normal leading-snug transition-colors hover:bg-accent/50 [&>input]:mt-0.5",
    selected && "border-primary bg-primary/5",
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
    <form action={formAction} className="grid gap-5">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="versionId" value={versionId} />
      <fieldset className="grid gap-3">
        <legend className="mb-3 font-medium text-sm">ご確認の結果</legend>
        <Label className={choiceClass(decision === "approved")}>
          <Input
            type="radio"
            name="decision"
            value="approved"
            checked={decision === "approved"}
            onChange={() => setDecision("approved")}
          />{" "}
          この内容で承認する（公開の準備に進みます）
        </Label>
        <Label className={choiceClass(decision === "changes_requested")}>
          <Input
            type="radio"
            name="decision"
            value="changes_requested"
            checked={decision === "changes_requested"}
            onChange={() => setDecision("changes_requested")}
          />{" "}
          修正を依頼する
        </Label>
      </fieldset>
      {decision === "approved" ? (
        <Label className="items-start font-normal leading-snug [&>input]:mt-0.5">
          <Input type="checkbox" name="confirmed" required />{" "}
          掲載内容（会社名・所在地・連絡先・サービス内容など）を確認しました
        </Label>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="customer-decision-comment">
          {decision === "changes_requested" ? "修正してほしい点（必須）" : "ご連絡事項（任意）"}
        </Label>
        <Textarea
          id="customer-decision-comment"
          name="comment"
          rows={4}
          maxLength={commentMax}
          required={decision === "changes_requested"}
        />
      </div>
      <Button type="submit" size="lg" className="w-full sm:w-fit" disabled={pending}>
        {pending ? "送信しています…" : decision === "approved" ? "承認を送信する" : "修正依頼を送信する"}
      </Button>
      <CustomerMessage state={state} />
    </form>
  );
}
