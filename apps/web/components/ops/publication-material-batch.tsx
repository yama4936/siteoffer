"use client";
import type { getPublicationMaterialBatch, PublicationMaterialItem } from "@siteoffer/core";
import { useEffect, useRef, useState } from "react";
import {
  confirmPublicationMaterialBatchAction,
  getPublicationMaterialBatchAction,
} from "@/app/publication-material-actions";
import { Button } from "@/components/ui/button";
import { controlClass, Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { fmtDate } from "@/lib/ops/format";

type Preview = Awaited<ReturnType<typeof getPublicationMaterialBatch>>;
type Payload = Parameters<typeof confirmPublicationMaterialBatchAction>[0];
export function PublicationMaterialBatch({
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
    [outcome, setOutcome] = useState(""),
    [replacement, setReplacement] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const gate = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let active = true;
    heading.current?.focus();
    void getPublicationMaterialBatchAction(deploymentId)
      .then((r) => {
        if (!active) return;
        if (r.ok) setPreview(r.preview);
        else setMessage(r.message);
      })
      .catch(() => {
        if (active) setMessage("対象を取得できませんでした。再度更新してください。");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [deploymentId]);
  async function refresh() {
    if (gate.current || pending) return;
    gate.current = true;
    setBusy(true);
    try {
      const r = await getPublicationMaterialBatchAction(deploymentId);
      if (r.ok) {
        setPreview(r.preview);
        setIds([]);
        setOutcome("");
        setReplacement("");
        setConfirmed(false);
        setMessage("最新状態を取得しました。メモを保持しています。対象と対応内容を選び直してください。");
      } else setMessage(r.message);
    } catch {
      setMessage("対象を取得できませんでした。入力は保持しています。");
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  async function send(input: Payload) {
    if (gate.current) return;
    gate.current = true;
    setPending(input);
    setBusy(true);
    setMessage("");
    try {
      const r = await confirmPublicationMaterialBatchAction(input);
      if (!r.ok) {
        setPending(null);
        setMessage(r.message);
        return;
      }
      setPending(null);
      onSaved(r.items, r.replayed);
    } catch {
      setMessage("保存結果を確認できません。同じ受付で再試行してください。選択内容とメモを固定して保持しています。");
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  const selected = preview?.items.filter((r) => ids.includes(r.deploymentId)) ?? [];
  const replacements =
    selected[0]?.replacements.filter((r) =>
      selected.every((item) => item.replacements.some((candidate) => candidate.deploymentId === r.deploymentId)),
    ) ?? [];
  function select(next: string[]) {
    setIds(next);
    setReplacement("");
    setConfirmed(false);
  }
  return (
    <section
      aria-label="同じ公開先の旧版をまとめて確認"
      className="rounded-xl border-2 border-blue-200 bg-white p-5 space-y-4"
    >
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">
        同じ公開先の旧版をまとめて確認
      </h2>
      <p className="text-sm leading-7">
        対象と実際の公開先を確認し、同じ対応内容を選択した記録に保存します。一件でも状態が変わっていれば、全件を保存せず再確認を求めます。
      </p>
      {busy && !preview && <p role="status">対象を取得しています…</p>}
      {message && (
        <p role="status" className="rounded-lg bg-blue-50 p-4 text-sm leading-7">
          {message}
        </p>
      )}
      {pending && !busy && <Button onClick={() => void send(pending)}>同じ受付で再試行</Button>}
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={busy || pending !== null} onClick={() => void refresh()}>
          メモを残して対象を更新
        </Button>
        <Button
          variant="outline"
          disabled={busy || pending !== null}
          onClick={() => {
            if (note && !window.confirm("未送信のメモを破棄して閉じますか？")) return;
            onClose();
          }}
        >
          まとめ確認を閉じる
        </Button>
      </div>
      {preview && (
        <>
          <div className="rounded-lg bg-slate-50 p-4 text-sm leading-7">
            <strong>{preview.companyName}</strong>
            <p>環境：{preview.environment}</p>
            <a href={preview.url} target="_blank" rel="noreferrer" className="break-all text-blue-700 underline">
              {preview.url}（別タブ）
            </a>
          </div>
          <p className="text-sm leading-7">
            同じ公開先の未対応は{preview.total}件です。今回選択できる{preview.items.length}
            件を表示しています。1回の保存は{preview.limit}件までです。
            {preview.total > preview.limit && "残りは保存後に一覧へ戻り、別の記録から続けて確認できます。"}
          </p>
          {preview.items.length < 2 ? (
            <p className="text-sm text-slate-600">
              まとめて確認する対象が2件未満です。一覧に戻って個別に確認してください。
            </p>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (busy || pending) return;
                if (selected.length < 2) {
                  setMessage("まとめて確認する記録を2件以上選択してください。");
                  return;
                }
                void send({
                  deploymentId,
                  scope: preview.scope,
                  items: selected.map((r) => ({
                    deploymentId: r.deploymentId,
                    revision: r.revision,
                    fingerprint: r.fingerprint,
                  })),
                  requestId: crypto.randomUUID(),
                  outcome: outcome as "replaced" | "site_offline",
                  replacementId: outcome === "replaced" ? replacement : null,
                  observedUrl: preview.url,
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
                    onClick={() => select(preview.items.map((r) => r.deploymentId))}
                  >
                    表示中の{preview.items.length}件をすべて選ぶ
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => select([])}>
                    選択を解除
                  </Button>
                  <span aria-live="polite" className="text-sm">
                    選択 {ids.length}件
                  </span>
                </div>
                <fieldset className="max-h-80 overflow-y-auto rounded-lg border">
                  <legend className="sr-only">確認する公開記録</legend>
                  {preview.items.map((r) => (
                    <label
                      key={r.deploymentId}
                      className="flex cursor-pointer items-start gap-3 border-b p-4 last:border-0"
                    >
                      <input
                        className="mt-1.5 shrink-0"
                        type="checkbox"
                        checked={ids.includes(r.deploymentId)}
                        onChange={(e) =>
                          select(
                            e.target.checked ? [...ids, r.deploymentId] : ids.filter((id) => id !== r.deploymentId),
                          )
                        }
                      />
                      <span className="min-w-0 text-sm leading-7">
                        <strong>第{r.version}版</strong>
                        <span className="ml-3 text-xs text-slate-500">
                          {fmtDate(r.createdAt)} · 記録 {r.deploymentId.slice(0, 8)}
                        </span>
                        {r.issues.map((issue) => (
                          <span key={issue.assetId ?? "snapshot"} className="block break-words text-xs text-slate-600">
                            {issue.label}：{issue.reason}
                          </span>
                        ))}
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="space-y-2">
                  <label htmlFor="batch-outcome" className="text-sm font-medium">
                    全ての選択対象で確認した対応
                  </label>
                  <NativeSelect
                    id="batch-outcome"
                    required
                    value={outcome}
                    onChange={(e) => {
                      setOutcome(e.target.value);
                      setReplacement("");
                      setConfirmed(false);
                    }}
                  >
                    <option value="">選択してください</option>
                    <option value="replaced">新しい承認版への置き換えを確認</option>
                    <option value="site_offline">元のサイト全体の公開停止を確認</option>
                  </NativeSelect>
                </div>
                {outcome === "replaced" && (
                  <div className="space-y-2">
                    <label htmlFor="batch-replacement" className="text-sm font-medium">
                      全ての選択対象を置き換えた公開記録
                    </label>
                    <NativeSelect
                      id="batch-replacement"
                      required
                      value={replacement}
                      onChange={(e) => {
                        setReplacement(e.target.value);
                        setConfirmed(false);
                      }}
                    >
                      <option value="">選択してください</option>
                      {replacements.map((r) => (
                        <option key={r.deploymentId} value={r.deploymentId}>
                          第{r.version}版 · {r.url}
                        </option>
                      ))}
                    </NativeSelect>
                    {!replacements.length && (
                      <p className="text-sm leading-7 text-amber-800">
                        選択した全ての旧版を置き換えられる新しい承認版の記録がありません。対象の選択、素材の許可、制作・公開の記録を確認してください。
                      </p>
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  <label htmlFor="batch-url" className="text-sm font-medium">
                    実際に確認した公開URL
                  </label>
                  <Input id="batch-url" readOnly value={preview.url} />
                </div>
                <div className="space-y-2">
                  <label htmlFor="batch-note" className="text-sm font-medium">
                    共有の確認メモ
                  </label>
                  <textarea
                    id="batch-note"
                    className={`${controlClass} min-h-28`}
                    required
                    minLength={10}
                    maxLength={2000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <p className="text-xs leading-6 text-slate-500">
                    選択した記録ごとに、同じメモと確認者・確認日時を残します。
                  </p>
                </div>
                <label className="flex items-start gap-3 text-sm leading-7">
                  <input
                    className="mt-2"
                    type="checkbox"
                    required
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>
                    選択した全ての旧版について、この公開先で実際の置き換え、またはサイト全体の公開停止を確認しました。
                  </span>
                </label>
                <Button type="submit" disabled={ids.length < 2}>
                  選択した{ids.length}件を確認済みにする
                </Button>
              </fieldset>
            </form>
          )}
        </>
      )}
    </section>
  );
}
