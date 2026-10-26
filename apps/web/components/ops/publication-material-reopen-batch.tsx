"use client";
import type { getPublicationReopenBatch, PublicationMaterialItem } from "@siteoffer/core";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { reopenPublicationMaterialBatchAction } from "@/app/publication-material-actions";
import { Button } from "@/components/ui/button";
import { controlClass } from "@/components/ui/input";
import { readPublicationPreview } from "@/lib/client/publication-preview";
import { fmtDate } from "@/lib/ops/format";

type Preview = Awaited<ReturnType<typeof getPublicationReopenBatch>>;
type Payload = Parameters<typeof reopenPublicationMaterialBatchAction>[0];
const labels: Record<string, string> = {
  pending: "対応が必要",
  resolved: "対応確認済み",
  clear: "素材の問題なし",
  unavailable: "記録を取得できません",
};
export function PublicationMaterialReopenBatch({
  deploymentId,
  initialNote,
  onClose,
  onSaved,
}: {
  deploymentId: string;
  initialNote: string;
  onClose: () => void;
  onSaved: (items: PublicationMaterialItem[], replayed: boolean) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(true),
    [pending, setPending] = useState<Payload | null>(null),
    [message, setMessage] = useState("");
  const [ids, setIds] = useState<string[]>([]),
    [note, setNote] = useState(initialNote),
    [confirmed, setConfirmed] = useState(false);
  const readController = useRef<AbortController | null>(null);
  const gate = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    readController.current = controller;
    heading.current?.focus();
    void readPublicationPreview(deploymentId, "reopen", controller.signal)
      .then((r) => {
        if (active) {
          if (r.ok) setPreview(r.preview);
          else setMessage(r.message);
        }
      })
      .catch(() => {
        if (active) setMessage("一括確認の履歴を取得できませんでした。再度更新してください。");
      })
      .finally(() => {
        if (active) setBusy(false);
        if (readController.current === controller) readController.current = null;
      });
    return () => {
      active = false;
      controller.abort();
      readController.current?.abort();
    };
  }, [deploymentId]);
  async function refresh() {
    if (gate.current || pending) return;
    gate.current = true;
    setBusy(true);
    const controller = new AbortController();
    readController.current = controller;
    try {
      const r = await readPublicationPreview(deploymentId, "reopen", controller.signal);
      if (controller.signal.aborted) return;
      if (r.ok) {
        setPreview(r.preview);
        setIds([]);
        setConfirmed(false);
        setMessage("最新の履歴を取得しました。理由を保持しています。対象と確認チェックを選び直してください。");
      } else setMessage(r.message);
    } catch {
      if (!controller.signal.aborted) setMessage("履歴を取得できませんでした。入力は保持しています。");
    } finally {
      gate.current = false;
      if (!controller.signal.aborted) setBusy(false);
      if (readController.current === controller) readController.current = null;
    }
  }
  async function send(input: Payload) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setPending(input);
    setMessage("");
    try {
      const r = await reopenPublicationMaterialBatchAction(input);
      if (!r.ok) {
        setMessage(r.message);
        setPending(null);
        return;
      }
      setPending(null);
      onSaved(r.items, r.replayed);
    } catch {
      setMessage("保存結果を確認できません。同じ受付で再試行してください。選択と理由を固定して保持しています。");
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  const eligible = preview?.items.filter((r) => r.eligible) ?? [];
  return (
    <section
      aria-label="一括確認をまとめてやり直す"
      className="space-y-4 rounded-xl border-2 border-blue-200 bg-white p-5"
    >
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">
        一括確認をまとめてやり直す
      </h2>
      <p className="text-sm leading-7">
        元の一括確認に含まれた記録と現在の状態を照合しています。後から個別に確認し直した記録は保護し、変更されていない対象を選んで再確認へ戻せます。
      </p>
      {busy && !preview && <p role="status">元の受付と履歴を取得しています…</p>}
      {message && (
        <p role="status" className="rounded-lg bg-blue-50 p-4 text-sm leading-7">
          {message}
        </p>
      )}
      {pending && !busy && <Button onClick={() => void send(pending)}>同じ受付で再試行</Button>}
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={busy || pending !== null} onClick={() => void refresh()}>
          理由を残して履歴を更新
        </Button>
        <Button
          variant="outline"
          disabled={pending !== null}
          onClick={() => {
            if (note && !window.confirm("未送信の理由を破棄して閉じますか？")) return;
            onClose();
          }}
        >
          まとめてやり直す画面を閉じる
        </Button>
      </div>
      {preview && (
        <>
          <div className="space-y-1 rounded-lg bg-slate-50 p-4 text-sm leading-7">
            <strong>{preview.companyName}</strong>
            <p>
              {preview.environment} · 確認者：{preview.checkedByName} · {fmtDate(preview.checkedAt)}
            </p>
            <a href={preview.url} target="_blank" rel="noreferrer" className="break-all text-blue-700 underline">
              {preview.url}（別タブ）
            </a>
            <p className="pt-2 font-medium">元の確認メモ</p>
            <p className="whitespace-pre-wrap break-words">{preview.originalNote}</p>
          </div>
          <p className="text-sm leading-7">
            元の一括確認は{preview.items.length}件です。現在まとめて戻せるのは{eligible.length}
            件、状態の変更などにより対象外となるのは{preview.items.length - eligible.length}件です。
          </p>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || pending) return;
              if (ids.length < 2) {
                setMessage("まとめて戻す記録を2件以上選択してください。");
                return;
              }
              void send({
                deploymentId,
                scope: preview.scope,
                items: eligible
                  .filter((r) => ids.includes(r.deploymentId))
                  .map((r) => ({ deploymentId: r.deploymentId, revision: r.revision })),
                requestId: crypto.randomUUID(),
                note,
                confirmed,
              });
            }}
          >
            <fieldset disabled={busy || pending !== null} className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={eligible.length < 2}
                  onClick={() => {
                    setIds(eligible.map((r) => r.deploymentId));
                    setConfirmed(false);
                  }}
                >
                  戻せる{eligible.length}件をすべて選ぶ
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setIds([]);
                    setConfirmed(false);
                  }}
                >
                  選択を解除
                </Button>
                <span aria-live="polite" className="text-sm">
                  選択 {ids.length}件
                </span>
              </div>
              <fieldset className="max-h-96 overflow-y-auto rounded-lg border">
                <legend className="sr-only">元の一括確認に含まれた公開記録</legend>
                {preview.items.map((r) => (
                  <div key={r.deploymentId} className="border-b p-4 last:border-0">
                    <label className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1.5 shrink-0"
                        disabled={!r.eligible}
                        checked={ids.includes(r.deploymentId)}
                        onChange={(e) => {
                          setIds(
                            e.target.checked ? [...ids, r.deploymentId] : ids.filter((id) => id !== r.deploymentId),
                          );
                          setConfirmed(false);
                        }}
                      />
                      <span className="min-w-0 text-sm leading-7">
                        <strong>{r.version ? `第${r.version}版` : "版の記録を確認してください"}</strong>
                        <span className="ml-3 text-xs text-slate-500">記録 {r.deploymentId.slice(0, 8)}</span>
                        <span className="block">現在：{labels[r.state] ?? r.state}</span>
                        <span className={`block text-xs ${r.eligible ? "text-slate-600" : "text-amber-800"}`}>
                          {r.reason}
                        </span>
                      </span>
                    </label>
                    <Link
                      className="ml-6 mt-1 inline-block text-xs text-blue-700 underline"
                      target="_blank"
                      rel="noreferrer"
                      href={`/ops/publication-checks?delivery=${preview.deliveryId}&focus=${r.deploymentId}&mode=all`}
                    >
                      個別の状態を別タブで確認
                    </Link>
                  </div>
                ))}
              </fieldset>
              {eligible.length < 2 && (
                <p className="text-sm leading-7 text-amber-800">
                  まとめて戻せる対象が2件未満です。現在の状態を個別に確認してください。
                </p>
              )}
              <div className="space-y-2">
                <label htmlFor="batch-reopen-reason" className="text-sm font-medium">
                  再確認へ戻す理由
                </label>
                <textarea
                  id="batch-reopen-reason"
                  className={`${controlClass} min-h-28`}
                  required
                  minLength={10}
                  maxLength={2000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <p className="text-xs leading-6 text-slate-500">
                  選択した記録ごとに理由と操作した担当者を残します。元の確認履歴も残ります。
                </p>
              </div>
              <label className="flex items-start gap-3 text-sm leading-7">
                <input
                  type="checkbox"
                  className="mt-2"
                  required
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>選択した確認記録を取り消し、上記の理由で再確認へ戻します。</span>
              </label>
              <Button type="submit" disabled={ids.length < 2}>
                選択した{ids.length}件を再確認へ戻す
              </Button>
            </fieldset>
          </form>
        </>
      )}
    </section>
  );
}
