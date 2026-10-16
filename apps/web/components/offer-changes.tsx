"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { answerOfferChangeAction, proposeOfferChangeAction } from "@/app/offer-change-actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { OfferChangeView, OfferView } from "@/lib/offer-changes";
import { formatDateTime } from "@/lib/sales/labels";

function Conditions({ value, title, baseline }: { value: OfferView; title: string; baseline?: OfferView }) {
  const fields = (v: OfferView) => [
    v.terms.name,
    `第${v.proposalVersion}版`,
    v.terms.price,
    v.terms.monthly,
    v.terms.reward,
    v.terms.scope,
  ];
  const previous = baseline && fields(baseline);
  return (
    <section aria-label={title} className="min-w-0 space-y-3 rounded-xl border bg-background p-4">
      <h3 className="font-semibold">{title}</h3>
      <dl className="space-y-3">
        {fields(value).map((v, i) => (
          <div
            key={["商品", "提案", "販売価格", "継続費用（月額）", "報酬", "提供範囲"][i]}
            className={previous && previous[i] !== v ? "rounded-md bg-blue-50 p-2 text-blue-950" : "p-2"}
          >
            <dt className="text-muted-foreground text-xs">
              {["商品", "提案", "販売価格", "継続費用（月額）", "報酬", "提供範囲"][i]}
              {previous && previous[i] !== v && <span className="ml-2 text-primary">変更</span>}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-sm">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="break-all text-muted-foreground text-xs">商品条件の版：{value.terms.version}</p>
    </section>
  );
}
const labels = {
  pending: "営業の確認待ち",
  accepted: "適用済み",
  declined: "変更を見送り",
  cancelled: "取り下げ・担当終了",
};
export function OfferChanges({ data, viewerRole }: { data: OfferChangeView; viewerRole: "ops" | "sales" }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const [termsId, setTermsId] = useState("");
  const [proposalId, setProposalId] = useState(data.current?.proposalId ?? "");
  const [reason, setReason] = useState("");
  const [responseDraft, setResponseDraft] = useState<{ id: string; value: string } | null>(null);
  const [confirmedId, setConfirmedId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    requestId: string;
    before: OfferView;
    after: OfferView;
    reason: string;
  } | null>(null);
  const waiting = data.history.find((h) => h.status === "pending");
  const confirmed = !!waiting && confirmedId === waiting.id;
  const note = waiting && responseDraft?.id === waiting.id ? responseDraft.value : "";
  const terms = data.terms.find((t) => t.id === termsId);
  const version = data.versions.find((v) => v.id === proposalId);
  function prepare() {
    if (!data.current || !terms || !version || !reason.trim()) return;
    setConfirmation({
      requestId: crypto.randomUUID(),
      before: data.current,
      after: { id: "", terms, proposalId: version.id, proposalVersion: version.version },
      reason: reason.trim(),
    });
    setMessage(null);
  }
  function send() {
    if (!confirmation || busy) return;
    const c = confirmation;
    start(async () => {
      try {
        const r = await proposeOfferChangeAction({
          requestId: c.requestId,
          assignmentId: data.assignmentId,
          expectedOfferId: c.before.id,
          productTermsId: c.after.terms.id,
          proposalVersionId: c.after.proposalId,
          reason: c.reason,
        });
        setMessage(r);
        if (r.ok) {
          setConfirmation(null);
          setReason("");
          setTermsId("");
        }
        router.refresh();
      } catch {
        setMessage({
          ok: false,
          message: "接続を確認してください。確認内容を残しています。同じ内容で再試行できます。",
        });
      }
    });
  }
  function answer(decision: "accept" | "decline" | "cancel") {
    if (!waiting || busy) return;
    start(async () => {
      try {
        const r = await answerOfferChangeAction({ changeId: waiting.id, decision, confirmed, note });
        setMessage(r);
        if (r.ok) {
          setResponseDraft(null);
          setConfirmedId(null);
        }
        router.refresh();
      } catch {
        setMessage({ ok: false, message: "接続を確認して同じ回答で再試行してください。" });
      }
    });
  }
  return (
    <div className="space-y-5" aria-busy={busy}>
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={`rounded-lg border p-3 text-sm ${message.ok ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}
        >
          {message.message}
        </p>
      )}
      {data.blocked && <p className="rounded-lg bg-muted p-3 text-sm">{data.blocked}</p>}
      {waiting?.before && waiting.after ? (
        <section
          className="space-y-4 rounded-xl border border-blue-200 bg-blue-50/30 p-4"
          aria-label="確認待ちの条件変更"
        >
          <h3 className="font-semibold">{data.blocked ? "適用できない変更提案" : "販売条件の変更が届いています"}</h3>
          <p className="whitespace-pre-wrap break-words text-sm">変更理由：{waiting.reason}</p>
          <div className="grid gap-3 lg:grid-cols-2">
            <Conditions value={waiting.before} title="変更前" />
            <Conditions value={waiting.after} baseline={waiting.before} title="変更後" />
          </div>
          <p className="text-muted-foreground text-sm">
            承諾するまで販売条件は変わりません。確認待ちの間は成約報告を保留します。承諾時に、この担当者が発行した企業の提案リンクを停止します。変更後の提案は新しいリンクで共有してください。
          </p>
          <label htmlFor="offer-response" className="grid gap-2 text-sm">
            {viewerRole === "ops" ? "取り下げの理由" : "回答メモ（変更を見送る場合は必須）"}
            <Textarea
              id="offer-response"
              value={note}
              onChange={(e) => setResponseDraft({ id: waiting.id, value: e.target.value })}
              maxLength={2000}
              disabled={busy}
            />
          </label>
          {viewerRole === "sales" ? (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmedId(e.target.checked ? waiting.id : null)}
                  disabled={busy || !!data.blocked}
                  className="mt-1"
                />
                価格・月額・報酬・提供範囲・提案版を確認しました
              </label>
              <div className="flex flex-wrap gap-3">
                <Button disabled={busy || !confirmed || !!data.blocked} onClick={() => answer("accept")}>
                  確認して変更を受け入れる
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !note.trim() || !!data.blocked}
                  onClick={() => answer("decline")}
                >
                  理由を添えて見送る
                </Button>
              </div>
            </>
          ) : (
            <Button variant="outline" disabled={busy || !note.trim()} onClick={() => answer("cancel")}>
              変更提案を取り下げる
            </Button>
          )}
        </section>
      ) : (
        viewerRole === "sales" && (
          <p className="text-muted-foreground text-sm">
            確認待ちの条件変更はありません。条件の相談は活動記録の「運営へ相談」から行えます。
          </p>
        )
      )}
      {viewerRole === "ops" &&
        !waiting &&
        !data.blocked &&
        data.current &&
        (confirmation ? (
          <section className="space-y-4" aria-label="変更内容の確認">
            <div className="grid gap-3 lg:grid-cols-2">
              <Conditions value={confirmation.before} title="変更前" />
              <Conditions value={confirmation.after} baseline={confirmation.before} title="変更後" />
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">変更理由：{confirmation.reason}</p>
            <p className="text-sm">この担当案件だけの変更です。営業担当が承諾するまで適用しません。</p>
            <div className="flex flex-wrap gap-3">
              <Button disabled={busy} onClick={send}>
                営業に確認を依頼
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
                内容を修正する
              </Button>
            </div>
          </section>
        ) : (
          <form
            className="grid max-w-2xl gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              prepare();
            }}
          >
            <p className="text-sm">
              商談で合意した変更内容を提示し、営業担当の確認後に適用します。商品条件がない場合は、先に契約・報酬画面で新しい版を作成してください。
            </p>
            <Link
              href="/ops/contracts"
              className={buttonVariants({ variant: "outline", size: "sm", className: "w-fit" })}
            >
              商品条件を管理する
            </Link>
            <label htmlFor="offer-terms" className="grid gap-2 text-sm">
              変更後の商品条件
              <NativeSelect
                aria-label="変更後の商品条件"
                id="offer-terms"
                value={termsId}
                onChange={(e) => setTermsId(e.target.value)}
                required
              >
                <option value="" disabled>
                  有効な条件を選ぶ
                </option>
                {data.terms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} / {t.price} / 版 {t.version}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label htmlFor="offer-proposal" className="grid gap-2 text-sm">
              変更後の提案版
              <NativeSelect
                aria-label="変更後の提案版"
                id="offer-proposal"
                value={proposalId}
                onChange={(e) => setProposalId(e.target.value)}
                required
              >
                <option value="" disabled>
                  承認済みの提案を選ぶ
                </option>
                {data.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    第{v.version}版
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label htmlFor="offer-reason" className="grid gap-2 text-sm">
              変更理由・営業への説明
              <Textarea
                id="offer-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={2000}
                required
                rows={3}
              />
            </label>
            <Button type="submit" className="w-fit" disabled={busy || !terms || !version || !reason.trim()}>
              変更内容を確認
            </Button>
          </form>
        ))}
      {data.history.length > 0 && (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer font-medium">条件変更の履歴（直近20件）</summary>
          <ol className="mt-3 space-y-3">
            {data.history.map((h) => (
              <li key={h.id} className="space-y-2 border-t pt-3 text-sm">
                <p className="font-medium">{labels[h.status]}</p>
                <p className="text-muted-foreground text-xs">
                  提示：{formatDateTime(new Date(h.createdAt))}
                  {h.decidedAt && ` / 回答・終了：${formatDateTime(new Date(h.decidedAt))}`}
                </p>
                <p className="whitespace-pre-wrap break-words">{h.reason}</p>
                {h.responseNote && <p className="whitespace-pre-wrap break-words">回答：{h.responseNote}</p>}
                {h.before && h.after && (
                  <details>
                    <summary className="cursor-pointer text-primary">この変更の内容を見る</summary>
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <Conditions value={h.before} title="変更前" />
                      <Conditions value={h.after} baseline={h.before} title="変更後" />
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
