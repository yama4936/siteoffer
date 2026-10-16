"use client";
import type { ConsultationCommand, ConsultationOperation, ConsultationStatus } from "@siteoffer/core";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { submitConsultationAction } from "@/app/consultation-actions";
import { Button } from "@/components/ui/button";

export function ConsultationForm({
  activityId,
  revision,
  status,
  userRole: role,
  userId,
  assignedTo,
  assignedName,
}: {
  activityId: string;
  revision: number;
  status: ConsultationStatus;
  userRole: "ops" | "sales";
  userId: string;
  assignedTo: string | null;
  assignedName: string | null;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [baseRevision, setBaseRevision] = useState(revision);
  const [mode, setMode] = useState<"resolve" | "reply">("resolve");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [reviewNeeded, setReviewNeeded] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const attempt = useRef<{ fingerprint: string; command: ConsultationCommand } | null>(null);
  const stale = reviewNeeded || revision > baseRevision;
  const syncing = revision < baseRevision;
  const other = role === "ops" && !!assignedTo && assignedTo !== userId;
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    if (revision <= baseRevision) return;
    if (!failed) setMessage("");
    // 未送信の文章や結果不明の送信がないときは、新しい状態をそのまま表示する。
    if (!note.trim() && !pending && !attempt.current && !reviewNeeded) setBaseRevision(revision);
  }, [revision, baseRevision, failed, note, pending, reviewNeeded]);
  useEffect(() => {
    if (!note.trim()) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onLink = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.hasAttribute("download")) return;
      const target = new URL(link.href, location.href);
      if (target.pathname === location.pathname && target.search === location.search) return;
      if (!window.confirm("未送信の相談内容があります。入力を破棄して移動しますか？")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", onLink, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", onLink, true);
    };
  }, [note]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!note && !pending && document.visibilityState === "visible") router.refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, [note, pending, router]);
  async function send(operation: ConsultationOperation) {
    if (pending || stale || syncing) return;
    const body = { activityId, revision: baseRevision, operation, note: operation === "take" ? "" : note };
    const fingerprint = JSON.stringify(body);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, command: { ...body, requestKey: crypto.randomUUID() } };
    setPending(true);
    setMessage("");
    setFailed(false);
    try {
      const result = await submitConsultationAction(attempt.current.command);
      if (result.ok) {
        if (operation !== "take") setNote("");
        setBaseRevision(result.value.revision);
        setReviewNeeded(false);
        attempt.current = null;
        setMessage(
          operation === "take"
            ? "この相談を担当しました"
            : operation === "resolve"
              ? "回答を記録し、対応を完了しました"
              : operation === "reopen"
                ? "対応を再開しました"
                : "メッセージを記録しました",
        );
        router.refresh();
      } else {
        setFailed(true);
        setMessage(
          result.message ??
            (result.error === "forbidden" ? "ログイン状態を確認してください" : "この相談を更新できませんでした"),
        );
        if (["conflict", "assigned_elsewhere", "invalid_state"].includes(result.error)) {
          setReviewNeeded(true);
          router.refresh();
        }
      }
    } catch {
      setFailed(true);
      setMessage("結果を確認できませんでした。入力は残っています。同じ内容で再試行しても二重記録にはなりません");
    } finally {
      setPending(false);
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
      {message && (
        <p
          role={failed ? "alert" : "status"}
          className={`mb-3 rounded-lg border p-3 text-sm ${failed ? "text-destructive" : "text-success"}`}
        >
          {message}
        </p>
      )}
      {stale && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p>相談の状態が更新されました。入力は残っています。上の最新履歴を確認してから続けてください。</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={pending}
            onClick={() => {
              setBaseRevision(revision);
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
          <Button variant="outline" disabled={!hydrated || pending || stale || syncing} onClick={() => send("take")}>
            {pending ? "記録中…" : other ? "自分に引き継ぐ" : "対応を開始する"}
          </Button>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(operation);
        }}
      >
        <fieldset disabled={!hydrated || pending || syncing} className="space-y-3">
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
              onChange={(event) => setNote(event.target.value)}
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
                  onChange={(event) => setMode(event.target.value as "resolve" | "reply")}
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
          <Button type="submit" disabled={stale || (other && operation !== "reopen")} aria-busy={pending}>
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
