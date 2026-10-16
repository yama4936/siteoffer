"use client";
import type { ImageSubmissionView } from "@siteoffer/core";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import {
  compareImageSubmissionAction,
  refreshImageSubmissionsAction,
  reviewCustomerImageAction,
} from "@/app/image-submission-actions";
import { Button } from "@/components/ui/button";
import { controlClass, Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { fmtDate } from "@/lib/ops/format";
import { OperatorMaterialComparison, useComparisonFocus } from "./comparison";
import { materialStatus, rightsLabels, useMaterialNavigationGuard } from "./shared";
import { MaterialUpdatesStatus, useMaterialUpdates } from "./updates";

type Item = ImageSubmissionView & { companyName: string; submitterName: string };
type Listing = { total: number; items: Item[] };
export function OperatorMaterials({
  initial,
  companyId,
  page,
  pendingOnly,
}: {
  initial: Listing;
  companyId?: string;
  page: number;
  pendingOnly: boolean;
}) {
  const [listing, setListing] = useState(initial),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Parameters<typeof reviewCustomerImageAction>[0] | null>(null),
    [message, setMessage] = useState(""),
    [dirty, setDirty] = useState(false),
    [savedCompany, setSavedCompany] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [comparison, setComparison] = useState<{
    before: ImageSubmissionView;
    latest: ImageSubmissionView;
    note: string;
  } | null>(null);
  const [resumed, setResumed] = useState<{ assetId: string; note: string } | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  useComparisonFocus(formRef, comparison !== null, formVersion, "decision");
  // Background reads detect changes but preserve the exact version being reviewed.
  const loadUpdates = useCallback(
    () => refreshImageSubmissionsAction({ companyId, page, pendingOnly }),
    [companyId, page, pendingOnly],
  );
  const updates = useMaterialUpdates({
    snapshot: listing,
    load: loadUpdates,
    apply: setListing,
    editing: selected,
    paused: busy || pending !== null,
  });
  useMaterialNavigationGuard(dirty || pending !== null);
  async function refresh() {
    if (busy || pending) return;
    if (dirty && !window.confirm("入力中の確認内容を破棄して一覧を更新しますか？")) return;
    updates.invalidate();
    setBusy(true);
    try {
      const r = await refreshImageSubmissionsAction({ companyId, page, pendingOnly });
      if (r.ok) {
        setListing(r.result);
        updates.acknowledge();
        setSelected(null);
        setResumed(null);
        setDirty(false);
        setMessage("一覧を更新しました");
      } else setMessage(r.message);
    } catch {
      setMessage("一覧を取得できませんでした。再度更新してください。");
    } finally {
      setBusy(false);
    }
  }
  async function review(input: Parameters<typeof reviewCustomerImageAction>[0]) {
    if (busy) return;
    updates.invalidate();
    setBusy(true);
    setPending(input);
    setMessage("");
    setSavedCompany(null);
    try {
      const r = await reviewCustomerImageAction(input);
      if (!r.ok) {
        setMessage(r.message);
        setPending(null);
        return;
      }
      setPending(null);
      setSelected(null);
      setResumed(null);
      setDirty(false);
      setMessage(
        r.replayed
          ? `受付済みの結果を確認しました。現在の状態：${materialStatus[r.item.status]}`
          : input.decision === "accepted"
            ? "画像と利用許可を確認しました。画像素材台帳で配置先を指定できます。"
            : "説明の追加を依頼しました。顧客の素材一覧に確認内容が表示されます。",
      );
      if (r.item.status === "accepted") setSavedCompany(input.companyId);
      setListing((previous) => ({
        total:
          previous.total -
          (pendingOnly && r.item.status !== "pending" && previous.items.some((item) => item.assetId === r.item.assetId)
            ? 1
            : 0),
        items: previous.items
          .map((item) => (item.assetId === r.item.assetId ? { ...item, ...r.item } : item))
          .filter((item) => !pendingOnly || item.status === "pending"),
      }));
      try {
        const fresh = await refreshImageSubmissionsAction({ companyId, page, pendingOnly });
        if (fresh.ok) {
          setListing(fresh.result);
          updates.acknowledge();
        } else setMessage((value) => `${value} 一覧の再取得はできませんでした。一覧を更新してください。`);
      } catch {
        setMessage((value) => `${value} 一覧の再取得はできませんでした。一覧を更新してください。`);
      }
    } catch {
      setMessage("確認結果を保存できたか確認できません。同じ受付で再試行してください。");
    } finally {
      setBusy(false);
    }
  }
  async function compare(item: ImageSubmissionView) {
    if (busy || pending || comparison || !formRef.current) return;
    const note = String(new FormData(formRef.current).get("note") ?? "");
    updates.invalidate();
    setBusy(true);
    try {
      const result = await compareImageSubmissionAction(item.companyId, item.assetId);
      if (result.ok) setComparison({ before: item, latest: result.item, note });
      else setMessage(result.message);
    } catch {
      setMessage("最新の内容を取得できませんでした。確認メモは残っています。再試行してください。");
    } finally {
      setBusy(false);
    }
  }
  function resumeComparison() {
    if (!comparison) return;
    updates.invalidate();
    setListing((previous) => ({
      ...previous,
      items: previous.items.map((item) =>
        item.assetId === comparison.latest.assetId ? { ...item, ...comparison.latest } : item,
      ),
    }));
    setResumed({ assetId: comparison.latest.assetId, note: comparison.note });
    setFormVersion((version) => version + 1);
    setDirty(true);
    setComparison(null);
    setMessage("確認メモを引き継ぎました。まだ保存していません。確認結果・用途・確認チェックを選び直してください。");
  }
  function finishComparison() {
    if (!comparison || !window.confirm("未保存の確認メモを破棄して最新状況を表示しますか？")) return;
    updates.invalidate();
    setListing((previous) => ({
      total: previous.total - (pendingOnly && comparison.latest.status !== "pending" ? 1 : 0),
      items: previous.items
        .map((item) => (item.assetId === comparison.latest.assetId ? { ...item, ...comparison.latest } : item))
        .filter((item) => !pendingOnly || item.status === "pending"),
    }));
    setComparison(null);
    setResumed(null);
    setSelected(null);
    setDirty(false);
  }
  const locked = busy || pending !== null || comparison !== null,
    prefix = `/ops/materials?${companyId ? `company=${companyId}&` : ""}all=${pendingOnly ? 0 : 1}&`;
  return (
    <div className="space-y-5">
      <MaterialUpdatesStatus
        updates={updates}
        editing={selected !== null}
        pending={busy || pending !== null}
        canCompare={selected !== null}
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {listing.total}件 · {page + 1}ページ目
        </p>
        <Button variant="outline" disabled={locked} onClick={() => void refresh()}>
          一覧を更新
        </Button>
      </div>
      {message && (
        <div role="status" className="rounded-xl border bg-white p-4 text-sm leading-7">
          {message}
          {pending && !busy && (
            <Button className="mt-3 block" onClick={() => void review(pending)}>
              同じ受付で再試行
            </Button>
          )}
          {savedCompany && (
            <Link href={`/ops/companies/${savedCompany}#image-assets`} className="mt-3 block underline">
              画像素材台帳で配置先を確認
            </Link>
          )}
        </div>
      )}
      {listing.items.length === 0 && (
        <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
          {pendingOnly ? "確認待ちの素材はありません" : "該当する素材はありません"}
        </div>
      )}
      {listing.items.map((item) => (
        <article key={item.assetId} className="min-w-0 rounded-xl border bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Link href={`/ops/companies/${item.companyId}`} className="text-sm text-blue-700">
                {item.companyName}
              </Link>
              <h2 className="mt-1 break-all font-semibold text-lg">{item.label}</h2>
              <p className="mt-1 text-xs text-slate-500">
                提出者：{item.submitterName} · {fmtDate(item.submittedAt)}
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs">{materialStatus[item.status]}</span>
          </div>
          <div className="mt-5 grid gap-5 md:grid-cols-[minmax(160px,1fr)_2fr]">
            <a
              href={`/ops/image-assets/${item.assetId}/file`}
              target="_blank"
              rel="noreferrer"
              aria-label={`${item.label}の画像を開く`}
            >
              {/* biome-ignore lint/performance/noImgElement: Private authenticated image. */}
              <img
                src={`/ops/image-assets/${item.assetId}/file`}
                alt={item.label}
                loading="lazy"
                className="h-52 w-full rounded-lg border bg-slate-50 object-contain"
              />
            </a>
            <div>
              <p className="text-sm font-medium">{rightsLabels[item.rightsBasis]}</p>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7">{item.rightsNote}</p>
              <p className="mt-3 text-sm">
                顧客が許可した用途：
                {[item.requestedDemo && "営業デモ", item.requestedProduction && "本番サイト"]
                  .filter(Boolean)
                  .join("・")}
              </p>
              <p className="mt-3 text-xs text-slate-500">
                {item.width}×{item.height} · {Math.ceil(item.byteSize / 1024)}KB
              </p>
              {item.reviewNote && (
                <p className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm leading-7">
                  前回の確認：{item.reviewNote}
                </p>
              )}
            </div>
          </div>
          {item.status === "pending" && (
            <Button
              variant="outline"
              disabled={locked}
              className="mt-5"
              onClick={() => {
                if (dirty && !window.confirm("入力中の確認内容を破棄しますか？")) return;
                updates.invalidate();
                setSelected(selected === item.assetId ? null : item.assetId);
                setResumed(null);
                setDirty(false);
              }}
            >
              {selected === item.assetId ? "確認の入力を閉じる" : "画像・利用許可を確認する"}
            </Button>
          )}
          {selected === item.assetId && item.status === "pending" && (
            <form
              ref={formRef}
              hidden={comparison?.before.assetId === item.assetId}
              key={`${item.revision}:${formVersion}`}
              className="mt-5 border-t pt-5"
              onChange={() => setDirty(true)}
              onSubmit={(e) => {
                e.preventDefault();
                if (locked) return;
                const fd = new FormData(e.currentTarget);
                void review({
                  companyId: item.companyId,
                  assetId: item.assetId,
                  revision: item.revision,
                  requestId: crypto.randomUUID(),
                  decision: String(fd.get("decision")) as "accepted" | "needs_changes",
                  note: String(fd.get("note") ?? ""),
                  allowDemo: fd.get("allowDemo") === "on",
                  allowProduction: fd.get("allowProduction") === "on",
                  confirmed: fd.get("confirmed") === "on",
                });
              }}
            >
              <fieldset disabled={locked} className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor={`decision-${item.assetId}`} className="text-sm font-medium">
                    確認結果
                  </label>
                  <NativeSelect name="decision" id={`decision-${item.assetId}`} required defaultValue="">
                    <option value="" disabled>
                      選択してください
                    </option>
                    <option value="accepted">画像と利用許可を確認した</option>
                    <option value="needs_changes">説明の追加・修正を依頼する</option>
                  </NativeSelect>
                </div>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">確認済みの用途（採用する場合）</legend>
                  <label htmlFor={`demo-${item.assetId}`} className="flex gap-2 text-sm">
                    <Input
                      id={`demo-${item.assetId}`}
                      type="checkbox"
                      name="allowDemo"
                      disabled={!item.requestedDemo}
                      defaultChecked={resumed?.assetId === item.assetId ? false : item.requestedDemo}
                    />
                    営業デモ {!item.requestedDemo && "（顧客の許可なし）"}
                  </label>
                  <label htmlFor={`production-${item.assetId}`} className="flex gap-2 text-sm">
                    <Input
                      id={`production-${item.assetId}`}
                      type="checkbox"
                      name="allowProduction"
                      disabled={!item.requestedProduction}
                      defaultChecked={resumed?.assetId === item.assetId ? false : item.requestedProduction}
                    />
                    本番サイト {!item.requestedProduction && "（顧客の許可なし）"}
                  </label>
                </fieldset>
                <div className="space-y-2">
                  <label htmlFor={`note-${item.assetId}`} className="text-sm font-medium">
                    顧客に伝える確認内容
                  </label>
                  <textarea
                    id={`note-${item.assetId}`}
                    name="note"
                    defaultValue={resumed?.assetId === item.assetId ? resumed.note : ""}
                    required
                    minLength={5}
                    maxLength={2000}
                    className={`${controlClass} min-h-24`}
                    placeholder="確認した許可の内容、または追加で必要な説明を記入"
                  />
                </div>
                <label htmlFor={`confirm-${item.assetId}`} className="flex items-start gap-2 text-sm leading-6">
                  <Input id={`confirm-${item.assetId}`} name="confirmed" type="checkbox" required className="mt-1" />
                  実際の画像と申告内容を確認しました。採用する場合は、その用途で利用できることを確認しました。
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit">確認結果を保存</Button>
                  <Button type="button" data-material-compare variant="outline" onClick={() => void compare(item)}>
                    最新の内容と比較
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
          {comparison?.before.assetId === item.assetId && (
            <OperatorMaterialComparison
              before={comparison.before}
              latest={comparison.latest}
              note={comparison.note}
              onResume={resumeComparison}
              onClose={() => setComparison(null)}
              onFinish={finishComparison}
            />
          )}
        </article>
      ))}
      <nav className="flex justify-between text-sm" aria-label="顧客素材のページ">
        {page > 0 ? <Link href={`${prefix}page=${page - 1}`}>前の20件</Link> : <span />}
        {(page + 1) * 20 < listing.total && <Link href={`${prefix}page=${page + 1}`}>次の20件</Link>}
      </nav>
    </div>
  );
}
