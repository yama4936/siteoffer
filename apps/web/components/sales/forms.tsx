"use client";

// 営業画面のフォーム。値の検証・権限の判定はサーバー側（core の業務関数）で行い、ここでは結果を表示するだけ。
import { useActionState, useState } from "react";
import type { SalesAction, SalesActionState } from "@/lib/sales/action-state";
import { ACTIVITY_KINDS, DOMAIN_INTENTS, DOMAIN_MANAGERS, TRI_STATES } from "@/lib/sales/labels";

export function ActionMessage({ state }: { state: SalesActionState }) {
  if (!state) return null;
  return (
    <div role={state.status === "error" ? "alert" : "status"} className={`msg msg-${state.status}`}>
      <p>{state.message}</p>
      {state.notices?.map((n) => (
        <p key={n} className="notice">
          {n}
        </p>
      ))}
    </div>
  );
}

export function ClaimButton({ action, companyId }: { action: SalesAction; companyId: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction}>
      <input type="hidden" name="companyId" value={companyId} />
      <button type="submit" className="primary" disabled={pending}>
        {pending ? "確保しています…" : "この企業の担当を確保する"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

export function ReleaseForm({ action, assignmentId }: { action: SalesAction; assignmentId: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <label>
        手放す理由（任意）
        <input name="reason" maxLength={500} />
      </label>
      <button type="submit" disabled={pending}>
        担当を手放す
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

export function ActivityForm({ action, assignmentId }: { action: SalesAction; assignmentId: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [kind, setKind] = useState<string>("no_answer");
  const [declineKind, setDeclineKind] = useState<string>("");
  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <label>
        活動の種類
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {ACTIVITY_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      {(kind === "contract_review" || kind === "contract_completed") && (
        <p className="hint">
          契約に至った場合は、下の「成約報告」から契約資料を登録してください。報告だけでは報酬は確定せず、運営が契約資料を確認して契約完了にします。
        </p>
      )}
      <label>
        活動した日時（空欄なら現在）
        <input type="datetime-local" name="occurredAt" />
      </label>
      <label>
        次回対応日{kind === "callback_scheduled" ? "（必須）" : "（任意）"}
        <input type="datetime-local" name="nextActionAt" required={kind === "callback_scheduled"} />
      </label>
      <label>
        結果・メモ
        <textarea name="note" rows={3} maxLength={2000} />
      </label>
      <label className="inline">
        <input type="checkbox" name="consultOps" />
        運営に相談する
      </label>
      {kind === "declined" && (
        <fieldset>
          <legend>営業拒否の内容</legend>
          <label className="inline">
            <input
              type="radio"
              name="declineKind"
              value="not_now"
              required
              checked={declineKind === "not_now"}
              onChange={() => setDeclineKind("not_now")}
            />
            今は不要（時期を改めれば話を聞く可能性がある）
          </label>
          <label className="inline">
            <input
              type="radio"
              name="declineKind"
              value="do_not_contact"
              checked={declineKind === "do_not_contact"}
              onChange={() => setDeclineKind("do_not_contact")}
            />
            今後も連絡しないでほしい
          </label>
          {declineKind === "not_now" && (
            <label>
              企業が示した再連絡の目安（任意）
              <input type="date" name="recontactAfter" />
            </label>
          )}
          <label>
            企業の意向・理由（任意）
            <input name="declineReason" maxLength={500} />
          </label>
          <p className="hint">営業拒否は企業共通の状態として記録され、担当は終了します。</p>
        </fieldset>
      )}
      <button type="submit" className="primary" disabled={pending}>
        記録する
      </button>
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
    <form action={formAction} className="stack">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <input type="hidden" name="companyId" value={companyId} />
      <p className="warn">
        レジストラのパスワード・移管コード・AWSの鍵などは入力しないでください。実際の設定や移管は運営が行います。
      </p>
      <label>
        現在のサイトURL
        <input name="currentUrl" defaultValue={initial.currentUrl} maxLength={2000} />
      </label>
      <label>
        現在のドメイン
        <input name="currentDomain" defaultValue={initial.currentDomain} placeholder="example.co.jp" maxLength={253} />
      </label>
      <fieldset>
        <legend>ドメインの希望</legend>
        {DOMAIN_INTENTS.map((i) => (
          <label key={i.value} className="inline">
            <input
              type="radio"
              name="intent"
              value={i.value}
              checked={intent === i.value}
              onChange={() => setIntent(i.value)}
            />
            <span>
              {i.label}
              {i.help && <small className="help">{i.help}</small>}
            </span>
          </label>
        ))}
      </fieldset>
      {(intent === "keep" || intent === "transfer_consult") && <p className="hint">{reviewNotice}</p>}
      <label>
        希望する新規ドメイン候補（1行に1つ、10件まで）
        <textarea name="newDomainCandidates" rows={3} defaultValue={initial.newDomainCandidates.join("\n")} />
      </label>
      <p className="hint">{availabilityNotice}</p>
      <label>
        現在のドメインの管理者
        <select name="currentManager" defaultValue={initial.currentManager}>
          {DOMAIN_MANAGERS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        現在のドメインでメールを使っているか
        <select name="usesEmail" defaultValue={initial.usesEmail}>
          {TRI_STATES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        企業の希望（自由記述）
        <textarea name="customerWish" rows={3} defaultValue={initial.customerWish} maxLength={2000} />
      </label>
      <button type="submit" className="primary" disabled={pending}>
        ドメイン希望を記録する
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

export function ContractReportForm({
  action,
  assignmentId,
  proposalVersionId,
  terms,
}: {
  action: SalesAction;
  assignmentId: string;
  proposalVersionId: string | null;
  terms: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      {proposalVersionId && <input type="hidden" name="proposalVersionId" value={proposalVersionId} />}
      <label>
        販売条件
        <select name="productTermsId" defaultValue={terms[0]?.id ?? ""}>
          <option value="">選択しない（運営が確認時に設定）</option>
          {terms.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        契約資料（ファイル名・保管場所など）
        <input name="documentRef" maxLength={500} />
      </label>
      <label>
        報告メモ
        <textarea name="reportNote" rows={3} maxLength={2000} />
      </label>
      <p className="hint">
        成約報告だけでは報酬は確定しません。運営が契約資料を確認し、契約完了にした時点で報酬が発生します。
      </p>
      <button type="submit" className="primary" disabled={pending}>
        成約を報告する
      </button>
      <ActionMessage state={state} />
    </form>
  );
}
