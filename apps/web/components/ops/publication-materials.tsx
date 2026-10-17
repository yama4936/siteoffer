"use client";
import type { listPublicationMaterials, PublicationMaterialItem } from "@siteoffer/core";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  confirmPublicationMaterialAction,
  getPublicationMaterialAction,
  refreshPublicationMaterialsAction,
  reopenPublicationMaterialAction,
} from "@/app/publication-material-actions";
import { useMaterialNavigationGuard } from "@/components/materials/shared";
import { MaterialUpdatesStatus, useMaterialUpdates } from "@/components/materials/updates";
import { Button } from "@/components/ui/button";
import { controlClass, Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { fmtDate } from "@/lib/ops/format";
import { PublicationMaterialBatch } from "./publication-material-batch";

type Listing = Awaited<ReturnType<typeof listPublicationMaterials>>;
type Filter = NonNullable<Parameters<typeof listPublicationMaterials>[2]>;
type Pending =
  | { kind: "confirm"; input: Parameters<typeof confirmPublicationMaterialAction>[0] }
  | { kind: "reopen"; input: Parameters<typeof reopenPublicationMaterialAction>[0] };
const status = { pending: "対応が必要", resolved: "対応確認済み", clear: "素材の問題なし" };
export function PublicationMaterials({ initial, filter }: { initial: Listing; filter: Filter }) {
  const [listing, setListing] = useState(initial),
    [selected, setSelected] = useState<PublicationMaterialItem | null>(
      filter.deploymentId && initial.items[0]?.state === "pending" ? (initial.items[0] ?? null) : null,
    ),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Pending | null>(null),
    [message, setMessage] = useState("");
  const [note, setNote] = useState(""),
    [outcome, setOutcome] = useState(""),
    [replacement, setReplacement] = useState(""),
    [url, setUrl] = useState(filter.deploymentId ? (initial.items[0]?.url ?? "") : ""),
    [confirmed, setConfirmed] = useState(false);
  const [countsStale, setCountsStale] = useState(false);
  const [batchAnchor, setBatchAnchor] = useState<string | null>(null),
    [batchNote, setBatchNote] = useState("");
  const gate = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(() => refreshPublicationMaterialsAction(filter), [filter]);
  const updates = useMaterialUpdates({
    snapshot: listing,
    load,
    apply: setListing,
    editing: selected?.deploymentId ?? batchAnchor,
    paused: busy || pending !== null,
  });
  useEffect(() => {
    if (updates.checkedAt !== null) setCountsStale(false);
  }, [updates.checkedAt]);
  useMaterialNavigationGuard(selected !== null || pending !== null || batchAnchor !== null);
  function reset(item: PublicationMaterialItem | null, keepNote = false) {
    setSelected(item);
    if (!keepNote) setNote("");
    setOutcome("");
    setReplacement("");
    setUrl((previous) => item?.url ?? (keepNote ? previous : ""));
    setConfirmed(false);
  }
  function choose(item: PublicationMaterialItem) {
    if (gate.current || pending || batchAnchor) return;
    if (selected && !window.confirm("入力中の確認内容を破棄して、別の公開記録を開きますか？")) return;
    updates.invalidate();
    reset(item);
    setMessage("");
    requestAnimationFrame(() => heading.current?.focus());
  }
  async function refresh() {
    if (gate.current || pending || batchAnchor) return;
    gate.current = true;
    updates.invalidate();
    setBusy(true);
    try {
      if (selected) {
        const current = await getPublicationMaterialAction(selected.deploymentId);
        if (!current.ok) {
          setMessage(current.message);
          return;
        }
        reset(current.item, true);
        setMessage("最新状態を取得しました。メモを保持しています。対応内容と確認チェックを選び直してください。");
      }
      const r = await load();
      if (r.ok) {
        setListing(r.result);
        setCountsStale(false);
        updates.acknowledge();
        if (!selected) setMessage("一覧を更新しました");
      } else setMessage(r.message);
    } catch {
      setMessage("最新状態を取得できませんでした。入力は保持しています。再度更新してください。");
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  async function send(operation: Pending) {
    if (gate.current) return;
    gate.current = true;
    updates.invalidate();
    setBusy(true);
    setPending(operation);
    setMessage("");
    try {
      const r =
        operation.kind === "confirm"
          ? await confirmPublicationMaterialAction(operation.input)
          : await reopenPublicationMaterialAction(operation.input);
      if (!r.ok) {
        setPending(null);
        setMessage(r.message);
        return;
      }
      setPending(null);
      reset(null);
      setMessage(
        `${r.replayed ? "受付済みの結果を確認しました" : "確認記録を保存しました"}。現在の状態：${status[r.item.state]}。外部サイトの公開・停止はこの操作では行いません。`,
      );
      setListing((previous) => {
        const listed = previous.items.some((x) => x.deploymentId === r.item.deploymentId);
        // The open record can leave this filtered page after a manual refresh.
        const old = previous.items.find((x) => x.deploymentId === r.item.deploymentId) ?? selected;
        const matches = (item: PublicationMaterialItem) =>
          filter.mode === "all" || item.state === (filter.mode ?? "pending");
        const visible = matches(r.item);
        const items = previous.items.map((x) => (x.deploymentId === r.item.deploymentId ? r.item : x)).filter(matches);
        if (!listed && visible) items.unshift(r.item);
        return {
          ...previous,
          total: previous.total - (old && matches(old) ? 1 : 0) + (visible ? 1 : 0),
          pending: previous.pending - (old?.state === "pending" ? 1 : 0) + (r.item.state === "pending" ? 1 : 0),
          resolved: previous.resolved - (old?.state === "resolved" ? 1 : 0) + (r.item.state === "resolved" ? 1 : 0),
          items: items.slice(0, 20),
        };
      });
      try {
        const fresh = await load();
        if (fresh.ok) {
          setListing(fresh.result);
          updates.acknowledge();
        } else setMessage((v) => `${v} 一覧の再取得はできませんでした。`);
      } catch {
        setMessage((v) => `${v} 一覧の再取得はできませんでした。`);
      }
    } catch {
      setMessage("保存結果を確認できません。同じ受付で再試行してください。入力内容は固定して保持しています。");
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  function openBatch(item: PublicationMaterialItem) {
    if (gate.current || pending || batchAnchor) return;
    const same = selected?.deploymentId === item.deploymentId;
    if (selected && !same && note && !window.confirm("入力中のメモを破棄して別の公開先を開きますか？")) return;
    updates.invalidate();
    setBatchNote(same ? note : "");
    reset(null);
    setBatchAnchor(item.deploymentId);
    setMessage("");
  }
  function batchSaved(items: PublicationMaterialItem[], replayed: boolean) {
    updates.invalidate();
    setBusy(true);
    setBatchAnchor(null);
    setMessage(
      `${replayed ? "受付済みの結果を確認しました" : "まとめて確認記録を保存しました"}。対象${items.length}件の現在の状態：確認済み${items.filter((r) => r.state === "resolved").length}件、対応が必要${items.filter((r) => r.state === "pending").length}件。外部サイトの公開・停止はこの操作では行いません。`,
    );
    setCountsStale(true);
    setListing((previous) => {
      const changed = new Map(items.map((r) => [r.deploymentId, r]));
      return {
        ...previous,
        items: previous.items
          .map((r) => changed.get(r.deploymentId) ?? r)
          .filter((r) => filter.mode === "all" || r.state === (filter.mode ?? "pending")),
      };
    });
    void load()
      .then((r) => {
        if (r.ok) {
          setListing(r.result);
          setCountsStale(false);
          updates.acknowledge();
        } else setMessage((v) => `${v} 一覧の再取得はできませんでした。一覧を更新してください。`);
      })
      .catch(() => setMessage((v) => `${v} 一覧の再取得はできませんでした。一覧を更新してください。`))
      .finally(() => setBusy(false));
  }
  const prefix = `/ops/publication-checks?${filter.companyId ? `company=${filter.companyId}&` : ""}${filter.deliveryId ? `delivery=${filter.deliveryId}&` : ""}`;
  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-3" aria-label="公開素材の確認件数">
        {[
          ["対応が必要", listing.pending],
          ["対応確認済み", listing.resolved],
          ["公開記録", listing.scanned],
        ].map(([label, count]) => (
          <div key={label} className="rounded-xl border bg-white px-5 py-4">
            <p className="text-sm text-slate-600">{label}</p>
            <strong className="text-2xl">
              {countsStale ? "更新待ち" : count}
              {!countsStale && <span className="ml-1 text-sm font-normal">件</span>}
            </strong>
          </div>
        ))}
      </section>
      {countsStale && (
        <p role="status" className="text-sm text-amber-800">
          件数は最新の取得待ちです。「一覧を更新」で確認できます。
        </p>
      )}
      {filter.deploymentId && (
        <p className="text-sm">
          選択した公開記録を表示しています。
          <Link
            href={`/ops/publication-checks${filter.deliveryId ? `?delivery=${filter.deliveryId}` : ""}`}
            className="ml-2 underline"
          >
            このサイトの公開記録に戻る
          </Link>
        </p>
      )}
      <nav aria-label="公開素材の確認状況" className="flex flex-wrap gap-2">
        {(
          [
            ["pending", "対応が必要"],
            ["resolved", "対応確認済み"],
            ["all", "すべて"],
          ] as const
        ).map(([mode, label]) => (
          <Link
            key={mode}
            href={`${prefix}mode=${mode}`}
            className={`rounded-lg border px-4 py-2 text-sm ${filter.mode === mode ? "bg-blue-600 text-white" : "bg-white"}`}
          >
            {label}
          </Link>
        ))}
        {(filter.companyId || filter.deliveryId || filter.deploymentId) && (
          <Link className="px-3 py-2 text-sm underline" href="/ops/publication-checks">
            絞り込みを解除
          </Link>
        )}
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <MaterialUpdatesStatus updates={updates} editing={selected !== null} pending={busy || pending !== null} />
        <Button
          variant="outline"
          disabled={busy || pending !== null || batchAnchor !== null}
          onClick={() => void refresh()}
        >
          {selected ? "メモを残して最新状態を取得" : "一覧を更新"}
        </Button>
      </div>
      {message && (
        <p role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm leading-7">
          {message}
        </p>
      )}
      {pending && !busy && <Button onClick={() => void send(pending)}>同じ受付で再試行</Button>}
      {batchAnchor && (
        <PublicationMaterialBatch
          deploymentId={batchAnchor}
          initialNote={batchNote}
          onClose={() => {
            updates.invalidate();
            setBatchAnchor(null);
          }}
          onSaved={batchSaved}
        />
      )}
      {selected && (
        <section className="rounded-xl border-2 border-blue-200 bg-white p-5" aria-label="公開後の対応を記録">
          <h2 tabIndex={-1} ref={heading} className="text-lg font-semibold">
            {selected.companyName}・第{selected.version}版の対応
          </h2>
          <p className="mt-2 text-sm leading-7">
            {selected.state === "resolved"
              ? "確認内容に誤りがある場合、理由を残して再確認へ戻せます。"
              : "実際の公開サイトを確認してから記録してください。新しい公開記録を作っただけでは、この記録は完了になりません。"}
          </p>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || pending) return;
              const requestId = crypto.randomUUID();
              if (selected.state === "resolved")
                void send({
                  kind: "reopen",
                  input: {
                    deploymentId: selected.deploymentId,
                    revision: selected.check!.revision,
                    requestId,
                    note,
                    confirmed,
                  },
                });
              else
                void send({
                  kind: "confirm",
                  input: {
                    deploymentId: selected.deploymentId,
                    revision: selected.check?.revision ?? 0,
                    fingerprint: selected.fingerprint,
                    requestId,
                    outcome: outcome as "replaced" | "site_offline",
                    replacementId: outcome === "replaced" ? replacement : null,
                    observedUrl: url,
                    note,
                    confirmed,
                  },
                });
            }}
          >
            <fieldset disabled={busy || pending !== null || batchAnchor !== null} className="space-y-4">
              {selected.state === "pending" && (
                <>
                  <label htmlFor="publication-outcome" className="block space-y-2 text-sm">
                    <span id="publication-outcome-label">確認した対応</span>
                    <NativeSelect
                      id="publication-outcome"
                      aria-labelledby="publication-outcome-label"
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
                  </label>
                  {outcome === "replaced" && (
                    <label htmlFor="publication-replacement" className="block space-y-2 text-sm">
                      <span id="publication-replacement-label">同じ公開先・環境の新しい公開記録</span>
                      <NativeSelect
                        id="publication-replacement"
                        aria-labelledby="publication-replacement-label"
                        required
                        value={replacement}
                        onChange={(e) => {
                          setReplacement(e.target.value);
                          setConfirmed(false);
                        }}
                      >
                        <option value="">選択してください</option>
                        {selected.replacements.map((r) => (
                          <option key={r.deploymentId} value={r.deploymentId}>
                            第{r.version}版 · {r.url}
                          </option>
                        ))}
                      </NativeSelect>
                      {selected.replacements.length === 0 && (
                        <span className="block leading-6 text-amber-800">
                          選べる公開記録がありません。「制作・公開」で修正・承認・公開記録を進めてから、最新状態を取得してください。
                        </span>
                      )}
                    </label>
                  )}
                  <label htmlFor="publication-url" className="block space-y-2 text-sm">
                    <span>実際に確認した公開URL</span>
                    <Input
                      id="publication-url"
                      type="url"
                      required
                      maxLength={2000}
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setConfirmed(false);
                      }}
                    />
                  </label>
                </>
              )}
              <label className="block space-y-2 text-sm">
                <span id="publication-note-label">
                  {selected.state === "resolved" ? "再確認へ戻す理由" : "確認メモ"}
                </span>
                <textarea
                  aria-labelledby="publication-note-label"
                  className={`${controlClass} min-h-28`}
                  required
                  minLength={10}
                  maxLength={2000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="どの公開先で、何を確認したかを記録してください。"
                />
              </label>
              {selected.state !== "clear" && (
                <label className="flex items-start gap-3 text-sm leading-7">
                  <input
                    type="checkbox"
                    required
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-2"
                  />
                  <span>
                    {selected.state === "resolved"
                      ? "上記の理由で、対応の再確認が必要です。"
                      : "元の公開先で実際の置き換え、またはサイト全体の公開停止を確認しました。"}
                  </span>
                </label>
              )}
              <div className="flex flex-wrap gap-3">
                {selected.state !== "clear" && (
                  <Button type="submit">
                    {selected.state === "resolved" ? "再確認へ戻す" : "対応を確認済みにする"}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (note && !window.confirm("未送信のメモを破棄して閉じますか？")) return;
                    updates.invalidate();
                    reset(null);
                  }}
                >
                  閉じる
                </Button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <div className="space-y-4">
        {listing.items.map((item) => (
          <article
            key={item.deploymentId}
            id={`publication-${item.deploymentId}`}
            data-publication={item.deploymentId}
            className="rounded-xl border bg-white p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{item.companyName}</h2>
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${item.state === "pending" ? "bg-amber-100 text-amber-900" : item.state === "resolved" ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-600"}`}
              >
                {status[item.state]}
              </span>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              第{item.version}版 · {item.environment} · 公開記録 {fmtDate(item.createdAt)}
            </p>
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block break-all text-sm text-blue-700 underline"
              >
                {item.url}（別タブ）
              </a>
            ) : (
              <p className="mt-2 text-sm text-amber-800">公開URLの記録がありません。実際の公開先を確認してください。</p>
            )}
            {item.issues.length > 0 && (
              <ul
                aria-label={item.state === "resolved" ? "対応確認済みの対象素材" : "確認が必要な素材"}
                className="my-4 space-y-2 rounded-lg bg-slate-50 p-4 text-sm leading-6"
              >
                {item.issues.map((issue) => (
                  <li key={issue.assetId ?? "snapshot"}>
                    <strong>{issue.label}</strong>：{issue.reason}
                  </li>
                ))}
              </ul>
            )}
            {item.check && (
              <div className="my-4 rounded-lg bg-slate-50 p-4 text-sm leading-7">
                <p>
                  {item.check.revokedAt ? "以前の対応確認" : "対応確認"}：
                  {item.check.outcome === "replaced" ? "新しい承認版へ置き換え" : "元サイト全体の公開停止"} ·{" "}
                  {item.check.checkedByName} · {fmtDate(item.check.checkedAt)}
                </p>
                <p className="whitespace-pre-wrap break-words">{item.check.note}</p>
                <p className="break-all">確認先：{item.check.observedUrl}</p>
                {item.check.revokedAt && (
                  <p className="whitespace-pre-wrap break-words">再確認へ戻した理由：{item.check.revocationNote}</p>
                )}
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-4">
              {item.state !== "clear" && (
                <Button
                  variant={item.state === "pending" ? "default" : "outline"}
                  disabled={busy || pending !== null || batchAnchor !== null}
                  onClick={() => choose(item)}
                >
                  {item.state === "pending" ? "対応を記録" : "確認をやり直す"}
                </Button>
              )}
              {item.state === "pending" && item.url && item.relatedPending > 1 && (
                <Button
                  variant="outline"
                  disabled={busy || pending !== null || batchAnchor !== null}
                  onClick={() => openBatch(item)}
                >
                  同じ公開先をまとめて確認
                </Button>
              )}
              <Link className="text-sm text-blue-700 underline" href={`/ops/delivery?focus=${item.deliveryId}`}>
                制作・公開で修正を進める
              </Link>
              <Link className="text-sm text-blue-700 underline" href={`/ops/companies/${item.companyId}#image-assets`}>
                画像素材台帳を確認
              </Link>
            </div>
          </article>
        ))}
      </div>
      {!listing.items.length && (
        <p className="rounded-xl border bg-white p-8 text-center text-sm text-slate-600">
          {listing.total
            ? "このページには記録がありません。前のページへ戻ってください。"
            : filter.mode === "pending"
              ? "対応が必要な公開記録はありません。外部サイトの状態を自動検証した結果ではありません。"
              : "該当する公開記録はありません。"}
        </p>
      )}
      <nav aria-label="公開記録のページ" className="flex items-center gap-4 text-sm">
        {(filter.page ?? 0) > 0 && (
          <Link href={`${prefix}mode=${filter.mode}&page=${(filter.page ?? 0) - 1}`} className="underline">
            前の20件
          </Link>
        )}
        <span>{countsStale ? "件数は再取得待ち" : `${listing.total}件`}</span>
        {((filter.page ?? 0) + 1) * 20 < listing.total && (
          <Link href={`${prefix}mode=${filter.mode}&page=${(filter.page ?? 0) + 1}`} className="underline">
            次の20件
          </Link>
        )}
      </nav>
    </div>
  );
}
