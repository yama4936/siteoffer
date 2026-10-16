"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type ReadResult<T> = { ok: true; result: T } | { ok: false; message: string };
const unavailable = "確認状況の自動更新ができていません。表示が古い可能性があります。接続を確認してください。";
const delayed = "確認状況の取得に時間がかかっています。表示が古い可能性があります。";

/** Poll read-only snapshots without replacing a form or racing a newer user operation. */
export function useMaterialUpdates<T>({
  snapshot,
  load,
  apply,
  editing,
  paused,
}: {
  snapshot: T;
  load: () => Promise<ReadResult<T>>;
  apply: (value: T) => void;
  editing: string | null;
  paused: boolean;
}) {
  const [error, setError] = useState(""),
    [waiting, setWaiting] = useState(false),
    [notice, setNotice] = useState(""),
    [checkedAt, setCheckedAt] = useState<number | null>(null);
  const generation = useRef(0),
    flight = useRef<{ startedAt: number } | null>(null),
    resume = useRef<(() => void) | null>(null);
  // Call synchronously before a manual read, mutation or editor switch. A background
  // response may still arrive, but it must not replace the user's newer state.
  const invalidate = useCallback(() => {
    generation.current += 1;
  }, []);
  const acknowledge = useCallback(() => {
    setError("");
    setWaiting(false);
    setNotice("");
    setCheckedAt(Date.now());
  }, []);
  useEffect(() => {
    if (paused) return;
    let active = true;
    const version = generation.current;
    const current = () => active && generation.current === version;
    async function check() {
      if (!current() || document.visibilityState === "hidden") return;
      if (!navigator.onLine) {
        setError(unavailable);
        return;
      }
      if (flight.current) {
        if (Date.now() - flight.current.startedAt >= 15000) setError(delayed);
        return;
      }
      flight.current = { startedAt: Date.now() };
      const slow = window.setTimeout(() => {
        if (current()) setError(delayed);
      }, 15000);
      try {
        const result = await load();
        if (!current()) return;
        if (!result.ok) {
          setError(`確認状況を取得できません。${result.message}`);
          return;
        }
        setError("");
        setCheckedAt(Date.now());
        const changed = JSON.stringify(result.result) !== JSON.stringify(snapshot);
        if (editing) {
          setWaiting(changed);
          return;
        }
        setWaiting(false);
        if (changed) {
          apply(result.result);
          setNotice("新しい確認状況を反映しました。");
        }
      } catch {
        if (current()) setError(unavailable);
      } finally {
        window.clearTimeout(slow);
        flight.current = null;
        // A newer editor/state may have ignored this response. Resume its read
        // once the old request settles instead of waiting for another interval.
        if (!current()) resume.current?.();
      }
    }
    const offline = () => {
      if (current()) setError(unavailable);
    };
    const timer = window.setInterval(() => void check(), 30000);
    const wake = () => void check();
    resume.current = wake;
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", wake);
    if (waiting && !editing) void check();
    return () => {
      active = false;
      if (resume.current === wake) resume.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [snapshot, load, apply, editing, paused, waiting]);
  return { error, waiting, notice, checkedAt, invalidate, acknowledge };
}

export function MaterialUpdatesStatus({
  updates,
  editing,
  pending,
}: {
  updates: Pick<ReturnType<typeof useMaterialUpdates>, "error" | "waiting" | "notice" | "checkedAt">;
  editing: boolean;
  pending: boolean;
}) {
  return (
    <section className="space-y-2 text-sm" aria-label="確認状況の更新">
      <p className="text-xs leading-6 text-slate-500">
        {pending
          ? "送信結果を確認しています。完了後に自動更新を再開します。"
          : editing
            ? "30秒ごとに変更を確認します。入力中の内容は自動で置き換えません。"
            : "30秒ごとに自動更新します。"}
        {updates.checkedAt !== null && (
          <span className="ml-2 inline-block">
            最終確認：
            {new Date(updates.checkedAt).toLocaleTimeString("ja-JP", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        )}
      </p>
      {updates.error && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 leading-7 text-amber-900">
          {updates.error}
        </div>
      )}
      {updates.waiting ? (
        <div role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 leading-7 text-blue-900">
          確認状況が更新されています。入力を保持しています。送信前に一覧を更新して、最新の内容をご確認ください。
        </div>
      ) : !updates.error && updates.notice ? (
        <p role="status" className="text-blue-700">
          {updates.notice}
        </p>
      ) : null}
    </section>
  );
}
