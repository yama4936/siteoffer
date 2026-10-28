"use client";

// 承認・修正依頼のフォーム。入力を保持し、送信前の確認と同一送信の再確認を行う。最終判定はサーバー側。
import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  versionNumber,
  commentMax,
  imageRightsConsent,
}: {
  action: Action;
  token: string;
  versionId: string;
  versionNumber: number;
  commentMax: number;
  /** 承認時に同意してもらう写真・ロゴ等の権利の文言と、その版 */
  imageRightsConsent: { text: string; version: string };
}) {
  const [state, setState] = useState<CustomerActionState>();
  const [decision, setDecision] = useState<"approved" | "changes_requested" | "">("");
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [consented, setConsented] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const sending = useRef(false);
  const summary = useRef<HTMLElement>(null);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const wasReviewing = useRef(false);
  useEffect(() => {
    if (reviewing) summary.current?.focus();
    else if (wasReviewing.current) commentInput.current?.focus();
    wasReviewing.current = reviewing;
  }, [reviewing]);
  const attempt = useRef<FormData | null>(null);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if ((comment.trim() || pending || unknown) && state?.status !== "ok") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [comment, pending, unknown, state]);
  async function send() {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setState(undefined);
    try {
      if (!attempt.current) {
        const fd = new FormData();
        fd.set("token", token);
        fd.set("versionId", versionId);
        fd.set("decision", decision);
        fd.set("comment", comment);
        if (confirmed) fd.set("confirmed", "on");
        if (decision === "approved" && consented) {
          fd.set("imageRightsConsent", "on");
          fd.set("imageRightsConsentVersion", imageRightsConsent.version);
        }
        fd.set("requestKey", crypto.randomUUID());
        attempt.current = fd;
      }
      const result = await action(undefined, attempt.current);
      setState(result);
      setUnknown(false);
      if (result?.status !== "ok") {
        attempt.current = null;
        setReviewing(false);
      }
    } catch {
      setUnknown(true);
      setState({
        status: "error",
        message: "送信結果を確認できませんでした。入力は残っています。同じ送信を再確認しても二重には記録されません。",
      });
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  if (state?.status === "ok") return <CustomerMessage state={state} />;
  if (reviewing)
    return (
      <section
        ref={summary}
        tabIndex={-1}
        aria-label="送信内容の確認"
        className="space-y-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="rounded-xl border bg-muted/40 p-4 space-y-3">
          <p className="font-semibold">
            第{versionNumber}版への{decision === "approved" ? "承認" : "修正依頼"}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{comment.trim() || "ご連絡事項なし"}</p>
          {decision === "approved" && <p className="text-sm">写真・ロゴ等の権利：{imageRightsConsent.text}</p>}
          <p className="text-sm text-muted-foreground">
            {decision === "approved"
              ? "この版を公開対象として固定します。この操作だけではサイトは公開されません。"
              : "記載した内容を運営へ送ります。修正版は運営で確認してから、あらためてご案内します。"}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="button" disabled={pending} onClick={() => void send()}>
            {pending
              ? "送信結果を確認しています…"
              : unknown
                ? "同じ送信を再確認"
                : decision === "approved"
                  ? "この版の承認を確定する"
                  : "この内容で修正を依頼する"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending || unknown}
            onClick={() => {
              setReviewing(false);
              attempt.current = null;
            }}
          >
            入力に戻る
          </Button>
        </div>
        <CustomerMessage state={state} />
        {unknown && (
          <p className="text-sm text-muted-foreground">
            画面を読み直した場合も、受付済みであれば結果を確認できます。リンクの期限が切れた場合は担当窓口へお問い合わせください。
          </p>
        )}
      </section>
    );
  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        setState(undefined);
        setReviewing(true);
      }}
    >
      <fieldset className="grid gap-3" disabled={pending}>
        <legend className="mb-3 font-medium text-sm">第{versionNumber}版のご確認結果を選んでください</legend>
        <Label className={choiceClass(decision === "approved")}>
          <Input
            type="radio"
            name="decision"
            value="approved"
            required
            checked={decision === "approved"}
            onChange={() => {
              setDecision("approved");
              setConfirmed(false);
              setConsented(false);
            }}
          />
          この内容で承認する（公開の準備に進みます）
        </Label>
        <Label className={choiceClass(decision === "changes_requested")}>
          <Input
            type="radio"
            name="decision"
            value="changes_requested"
            checked={decision === "changes_requested"}
            onChange={() => {
              setDecision("changes_requested");
              setConfirmed(false);
              setConsented(false);
            }}
          />
          修正を依頼する
        </Label>
        {decision === "approved" && (
          <Label className="items-start font-normal leading-snug [&>input]:mt-0.5">
            <Input
              type="checkbox"
              name="confirmed"
              required
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            掲載内容（会社名・所在地・連絡先・サービス内容など）を確認しました
          </Label>
        )}
        {decision === "approved" && (
          <Label className="items-start font-normal leading-snug [&>input]:mt-0.5">
            <Input
              type="checkbox"
              name="imageRightsConsent"
              required
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
            />
            <span>
              {imageRightsConsent.text}
              <span className="mt-1 block text-muted-foreground text-xs">
                承認には、この同意が必要です。同意の内容は承認の記録と一緒に保存します。
              </span>
            </span>
          </Label>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="customer-decision-comment">
            {decision === "changes_requested" ? "修正してほしい点（必須）" : "ご連絡事項（任意）"}
          </Label>
          <Textarea
            ref={commentInput}
            id="customer-decision-comment"
            name="comment"
            rows={6}
            maxLength={commentMax}
            required={decision === "changes_requested"}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="例：会社紹介の2段落目を短くしたい、問い合わせボタンを見つけやすくしたい"
          />
          <p className="text-xs text-muted-foreground">
            {comment.length} / {commentMax}
            文字。変更する場所と希望する内容をお書きください。パスワードや鍵は記入しないでください。
          </p>
        </div>
        <Button type="submit" size="lg" className="w-full sm:w-fit">
          送信内容を確認する
        </Button>
      </fieldset>
      <CustomerMessage state={state} />
    </form>
  );
}
