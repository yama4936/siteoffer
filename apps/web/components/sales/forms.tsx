"use client";

// 営業画面のフォーム。値の検証・権限の判定はサーバー側（core の業務関数）で行い、ここでは結果を表示するだけ。
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { type ReactNode, useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SalesAction, SalesActionState } from "@/lib/sales/action-state";
import { DOMAIN_INTENTS, DOMAIN_MANAGERS, TRI_STATES } from "@/lib/sales/labels";

export function ActionMessage({ state }: { state: SalesActionState }) {
  if (!state) return null;
  const ok = state.status !== "error";
  return (
    <Alert role={ok ? "status" : "alert"} variant={ok ? "success" : "destructive"}>
      {ok ? <CircleCheck /> : <CircleAlert />}
      <AlertDescription>
        <p>{state.message}</p>
        {state.notices?.map((n) => (
          <p key={n} className="text-muted-foreground">
            {n}
          </p>
        ))}
      </AlertDescription>
    </Alert>
  );
}

/** フォーム内の補足（注意書き） */
function Hint({ children }: { children: ReactNode }) {
  return (
    <Alert variant="info">
      <Info />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** ラジオボタン・チェックボックスと文言を横に並べるラベル */
const choiceLabelClass = "items-start font-normal leading-snug [&>input]:mt-0.5";

export function ClaimButton({
  action,
  companyId,
  salesOfferId,
}: {
  action: SalesAction;
  companyId: string;
  salesOfferId: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="grid max-w-xl gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="salesOfferId" value={salesOfferId} />
      <Button type="submit" size="lg" className="w-full sm:w-fit" disabled={pending}>
        {pending ? "確保しています…" : "この企業の担当を確保する"}
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

export function ReleaseForm({ action, assignmentId }: { action: SalesAction; assignmentId: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="grid max-w-xl gap-4">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <Field label="手放す理由（任意）" htmlFor="release-reason">
        <Input id="release-reason" name="reason" maxLength={500} />
      </Field>
      <Button type="submit" variant="destructive" className="w-fit" disabled={pending}>
        担当を手放す
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

export interface DomainFormInitial {
  currentUrl: string;
  currentDomain: string;
  intent: string;
  newDomainCandidates: string[];
  currentManager: string;
  usesEmail: string;
  customerWish: string;
}

/**
 * ドメイン希望の聞き取り（13章）。レジストラのパスワード・移管コード・鍵の入力欄は作らない。
 */
export function DomainPreferenceForm({
  action,
  assignmentId,
  companyId,
  initial,
  availabilityNotice,
  reviewNotice,
}: {
  action: SalesAction;
  assignmentId: string;
  companyId: string;
  initial: DomainFormInitial;
  availabilityNotice: string;
  reviewNotice: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [intent, setIntent] = useState(initial.intent);
  return (
    <form action={formAction} className="grid max-w-xl gap-4">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <input type="hidden" name="companyId" value={companyId} />
      <Alert variant="warning">
        <TriangleAlert />
        <AlertDescription>
          レジストラのパスワード・移管コード・AWSの鍵などは入力しないでください。実際の設定や移管は運営が行います。
        </AlertDescription>
      </Alert>
      <Field label="現在のサイトURL" htmlFor="domain-current-url">
        <Input id="domain-current-url" name="currentUrl" defaultValue={initial.currentUrl} maxLength={2000} />
      </Field>
      <Field label="現在のドメイン" htmlFor="domain-current-domain">
        <Input
          id="domain-current-domain"
          name="currentDomain"
          defaultValue={initial.currentDomain}
          placeholder="example.co.jp"
          maxLength={253}
        />
      </Field>
      <fieldset className="grid gap-3 rounded-lg border p-4">
        <legend className="px-1 font-medium text-sm">ドメインの希望</legend>
        {DOMAIN_INTENTS.map((i) => (
          <Label key={i.value} className={choiceLabelClass}>
            <Input
              type="radio"
              name="intent"
              value={i.value}
              checked={intent === i.value}
              onChange={() => setIntent(i.value)}
            />
            <span className="grid gap-0.5">
              {i.label}
              {i.help && <small className="text-muted-foreground text-xs">{i.help}</small>}
            </span>
          </Label>
        ))}
      </fieldset>
      {(intent === "keep" || intent === "transfer_consult") && <Hint>{reviewNotice}</Hint>}
      <Field
        label="希望する新規ドメイン候補（1行に1つ、10件まで）"
        htmlFor="domain-new-candidates"
        hint={availabilityNotice}
      >
        <Textarea
          id="domain-new-candidates"
          name="newDomainCandidates"
          rows={3}
          defaultValue={initial.newDomainCandidates.join("\n")}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="現在のドメインの管理者" htmlFor="domain-current-manager">
          <NativeSelect id="domain-current-manager" name="currentManager" defaultValue={initial.currentManager}>
            {DOMAIN_MANAGERS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="現在のドメインでメールを使っているか" htmlFor="domain-uses-email">
          <NativeSelect id="domain-uses-email" name="usesEmail" defaultValue={initial.usesEmail}>
            {TRI_STATES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field label="企業の希望（自由記述）" htmlFor="domain-customer-wish">
        <Textarea
          id="domain-customer-wish"
          name="customerWish"
          rows={3}
          defaultValue={initial.customerWish}
          maxLength={2000}
        />
      </Field>
      <Button type="submit" className="w-fit" disabled={pending}>
        ドメイン希望を記録する
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

export function ContractReportForm({
  action,
  blockedReason,
  assignmentId,
  salesOfferId,
  proposalVersionId,
  terms,
}: {
  action: SalesAction;
  blockedReason?: string;
  assignmentId: string;
  salesOfferId: string | null;
  proposalVersionId: string | null;
  terms: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [documentRef, setDocumentRef] = useState("");
  const [reportNote, setReportNote] = useState("");
  return (
    <form action={formAction} className="grid max-w-xl gap-4">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      {proposalVersionId && <input type="hidden" name="proposalVersionId" value={proposalVersionId} />}
      {salesOfferId && <input type="hidden" name="salesOfferId" value={salesOfferId} />}
      {terms[0] && <input type="hidden" name="productTermsId" value={terms[0].id} />}
      <p className="text-sm">
        運営が確認した販売条件で報告します。条件の変更が必要な場合は、営業からの相談で運営に連絡してください。
      </p>
      <Field label="契約資料（ファイル名・保管場所など）" htmlFor="contract-document-ref">
        <Input
          id="contract-document-ref"
          name="documentRef"
          maxLength={500}
          value={documentRef}
          onChange={(e) => setDocumentRef(e.target.value)}
        />
      </Field>
      <Field label="報告メモ" htmlFor="contract-report-note">
        <Textarea
          id="contract-report-note"
          name="reportNote"
          rows={3}
          maxLength={2000}
          value={reportNote}
          onChange={(e) => setReportNote(e.target.value)}
        />
      </Field>
      <Hint>成約報告だけでは報酬は確定しません。運営が契約資料を確認し、契約完了にした時点で報酬が発生します。</Hint>
      <Button
        type="submit"
        className="w-fit"
        disabled={pending || !!blockedReason || !salesOfferId || terms.length !== 1}
      >
        成約を報告する
      </Button>
      {blockedReason && (
        <p role="status" className="text-sm text-muted-foreground">
          {blockedReason}{" "}
          <a href="#offer-changes" className="text-primary underline">
            変更内容を確認する
          </a>
        </p>
      )}
      <ActionMessage state={state} />
    </form>
  );
}
