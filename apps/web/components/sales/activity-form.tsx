"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { commitActivityDraftAction, saveActivityDraftAction } from "@/app/(sales)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { usePersonalDraft } from "@/components/use-personal-draft";
import {
  type ActivityDraftSnapshot,
  type ActivityValues,
  emptyActivity,
  suggestedFollowUp,
} from "@/lib/sales/activity-draft-types";
import { ACTIVITY_KINDS, activityKindLabel } from "@/lib/sales/labels";
import { preservesActivityHistory } from "./activity-history-navigation";

export function ActivityForm({
  assignmentId,
  initial,
  defaults,
  requestKey,
  nextActionLabel,
  previousNote,
}: {
  assignmentId: string;
  initial: ActivityDraftSnapshot;
  defaults: ActivityValues;
  requestKey: string;
  nextActionLabel: string;
  previousNote: string | null;
}) {
  const router = useRouter();
  const draft = usePersonalDraft(
    initial,
    defaults,
    (revision, values) => saveActivityDraftAction(assignmentId, revision, values),
    (target) => preservesActivityHistory(target, assignmentId),
  );
  const [busy, setBusy] = useState(false),
    [confirmEnd, setConfirmEnd] = useState(false),
    [message, setMessage] = useState(""),
    [submitError, setSubmitError] = useState("");
  const operationKey = useRef(requestKey);
  const values = draft.values;
  const terminal = values.kind === "lost" || values.kind === "declined";
  function change(patch: Partial<ActivityValues>) {
    draft.change({ ...draft.latest.current, ...patch });
    setMessage("");
    setSubmitError("");
    if (patch.kind !== undefined || patch.declineKind !== undefined) setConfirmEnd(false);
  }
  function selectKind(kind: ActivityValues["kind"]) {
    change({
      kind,
      ...(kind === "callback_scheduled"
        ? { nextActionMode: "replace" as const }
        : ["lost", "declined"].includes(kind)
          ? { nextActionMode: "clear" as const }
          : {}),
    });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !draft.ready) return;
    draft.cancelPendingSave();
    setBusy(true);
    setSubmitError("");
    setMessage("");
    try {
      if (!(await draft.flush())) return;
      const result = await commitActivityDraftAction(assignmentId, {
        revision: draft.revision.current,
        values: draft.latest.current,
        requestKey: operationKey.current,
        confirmEnd,
      });
      if (result.status === "conflict") draft.showConflict(result.snapshot);
      else if (result.status === "error") setSubmitError(result.message);
      else {
        draft.applyStored(result.snapshot, emptyActivity(new Date()));
        operationKey.current = crypto.randomUUID();
        setConfirmEnd(false);
        setMessage("活動を記録しました。次回予定も担当案件に反映しました。");
        router.refresh();
      }
    } catch {
      setSubmitError("結果を確認できませんでした。入力を残しています。同じ操作を再試行しても二重記録にはなりません");
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    if (!window.confirm("入力中の下書きを破棄しますか？")) return;
    setBusy(true);
    try {
      await draft.discard(emptyActivity(new Date()));
      setConfirmEnd(false);
      setSubmitError("");
    } finally {
      setBusy(false);
    }
  }
  function reuse() {
    if (!previousNote) return;
    const next = [values.note, previousNote].filter(Boolean).join("\n");
    if (next.length > 2000) {
      setSubmitError("追記すると2000文字を超えるため追加していません。メモを短くしてから再試行してください");
      return;
    }
    change({ note: next });
  }
  return (
    <form ref={draft.formRef} onSubmit={submit} aria-label="営業活動の記録" className="grid max-w-2xl gap-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
        <p role="status">{draft.status}</p>
        <p className="mt-1 text-xs text-slate-600">
          自分専用の下書きです。記録するまで活動履歴・次回予定は変わりません。
        </p>
        {draft.hasDraft && !draft.conflict && (
          <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={busy}>
            下書きを破棄
          </Button>
        )}
      </div>
      {draft.conflict && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p>別の画面で更新されたため、保存を止めました。この画面の入力は残っています。</p>
          <details className="my-3">
            <summary className="cursor-pointer">保存済みの内容を見る</summary>
            {draft.conflict.values ? (
              <dl className="grid gap-2 whitespace-pre-wrap break-words">
                <dt>活動</dt>
                <dd>
                  {activityKindLabel(draft.conflict.values.kind)} / {draft.conflict.values.occurredAt}
                </dd>
                <dt>結果・メモ</dt>
                <dd>{draft.conflict.values.note || "（空欄）"}</dd>
                <dt>次回予定</dt>
                <dd>
                  {draft.conflict.values.nextActionMode === "replace"
                    ? draft.conflict.values.nextActionAt
                    : draft.conflict.values.nextActionMode === "clear"
                      ? "解除"
                      : "維持"}
                </dd>
                <dt>運営への相談</dt>
                <dd>{draft.conflict.values.consultOps ? "相談する" : "相談しない"}</dd>
                <dt>企業の意向・再連絡の目安</dt>
                <dd>
                  {draft.conflict.values.declineKind === "do_not_contact"
                    ? "今後も連絡しないでほしい"
                    : draft.conflict.values.declineKind === "not_now"
                      ? `今は不要 / ${draft.conflict.values.recontactAfter || "目安なし"}`
                      : "選択なし"}
                </dd>
                <dt>営業拒否の理由</dt>
                <dd>{draft.conflict.values.declineReason || "（なし）"}</dd>
              </dl>
            ) : (
              <p>下書きは破棄済み、または活動に記録済みです。</p>
            )}
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                draft.applyStored(draft.conflict!, emptyActivity(new Date()));
                setConfirmEnd(false);
              }}
            >
              保存済みの内容を使う
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void draft.keepMine();
              }}
            >
              この画面の入力で保存する
            </Button>
          </div>
        </div>
      )}
      <fieldset disabled={busy || !draft.ready} className="grid min-w-0 gap-4">
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">よく使う活動</legend>
          {(["no_answer", "callback_scheduled", "negotiating"] as const).map((kind) => (
            <Button
              key={kind}
              type="button"
              variant={values.kind === kind ? "default" : "outline"}
              size="sm"
              aria-pressed={values.kind === kind}
              onClick={() => selectKind(kind)}
            >
              {activityKindLabel(kind)}
            </Button>
          ))}
        </fieldset>
        <Field label="活動の種類" htmlFor="activity-kind">
          <NativeSelect
            id="activity-kind"
            value={values.kind}
            onChange={(e) => selectKind(e.target.value as ActivityValues["kind"])}
          >
            {ACTIVITY_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {(values.kind === "contract_review" || values.kind === "contract_completed") && (
          <p className="rounded-lg bg-blue-50 p-3 text-sm">
            契約資料は下の「成約報告」から登録してください。活動記録だけでは契約完了・報酬確定にはなりません。
          </p>
        )}
        <Field label="活動した日時（日本時間）" htmlFor="activity-occurred-at">
          <Input
            id="activity-occurred-at"
            type="datetime-local"
            required
            value={values.occurredAt}
            onChange={(e) => change({ occurredAt: e.target.value })}
          />
        </Field>
        <Field label="結果・メモ" htmlFor="activity-note">
          <Textarea
            id="activity-note"
            rows={4}
            maxLength={2000}
            value={values.note}
            onChange={(e) => change({ note: e.target.value })}
          />
        </Field>
        {previousNote && (
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer">以前のメモを参照する</summary>
            <p className="my-3 whitespace-pre-wrap break-words">{previousNote}</p>
            <Button type="button" size="sm" variant="outline" onClick={reuse}>
              このメモを追記
            </Button>
          </details>
        )}
        <div className="grid gap-3 rounded-lg border bg-slate-50 p-4">
          <p className="text-sm">
            登録済みの次回予定：<strong>{nextActionLabel}</strong>
          </p>
          {terminal ? (
            <p className="text-sm">担当の終了と同時に、次回予定を解除します。</p>
          ) : (
            <Field label="次回予定の扱い" htmlFor="activity-next-mode">
              <NativeSelect
                id="activity-next-mode"
                value={values.nextActionMode}
                onChange={(e) => change({ nextActionMode: e.target.value as ActivityValues["nextActionMode"] })}
              >
                <option value="keep">現在の予定を維持する</option>
                <option value="replace">予定を設定・変更する</option>
                <option value="clear">対応済みとして予定を解除する</option>
              </NativeSelect>
            </Field>
          )}
          {!terminal && values.nextActionMode === "replace" && (
            <>
              <Field label="次回対応日（日本時間・必須）" htmlFor="activity-next-action-at">
                <Input
                  id="activity-next-action-at"
                  type="datetime-local"
                  required
                  value={values.nextActionAt}
                  onChange={(e) => change({ nextActionAt: e.target.value })}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => change({ nextActionAt: suggestedFollowUp(new Date(), 1) })}
                >
                  明日10時
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => change({ nextActionAt: suggestedFollowUp(new Date(), 3) })}
                >
                  3日後10時
                </Button>
              </div>
            </>
          )}
          {values.kind === "callback_scheduled" && values.nextActionMode !== "replace" && (
            <p role="alert" className="text-sm text-amber-800">
              再連絡予定では「予定を設定・変更する」を選び、日時を指定してください。
            </p>
          )}
          {values.nextActionMode === "clear" && (
            <p className="text-xs text-slate-600">
              今回の活動を記録すると、担当案件の次回対応日を空にします。活動履歴は残ります。
            </p>
          )}
        </div>
        <Label className="items-start font-normal">
          <Input
            type="checkbox"
            checked={values.consultOps}
            onChange={(e) => change({ consultOps: e.target.checked })}
          />
          運営に相談する
        </Label>
        {values.kind === "declined" && (
          <fieldset className="grid gap-3 rounded-lg border p-4">
            <legend>営業拒否の内容</legend>
            <Field label="企業の意向" htmlFor="activity-decline-kind">
              <NativeSelect
                id="activity-decline-kind"
                required
                value={values.declineKind}
                onChange={(e) => change({ declineKind: e.target.value as ActivityValues["declineKind"] })}
              >
                <option value="">選択してください</option>
                <option value="not_now">今は不要（時期を改めれば可能性がある）</option>
                <option value="do_not_contact">今後も連絡しないでほしい</option>
              </NativeSelect>
            </Field>
            {values.declineKind === "not_now" && (
              <Field label="企業が示した再連絡の目安（任意）" htmlFor="activity-recontact">
                <Input
                  id="activity-recontact"
                  type="date"
                  value={values.recontactAfter}
                  onChange={(e) => change({ recontactAfter: e.target.value })}
                />
              </Field>
            )}
            <Field label="企業の意向・理由（任意）" htmlFor="activity-decline-reason">
              <Textarea
                id="activity-decline-reason"
                maxLength={500}
                value={values.declineReason}
                onChange={(e) => change({ declineReason: e.target.value })}
              />
            </Field>
          </fieldset>
        )}
        {terminal && (
          <Label className="items-start rounded-lg border border-amber-300 bg-amber-50 p-4 font-normal">
            <Input type="checkbox" required checked={confirmEnd} onChange={(e) => setConfirmEnd(e.target.checked)} />
            <span>
              {values.kind === "declined"
                ? "企業共通の営業抑止を記録し、担当を終了し、次回予定を解除することを確認しました"
                : "失注として担当を終了し、次回予定を解除することを確認しました"}
              <small className="mt-1 block">この確認は下書きには保存されません。</small>
            </span>
          </Label>
        )}
        <Button type="submit" className="w-fit" disabled={!!draft.conflict}>
          {busy ? "記録しています…" : "活動と次回予定を記録する"}
        </Button>
      </fieldset>
      {draft.error && (
        <div role="alert" className="rounded-lg border border-amber-300 p-3 text-sm">
          <p>{draft.error}</p>
          {draft.dirty() && !draft.conflict && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void draft.flush();
              }}
              disabled={busy}
            >
              下書きの保存を再試行
            </Button>
          )}
        </div>
      )}
      {submitError && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
          {submitError}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
          {message}
        </p>
      )}
    </form>
  );
}
