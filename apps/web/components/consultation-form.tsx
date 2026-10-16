"use client";
import type {
  ConsultationCommand,
  ConsultationDraftSnapshot,
  ConsultationDraftValues,
  ConsultationOperation,
  ConsultationStatus,
  SubmitConsultationDraftInput,
} from "@siteoffer/core";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  saveConsultationDraftAction,
  submitConsultationAction,
  submitConsultationDraftAction,
} from "@/app/consultation-actions";
import { Button } from "@/components/ui/button";
import { usePersonalDraft } from "@/components/use-personal-draft";

export function ConsultationForm({
  activityId,
  initialDraft,
  revision,
  status,
  userRole: role,
  userId,
  assignedTo,
  assignedName,
}: {
  activityId: string;
  initialDraft: ConsultationDraftSnapshot;
  revision: number;
  status: ConsultationStatus;
  userRole: "ops" | "sales";
  userId: string;
  assignedTo: string | null;
  assignedName: string | null;
}) {
  const router = useRouter();
  const defaults: ConsultationDraftValues = { note: "", mode: "resolve", caseRevision: String(revision) };
  const draft = usePersonalDraft(initialDraft, defaults, (r, values) =>
    saveConsultationDraftAction(activityId, r, values),
  );
  const { note, mode } = draft.values;
  const [baseRevision, setBaseRevision] = useState(Number(initialDraft.values?.caseRevision ?? revision));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [resultUnknown, setResultUnknown] = useState(false);
  const submitted = useRef<SubmitConsultationDraftInput | null>(null);
  const [failed, setFailed] = useState(false);
  const [reviewNeeded, setReviewNeeded] = useState(false);
  const hydrated = draft.ready;
  const sending = useRef(false);
  const attempt = useRef<{ fingerprint: string; command: ConsultationCommand } | null>(null);
  const stale = reviewNeeded || revision > baseRevision;
  const syncing = revision < baseRevision;
  const other = role === "ops" && !!assignedTo && assignedTo !== userId;
  function change(patch: Partial<ConsultationDraftValues>) {
    draft.change({ ...draft.latest.current, caseRevision: String(baseRevision), ...patch });
    setMessage("");
  }
  function applySaved(snapshot: ConsultationDraftSnapshot) {
    draft.applyStored(snapshot, defaults);
    setBaseRevision(Number(snapshot.values?.caseRevision ?? revision));
    setReviewNeeded(false);
    attempt.current = null;
  }
  async function discard() {
    if (pending || !window.confirm("自分の下書きを破棄しますか？送信済みの相談・回答は残ります。")) return;
    setPending(true);
    try {
      await draft.discard(defaults);
      if (!draft.latest.current.note) {
        setBaseRevision(revision);
        setReviewNeeded(false);
        attempt.current = null;
      }
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    if (revision <= baseRevision) return;
    if (!failed) setMessage("");
    // 未送信の文章や結果不明の送信がないときは、新しい状態をそのまま表示する。
    if (!note.trim() && !pending && !attempt.current && !reviewNeeded) setBaseRevision(revision);
  }, [revision, baseRevision, failed, note, pending, reviewNeeded]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!note && !pending && document.visibilityState === "visible") router.refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, [note, pending, router]);
  async function send(operation: ConsultationOperation) {
    if (sending.current || pending || resultUnknown || stale || syncing || draft.conflict || !draft.ready) return;
    sending.current = true;
    draft.cancelPendingSave();
    setPending(true);
    setMessage("");
    setFailed(false);
    try {
      if (!(await draft.flush())) return;
      const body = {
        activityId,
        revision: baseRevision,
        operation,
        note: operation === "take" ? "" : draft.latest.current.note,
      };
      const fingerprint = JSON.stringify(body);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, command: { ...body, requestKey: crypto.randomUUID() } };
      if (operation === "take") {
        const result = await submitConsultationAction(attempt.current.command);
        if (!result.ok) {
          fail(result.error, result.message);
          return;
        }
        setBaseRevision(result.value.revision);
        if (draft.hasDraft || draft.latest.current.note)
          draft.change({ ...draft.latest.current, caseRevision: String(result.value.revision) });
        setMessage("この相談を担当しました。入力中の下書きは残しています。");
      } else {
        const input: SubmitConsultationDraftInput = {
          revision: draft.revision.current,
          values: { ...draft.latest.current, caseRevision: String(baseRevision) },
          operation,
          requestKey: attempt.current.command.requestKey,
        };
        submitted.current = input;
        if (!(await deliver(input))) return;
      }
      setReviewNeeded(false);
      attempt.current = null;
      router.refresh();
    } catch {
      if (operation !== "take" && submitted.current) setResultUnknown(true);
      setFailed(true);
      setMessage("結果を確認できませんでした。入力は残っています。同じ内容で再試行しても二重記録にはなりません");
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  async function deliver(input: SubmitConsultationDraftInput) {
    const result = await submitConsultationDraftAction(activityId, input);
    if (result.status === "conflict") {
      submitted.current = null;
      setResultUnknown(false);
      draft.showConflict(result.snapshot);
      return false;
    }
    if (result.status === "error") {
      setResultUnknown(result.code === "unexpected");
      if (result.code !== "unexpected") submitted.current = null;
      fail(result.code, result.message);
      return false;
    }
    setResultUnknown(false);
    setFailed(false);
    submitted.current = null;
    draft.applyStored(result.snapshot, { ...defaults, caseRevision: String(result.revision) });
    setBaseRevision(Number(result.snapshot.values?.caseRevision ?? result.revision));
    setMessage(
      result.replayed
        ? "送信済みの記録を確認しました。二重には記録していません。"
        : input.operation === "resolve"
          ? "回答を記録し、対応を完了しました"
          : input.operation === "reopen"
            ? "対応を再開しました"
            : "メッセージを記録しました",
    );
    return true;
  }
  async function retrySubmission() {
    if (sending.current || pending || !submitted.current) return;
    sending.current = true;
    setPending(true);
    try {
      if (await deliver(submitted.current)) {
        setReviewNeeded(false);
        attempt.current = null;
        router.refresh();
      }
    } catch {
      setFailed(true);
      setMessage("まだ送信結果を確認できません。接続を確認して再試行してください。");
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  function fail(code: string, text?: string) {
    setFailed(true);
    setMessage(text ?? "この相談を更新できませんでした");
    if (["conflict", "assigned_elsewhere", "invalid_state"].includes(code)) {
      setReviewNeeded(true);
      router.refresh();
    }
  }
  const operation = role === "sales" ? "follow_up" : status === "resolved" ? "reopen" : mode;
  return (
    <section aria-label="相談への対応" className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-lg">
          {role === "sales" ? "追加で相談する" : status === "resolved" ? "対応を再開する" : "営業へ回答する"}
        </h2>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => router.refresh()}>
          最新の履歴を表示
        </Button>
      </div>
      <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
        <p role="status">{draft.status}</p>
        <p className="mt-1 text-xs text-slate-600">
          自分専用の下書きです。送信するまで相手への回答・相談履歴には表示されません。
        </p>
        {draft.hasDraft && !draft.conflict && (
          <Button variant="ghost" size="sm" disabled={pending || resultUnknown} onClick={() => void discard()}>
            下書きを破棄
          </Button>
        )}
      </div>
      {draft.conflict && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p>別の画面で下書きが更新されたため、保存を止めました。この画面の入力は残っています。</p>
          <details className="my-3">
            <summary className="cursor-pointer">保存済みの内容を見る</summary>
            {draft.conflict.values ? (
              <div className="mt-2 whitespace-pre-wrap break-words">
                <p>{draft.conflict.values.note || "（本文は空欄）"}</p>
                {role === "ops" && (
                  <p>回答後：{draft.conflict.values.mode === "resolve" ? "対応完了" : "対応を継続"}</p>
                )}
              </div>
            ) : (
              <p>下書きは破棄済み、または送信済みです。履歴を確認してください。</p>
            )}
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending || resultUnknown}
              onClick={() => applySaved(draft.conflict!)}
            >
              保存済みの内容を使う
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || resultUnknown}
              onClick={async () => {
                setPending(true);
                try {
                  await draft.keepMine();
                } finally {
                  setPending(false);
                }
              }}
            >
              この画面の入力で保存する
            </Button>
          </div>
        </div>
      )}
      {draft.error && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
          <p>{draft.error}</p>
          {!draft.conflict && draft.dirty() && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={pending || resultUnknown}
              onClick={async () => {
                setPending(true);
                try {
                  await draft.flush();
                } finally {
                  setPending(false);
                }
              }}
            >
              下書きの保存を再試行
            </Button>
          )}
        </div>
      )}
      {message && (
        <p
          role={failed ? "alert" : "status"}
          className={`mb-3 rounded-lg border p-3 text-sm ${failed ? "text-destructive" : "text-success"}`}
        >
          {message}
        </p>
      )}
      {resultUnknown && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p>内容を変更する前に、直前の送信結果を確認してください。同じ送信として再試行し、二重記録を防ぎます。</p>
          <Button className="mt-2" variant="outline" disabled={pending} onClick={() => void retrySubmission()}>
            {pending ? "送信結果を確認中…" : "送信結果を再確認"}
          </Button>
        </div>
      )}
      {stale && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p>相談の状態が更新されました。入力は残っています。上の最新履歴を確認してから続けてください。</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={pending || resultUnknown}
            onClick={() => {
              setBaseRevision(revision);
              if (draft.hasDraft || note) draft.change({ ...draft.latest.current, caseRevision: String(revision) });
              setReviewNeeded(false);
              attempt.current = null;
            }}
          >
            最新の内容を確認しました
          </Button>
        </div>
      )}
      {role === "ops" && status !== "resolved" && assignedTo !== userId && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 p-3 text-sm">
          <p>
            {other
              ? `${assignedName ?? "別の運営担当"}が対応中です。回答する場合は担当を引き継いでください。`
              : "先に担当を引き受けると、ほかの運営担当にも対応中と伝わります。"}
          </p>
          <Button
            variant="outline"
            disabled={!hydrated || pending || resultUnknown || stale || syncing || !!draft.conflict}
            onClick={() => send("take")}
          >
            {pending ? "記録中…" : other ? "自分に引き継ぐ" : "対応を開始する"}
          </Button>
        </div>
      )}
      <form
        ref={draft.formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void send(operation);
        }}
      >
        <fieldset disabled={!hydrated || pending || resultUnknown || syncing} className="space-y-3">
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={`consultation-note-${activityId}`}>
              {role === "sales"
                ? "追加の相談内容"
                : status === "resolved"
                  ? "再開する理由"
                  : "回答・次に行ってほしいこと"}
            </label>
            <textarea
              id={`consultation-note-${activityId}`}
              value={note}
              onChange={(event) => change({ note: event.target.value })}
              required
              maxLength={2000}
              rows={5}
              className="block w-full rounded-lg border bg-background px-3 py-2 font-normal focus-visible:outline-primary"
              placeholder={
                role === "sales"
                  ? "追加で分かったことや、確認したいことを入力"
                  : status === "resolved"
                    ? "対応の再開が必要になった理由を入力"
                    : "確認した結果と、営業担当が次に行うことを入力"
              }
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {note.length} / 2,000文字 · {role === "ops" ? "営業担当にも表示されます" : "運営担当に共有されます"}
            </span>
            {role === "ops" && status !== "resolved" && (
              <label className="text-sm">
                回答後の状態{" "}
                <select
                  aria-label="回答後の状態"
                  value={mode}
                  onChange={(event) => change({ mode: event.target.value as "resolve" | "reply" })}
                  className="ml-2 rounded-md border bg-background p-2"
                >
                  <option value="resolve">対応完了</option>
                  <option value="reply">対応を継続</option>
                </select>
              </label>
            )}
          </div>
          {role === "sales" && status === "resolved" && (
            <p className="text-sm text-muted-foreground">追加の相談を送ると、運営の対応待ちに戻ります。</p>
          )}
          <Button
            type="submit"
            disabled={stale || !!draft.conflict || (other && operation !== "reopen")}
            aria-busy={pending}
          >
            {pending
              ? "記録しています…"
              : role === "sales"
                ? "追加の相談を送る"
                : status === "resolved"
                  ? "理由を記録して再開"
                  : mode === "resolve"
                    ? "回答して対応を完了"
                    : "回答して対応を続ける"}
          </Button>
        </fieldset>
      </form>
    </section>
  );
}
