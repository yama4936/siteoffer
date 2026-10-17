"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { draftFingerprint as fingerprint } from "./draft-fingerprint";
export type DraftSnapshot<T> = { revision: number; values: T | null; updatedAt: string | null };
type DraftResult<T> =
  | { status: "ok"; snapshot: DraftSnapshot<T> }
  | { status: "conflict"; snapshot: DraftSnapshot<T> }
  | { status: "error"; message: string };
/** Serializes saves and preserves tombstone revisions. Transport must authenticate on every request. */
export function usePersonalDraft<T extends object>(
  initial: DraftSnapshot<T>,
  defaults: T,
  save: (revision: number, values: T | null) => Promise<DraftResult<T>>,
  preservesNavigation?: (target: HTMLAnchorElement | HTMLFormElement) => boolean,
) {
  const [values, setValues] = useState(initial.values ?? defaults);
  const [status, setStatus] = useState(initial.values ? "保存済みの下書きを復元しました" : "入力すると自動保存します");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<DraftSnapshot<T> | null>(null);
  const [hasDraft, setHasDraft] = useState(!!initial.values);
  const [ready, setReady] = useState(false);
  const revision = useRef(initial.revision),
    latest = useRef(values),
    saved = useRef(fingerprint(values));
  const defaultsRef = useRef(defaults),
    transport = useRef(save),
    conflicted = useRef(false),
    mounted = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const navigationPolicy = useRef(preservesNavigation);
  navigationPolicy.current = preservesNavigation;
  const dirty = useCallback(() => fingerprint(latest.current) !== saved.current, []);
  const cancelPendingSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    mounted.current = true;
    setReady(true);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty() || inFlight.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const confirmLeave = (event: Event) => {
      if (!dirty() && !inFlight.current) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest("a[href]") as HTMLAnchorElement | null;
      const otherForm =
        event.type === "submit" &&
        target instanceof HTMLFormElement &&
        target !== formRef.current &&
        target.method === "get";
      if (
        (!link ||
          link.target === "_blank" ||
          link.hasAttribute("download") ||
          link.getAttribute("href")?.startsWith("#")) &&
        !otherForm
      )
        return;
      if (navigationPolicy.current?.(link ?? (target as HTMLFormElement))) return;
      if (!window.confirm("まだ保存されていない入力があります。保存完了を待たずに移動しますか？")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", confirmLeave, true);
    document.addEventListener("submit", confirmLeave, true);
    return () => {
      mounted.current = false;
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", confirmLeave, true);
      document.removeEventListener("submit", confirmLeave, true);
    };
  }, [dirty]);
  const showConflict = useCallback((snapshot: DraftSnapshot<T>) => {
    conflicted.current = true;
    setConflict(snapshot);
    setStatus("別の画面で下書きが更新されています");
  }, []);
  const flush = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    if (conflicted.current) return false;
    if (!dirty()) return true;
    const task = (async () => {
      while (dirty() && mounted.current && !conflicted.current) {
        const copy = { ...latest.current };
        setStatus("下書きを保存中…");
        setError("");
        try {
          const result = await transport.current(revision.current, copy);
          if (!mounted.current) return false;
          if (result.status === "error") {
            setError(result.message);
            setStatus("未保存の入力があります");
            return false;
          }
          if (
            result.status === "conflict" &&
            (!result.snapshot.values || fingerprint(result.snapshot.values) !== fingerprint(copy))
          ) {
            showConflict(result.snapshot);
            return false;
          }
          revision.current = result.snapshot.revision;
          saved.current = fingerprint(copy);
          setHasDraft(true);
          setStatus("下書きを保存しました");
        } catch {
          if (mounted.current) {
            setError("接続できませんでした。入力はこの画面に残っています。再試行してください");
            setStatus("未保存の入力があります");
          }
          return false;
        }
      }
      return !dirty();
    })();
    inFlight.current = task;
    try {
      return await task;
    } finally {
      inFlight.current = null;
    }
  }, [dirty, showConflict]);
  useEffect(() => {
    if (fingerprint(values) === saved.current) return;
    timer.current = setTimeout(() => {
      void flush();
    }, 650);
    return cancelPendingSave;
  }, [values, flush, cancelPendingSave]);
  function change(next: T) {
    latest.current = next;
    setValues(next);
    setError("");
    if (!conflicted.current)
      setStatus(
        inFlight.current
          ? "下書きを保存中…"
          : fingerprint(next) === saved.current
            ? hasDraft
              ? "下書きを保存しました"
              : "入力すると自動保存します"
            : "変更を保存待ち…",
      );
  }
  function applyStored(snapshot: DraftSnapshot<T>, fallback = defaultsRef.current) {
    cancelPendingSave();
    const next = snapshot.values ?? fallback;
    revision.current = snapshot.revision;
    saved.current = fingerprint(next);
    latest.current = next;
    conflicted.current = false;
    setConflict(null);
    setValues(next);
    setHasDraft(!!snapshot.values);
    setError("");
    setStatus(snapshot.values ? "保存済みの下書きを復元しました" : "下書きはありません");
  }
  async function keepMine() {
    if (!conflict) return;
    revision.current = conflict.revision;
    saved.current = "";
    conflicted.current = false;
    setConflict(null);
    await flush();
  }
  async function discard(fallback = defaultsRef.current) {
    cancelPendingSave();
    if (inFlight.current) await inFlight.current;
    if (conflicted.current) return;
    try {
      const result = await transport.current(revision.current, null);
      if (result.status === "ok") applyStored(result.snapshot, fallback);
      else if (result.status === "conflict") showConflict(result.snapshot);
      else setError(result.message);
    } catch {
      setError("下書きを破棄できませんでした。入力は残っています");
    }
  }
  return {
    values,
    latest,
    revision,
    status,
    error,
    conflict,
    hasDraft,
    ready,
    formRef,
    dirty,
    change,
    flush,
    showConflict,
    applyStored,
    keepMine,
    discard,
    cancelPendingSave,
  };
}
