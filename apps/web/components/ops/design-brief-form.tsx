"use client";
import type { DesignBrief } from "@siteoffer/core";
import { ImagePlus, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createDesignAction, saveDesignDraftAction } from "@/app/(ops)/ops/designs/actions";
import { DESIGN_BRIEF_FIELDS, type DesignDraftScope, type DesignDraftSnapshot } from "@/lib/ops/design-draft-types";
import { preservesDesignFilter } from "./design-filter-navigation";

const fingerprint = (value: DesignBrief) => JSON.stringify(DESIGN_BRIEF_FIELDS.map(([key]) => value[key]));
export function DesignBriefForm({
  scope,
  initial,
  defaults,
  configured,
  generationNotice,
  canCreate,
  requestKey,
  reviewNote,
}: {
  scope: DesignDraftScope;
  initial: DesignDraftSnapshot;
  defaults: DesignBrief;
  configured: boolean;
  generationNotice: string;
  canCreate: boolean;
  requestKey: string;
  reviewNote?: string | null;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial.values ?? defaults);
  const [status, setStatus] = useState(initial.values ? "保存済みの下書きを復元しました" : "入力すると自動保存します");
  const [conflict, setConflict] = useState<DesignDraftSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasDraft, setHasDraft] = useState(!!initial.values);
  const latest = useRef(values);
  const draftScope = useRef(scope);
  const saved = useRef(fingerprint(values));
  const revision = useRef(initial.revision);
  const conflicted = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const leaving = useRef(false);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const operationKey = useRef(requestKey);
  const dirty = useCallback(() => fingerprint(latest.current) !== saved.current, []);

  useEffect(() => {
    mounted.current = true;
    setReady(true);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!leaving.current && (dirty() || inFlight.current)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const confirmLeave = (event: Event) => {
      if (leaving.current || (!dirty() && !inFlight.current)) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest("a[href]") as HTMLAnchorElement | null;
      const otherForm =
        event.type === "submit" &&
        target instanceof HTMLFormElement &&
        target !== form.current &&
        target.method === "get";
      if (
        (!link ||
          link.target === "_blank" ||
          link.hasAttribute("download") ||
          link.getAttribute("href")?.startsWith("#")) &&
        !otherForm
      )
        return;
      if (
        (link && preservesDesignFilter(link, draftScope.current)) ||
        (otherForm && target instanceof HTMLFormElement && preservesDesignFilter(target, draftScope.current))
      )
        return;
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

  const showConflict = useCallback(function showConflict(snapshot: DesignDraftSnapshot) {
    conflicted.current = true;
    setConflict(snapshot);
    setStatus("別の画面で下書きが更新されています");
  }, []);
  const flush = useCallback(
    async function flush(): Promise<boolean> {
      if (inFlight.current) return inFlight.current;
      if (conflicted.current) return false;
      if (!dirty()) return true;
      const task = (async () => {
        while (dirty() && mounted.current && !conflicted.current) {
          const copy = { ...latest.current };
          setStatus("下書きを保存中…");
          setError("");
          try {
            const result = await saveDesignDraftAction(draftScope.current, revision.current, copy);
            if (!mounted.current) return false;
            if (
              result.status === "conflict" &&
              (!result.snapshot.values || fingerprint(result.snapshot.values) !== fingerprint(copy))
            ) {
              showConflict(result.snapshot);
              return false;
            }
            // A response may be lost after the server saved it. Identical stored text is already safe.
            if (result.status === "error") {
              setError(result.message);
              setStatus("未保存の入力があります");
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
    },
    [dirty, showConflict],
  );
  // Schedule from edits, never from error/status updates; failed requests require an explicit retry.
  useEffect(() => {
    if (fingerprint(values) === saved.current) return;
    autosaveTimer.current = setTimeout(() => {
      void flush();
    }, 650);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [values, flush]);

  function change(key: keyof DesignBrief, value: string) {
    const next = { ...latest.current, [key]: value };
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
              : "元の制作条件を表示しています"
            : "変更を保存待ち…",
      );
  }
  function applyStored(snapshot: DesignDraftSnapshot) {
    const next = snapshot.values ?? defaults;
    revision.current = snapshot.revision;
    saved.current = fingerprint(next);
    latest.current = next;
    conflicted.current = false;
    setConflict(null);
    setValues(next);
    setHasDraft(!!snapshot.values);
    setError("");
    setStatus(snapshot.values ? "保存済みの下書きを復元しました" : "下書きはありません。元の制作条件を表示しています");
  }
  async function keepMine() {
    if (!conflict) return;
    revision.current = conflict.revision;
    // Force a save even when the local text matches the originally loaded copy.
    saved.current = "";
    conflicted.current = false;
    setConflict(null);
    await flush();
  }
  async function discard() {
    if (!window.confirm("この下書きを破棄し、元の制作条件に戻しますか？")) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    setBusy(true);
    try {
      if (inFlight.current) await inFlight.current;
      if (conflicted.current) return;
      const result = await saveDesignDraftAction(draftScope.current, revision.current, null);
      if (result.status === "ok") applyStored(result.snapshot);
      else if (result.status === "conflict") showConflict(result.snapshot);
      else setError(result.message);
    } catch {
      setError("破棄できませんでした。下書きは残っています");
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !ready) return;
    const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const source = button?.value === "openai" ? "openai" : "import";
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    setBusy(true);
    setError("");
    try {
      if (!(await flush())) return;
      const result = await createDesignAction(scope, {
        revision: revision.current,
        brief: latest.current,
        requestKey: operationKey.current,
        source,
      });
      if (result.status === "conflict") showConflict(result.snapshot);
      else if (result.status === "error") setError(result.message);
      else {
        leaving.current = true;
        router.push(result.url);
        router.refresh();
      }
    } catch {
      setError("結果を確認できませんでした。入力を残しています。同じ操作を再試行できます");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form ref={form} onSubmit={submit} aria-label="制作条件の編集">
      <div className="design-draft-status">
        <p role="status" aria-live="polite">
          {status}
        </p>
        <small>自分専用の下書きです。案件・元の版ごとに保存されます。</small>
        {hasDraft && !conflict && (
          <button type="button" onClick={discard} disabled={busy}>
            下書きを破棄
          </button>
        )}
      </div>
      {conflict && (
        <div className="design-draft-conflict" role="alert">
          <strong>ほかのタブの変更を上書きしないよう、保存を止めました。</strong>
          <p>この画面の入力は残っています。どちらの内容を使うか選んでください。</p>
          <details>
            <summary>保存済みの内容を見る</summary>
            {conflict.values ? (
              DESIGN_BRIEF_FIELDS.map(([key, label]) => (
                <div key={key}>
                  <b>{label}</b>
                  <p>{conflict.values?.[key] || "（空欄）"}</p>
                </div>
              ))
            ) : (
              <p>下書きは破棄済み、または新しい版に保存済みです。</p>
            )}
          </details>
          <button type="button" onClick={() => applyStored(conflict)} disabled={busy}>
            保存済みの内容を使う
          </button>
          <button type="button" onClick={keepMine} disabled={busy}>
            この画面の入力で保存する
          </button>
        </div>
      )}
      <noscript>
        <p className="design-note">制作条件を編集するにはJavaScriptを有効にしてください。</p>
      </noscript>
      <fieldset disabled={busy || !ready} className="design-brief-fields">
        {DESIGN_BRIEF_FIELDS.map(([key, label]) => (
          <label key={key}>
            {label}
            <textarea
              name={key}
              required
              maxLength={1600}
              rows={key === "direction" || key === "updatePlan" ? 3 : 2}
              value={values[key]}
              onChange={(event) => change(key, event.target.value)}
            />
          </label>
        ))}
        {reviewNote && <p className="design-note">前回の確認メモ：{reviewNote}</p>}
        <div className="design-actions">
          <button
            className="design-button"
            type="submit"
            value="openai"
            disabled={!canCreate || !configured || !!conflict}
            aria-describedby="design-generation-notice"
          >
            <Sparkles size={16} />
            {busy ? "保存中…" : "画像を生成"}
          </button>
          <button className="design-button secondary" type="submit" value="import" disabled={!canCreate || !!conflict}>
            <ImagePlus size={16} />
            {busy ? "保存中…" : "画像を取り込む版を作成"}
          </button>
        </div>
      </fieldset>
      {error && (
        <div className="design-draft-error" role="alert">
          <p>{error}</p>
          {!conflict && dirty() && (
            <button
              type="button"
              onClick={() => {
                void flush();
              }}
              disabled={busy}
            >
              下書きの保存を再試行
            </button>
          )}
        </div>
      )}
      <p className="design-muted">変更・再生成は新しい版として保存します。承認済みの画像は変更されません。</p>
      <p id="design-generation-notice" className="design-note">
        {generationNotice}
      </p>
      {!scope.auditId && (
        <p className="design-note">
          改善提案の対象と判定された診断が必要です。
          <br />
          <a
            href={`/ops/designs?${new URLSearchParams({ company: scope.companyId, design: scope.designId ?? "new" })}`}
          >
            最新の診断を確認する
          </a>
        </p>
      )}
    </form>
  );
}
