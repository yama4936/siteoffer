"use client";
import type { CustomerImageDetails, ImageSubmissionView } from "@siteoffer/core";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  compareImageSubmissionAction,
  refreshCustomerImagesAction,
  reviseCustomerImageAction,
  submitCustomerImageAction,
  withdrawCustomerImageAction,
} from "@/app/image-submission-actions";
import { Button } from "@/components/ui/button";
import { fmtDate } from "@/lib/ops/format";
import { CustomerMaterialComparison, useComparisonFocus } from "./comparison";
import type { MaterialDraft } from "./merge";
import { MaterialDetailsFields, materialStatus, useMaterialNavigationGuard } from "./shared";
import { MaterialUpdatesStatus, useMaterialUpdates } from "./updates";

type Listing = { total: number; items: ImageSubmissionView[] };
type Job =
  | { kind: "submit"; data: FormData }
  | { kind: "revise"; data: Parameters<typeof reviseCustomerImageAction>[0] }
  | { kind: "withdraw"; data: Parameters<typeof withdrawCustomerImageAction>[0] };
function fields(fd: FormData): CustomerImageDetails {
  return {
    label: String(fd.get("label") ?? ""),
    rightsBasis: String(fd.get("rightsBasis") ?? "") as CustomerImageDetails["rightsBasis"],
    rightsNote: String(fd.get("rightsNote") ?? ""),
    requestedDemo: fd.get("requestedDemo") === "on",
    requestedProduction: fd.get("requestedProduction") === "on",
    confirmed: fd.get("confirmed") === "on",
  };
}
export function CustomerMaterials({ companyId, page, initial }: { companyId: string; page: number; initial: Listing }) {
  const [listing, setListing] = useState(initial),
    [busy, setBusy] = useState(false),
    [job, setJob] = useState<Job | null>(null),
    [message, setMessage] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [dirty, setDirty] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [comparison, setComparison] = useState<{
    before: ImageSubmissionView;
    latest: ImageSubmissionView;
    draft: MaterialDraft;
  } | null>(null);
  const [resumed, setResumed] = useState<{ assetId: string; draft: MaterialDraft } | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  useComparisonFocus(formRef, comparison !== null, formVersion, "label");
  // Keep the editable snapshot stable across Server Action revalidation.
  // Route keys remount on scope changes; background reads preserve an open editor.
  const loadUpdates = useCallback(() => refreshCustomerImagesAction(companyId, page), [companyId, page]);
  const updates = useMaterialUpdates({
    snapshot: listing,
    load: loadUpdates,
    apply: setListing,
    editing,
    paused: busy || job !== null,
  });
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useMaterialNavigationGuard(dirty || file !== null || job !== null);
  function chooseEditor(next: string | null) {
    if ((dirty || file) && !window.confirm("未送信の入力を破棄して切り替えますか？")) return;
    updates.invalidate();
    formRef.current?.reset();
    setFile(null);
    setDirty(false);
    setEditing(next);
    setResumed(null);
  }
  async function refresh() {
    if (busy || job) return;
    if ((dirty || file) && !window.confirm("未送信の入力を破棄して確認状況を更新しますか？")) return;
    updates.invalidate();
    setBusy(true);
    try {
      const r = await refreshCustomerImagesAction(companyId, page);
      if (r.ok) {
        setListing(r.result);
        updates.acknowledge();
        setEditing(null);
        setResumed(null);
        setDirty(false);
        setFile(null);
        setMessage("一覧を更新しました");
      } else setMessage(r.message);
    } catch {
      setMessage("一覧を更新できませんでした。接続を確認して再試行してください。");
    } finally {
      setBusy(false);
    }
  }
  async function run(work: Job) {
    if (busy) return;
    updates.invalidate();
    setBusy(true);
    setJob(work);
    setMessage("");
    try {
      const r =
        work.kind === "submit"
          ? await submitCustomerImageAction(work.data)
          : work.kind === "revise"
            ? await reviseCustomerImageAction(work.data)
            : await withdrawCustomerImageAction(work.data);
      if (!r.ok) {
        setMessage(r.message);
        setJob(null);
        return;
      }
      setJob(null);
      setDirty(false);
      setEditing(null);
      setResumed(null);
      setFile(null);
      formRef.current?.reset();
      setMessage(
        work.kind === "withdraw"
          ? "画像を取り下げ、システム内の利用許可を停止しました。公開済みサイトへの反映は運営が確認します。"
          : r.replayed
            ? "受付済みの内容を確認しました。現在の確認状況をご覧ください。"
            : "提出内容を保存しました。運営の確認結果はこの一覧に表示されます。",
      );
      setListing((previous) => ({
        total:
          previous.total +
          (work.kind === "submit" && !previous.items.some((item) => item.assetId === r.item.assetId) ? 1 : 0),
        items:
          work.kind === "submit"
            ? [r.item, ...previous.items.filter((item) => item.assetId !== r.item.assetId)].slice(0, 20)
            : previous.items.map((item) => (item.assetId === r.item.assetId ? r.item : item)),
      }));
      try {
        const latest = await refreshCustomerImagesAction(companyId, page);
        if (latest.ok) {
          setListing(latest.result);
          updates.acknowledge();
        } else setMessage((value) => `${value} 一覧の再取得はできませんでした。確認状況を更新してください。`);
      } catch {
        setMessage((value) => `${value} 一覧の再取得はできませんでした。確認状況を更新してください。`);
      }
    } catch {
      setMessage("保存結果を確認できませんでした。入力を変えずに同じ受付で再試行してください。");
    } finally {
      setBusy(false);
    }
  }
  async function compare(item: ImageSubmissionView) {
    if (busy || job || comparison || !formRef.current) return;
    const draft = fields(new FormData(formRef.current));
    updates.invalidate();
    setBusy(true);
    try {
      const result = await compareImageSubmissionAction(companyId, item.assetId);
      if (result.ok) setComparison({ before: item, latest: result.item, draft });
      else setMessage(result.message);
    } catch {
      setMessage("最新の内容を取得できませんでした。入力は残っています。再試行してください。");
    } finally {
      setBusy(false);
    }
  }
  function resumeComparison(draft: MaterialDraft) {
    if (!comparison) return;
    updates.invalidate();
    setListing((previous) => ({
      ...previous,
      items: previous.items.map((item) => (item.assetId === comparison.latest.assetId ? comparison.latest : item)),
    }));
    setResumed({ assetId: comparison.latest.assetId, draft });
    setFormVersion((version) => version + 1);
    setDirty(true);
    setComparison(null);
    setMessage("入力を引き継ぎました。まだ送信していません。内容を確認してチェックを付け直してください。");
  }
  function finishComparison() {
    if (!comparison || !window.confirm("未保存の入力を破棄して最新状況を表示しますか？")) return;
    updates.invalidate();
    setListing((previous) => ({
      ...previous,
      items: previous.items.map((item) => (item.assetId === comparison.latest.assetId ? comparison.latest : item)),
    }));
    setComparison(null);
    setResumed(null);
    setEditing(null);
    setDirty(false);
  }
  const locked = busy || job !== null || comparison !== null;
  return (
    <div className="space-y-6">
      <MaterialUpdatesStatus
        updates={updates}
        editing={editing !== null}
        pending={busy || job !== null}
        canCompare={editing !== null && editing !== "new"}
      />
      {message && (
        <div role="status" className="rounded-xl border bg-white p-4 text-sm leading-7">
          {message}
          {job && !busy && (
            <Button className="mt-3 block" onClick={() => void run(job)}>
              同じ受付で再試行
            </Button>
          )}
        </div>
      )}
      {page === 0 && (
        <section className="rounded-xl border bg-white p-5">
          <Button variant="outline" disabled={locked} onClick={() => chooseEditor(editing === "new" ? null : "new")}>
            {editing === "new" ? "提出の入力を閉じる" : "写真・ロゴを提出する"}
          </Button>
          {editing === "new" && (
            <form
              ref={formRef}
              className="mt-5 space-y-5"
              onChange={() => setDirty(true)}
              onSubmit={(event) => {
                event.preventDefault();
                if (locked) return;
                if (!file) {
                  setMessage("画像を選択してください");
                  return;
                }
                const fd = new FormData(event.currentTarget);
                fd.set("image", file);
                fd.set("companyId", companyId);
                fd.set("requestId", crypto.randomUUID());
                void run({ kind: "submit", data: fd });
              }}
            >
              <fieldset disabled={locked} className="space-y-5">
                <div className="space-y-2">
                  <label htmlFor="material-file" className="text-sm font-medium">
                    画像ファイル
                  </label>
                  <input
                    id="material-file"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="block w-full text-sm"
                    onChange={(e) => {
                      const next = e.target.files?.[0];
                      if (
                        next &&
                        (next.size > 12 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(next.type))
                      ) {
                        e.target.value = "";
                        setFile(null);
                        setMessage("12MB以下のPNG・JPEG・WebP画像を選択してください");
                        return;
                      }
                      setFile(next ?? null);
                    }}
                  />
                  <p className="text-xs leading-6 text-slate-500">
                    PNG・JPEG・WebP /
                    12MB・2000万画素まで。位置情報などの付加情報を除き、最大2560pxの画像として保存します。
                  </p>
                </div>
                {preview && (
                  <div>
                    {/* biome-ignore lint/performance/noImgElement: Local file preview before authenticated upload. */}
                    <img
                      src={preview}
                      alt="提出する画像のプレビュー"
                      className="max-h-60 max-w-full rounded-lg border object-contain"
                    />
                  </div>
                )}
                <MaterialDetailsFields />
                <Button type="submit">{busy ? "保存しています…" : "画像と説明を提出"}</Button>
              </fieldset>
            </form>
          )}
        </section>
      )}
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">
          自分が提出した素材 <span className="text-sm font-normal text-slate-500">{listing.total}件</span>
        </h2>
        <Button variant="outline" disabled={locked} onClick={() => void refresh()}>
          確認状況を更新
        </Button>
      </div>
      {listing.items.length === 0 && (
        <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
          提出した素材はまだありません。
        </div>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {listing.items.map((item) => (
          <article key={item.assetId} className="min-w-0 rounded-xl border bg-white p-5">
            <div className="flex items-start justify-between gap-3">
              <h3 className="break-all font-semibold">{item.label}</h3>
              <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs">
                {materialStatus[item.status]}
              </span>
            </div>
            <a
              href={`/customer/materials/${item.assetId}/file`}
              target="_blank"
              rel="noreferrer"
              aria-label={`${item.label}の画像を開く`}
            >
              {/* biome-ignore lint/performance/noImgElement: Authenticated private image. */}
              <img
                src={`/customer/materials/${item.assetId}/file`}
                alt={item.label}
                loading="lazy"
                className="mt-4 h-44 w-full rounded-lg border bg-slate-50 object-contain"
              />
            </a>
            <p className="mt-2 text-xs text-slate-500">
              {item.width}×{item.height} / {Math.ceil(item.byteSize / 1024)}KB · {fmtDate(item.submittedAt)}
            </p>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7">{item.rightsNote}</p>
            <p className="mt-2 text-xs text-slate-500">
              申告した用途：
              {[item.requestedDemo && "営業デモ", item.requestedProduction && "本番サイト"].filter(Boolean).join("・")}
            </p>
            {item.status === "accepted" && (
              <p className="mt-2 text-sm text-emerald-800">
                現在の利用許可：
                {[item.allowSalesDemo && "営業デモ", item.allowProduction && "本番サイト"].filter(Boolean).join("・") ||
                  "停止中"}
              </p>
            )}
            {item.reviewNote && (
              <div className="mt-4 rounded-lg bg-blue-50 p-3">
                <p className="text-xs font-semibold text-blue-800">運営からの確認結果</p>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{item.reviewNote}</p>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {["pending", "needs_changes"].includes(item.status) && (
                <Button
                  variant="outline"
                  disabled={locked}
                  onClick={() => chooseEditor(editing === item.assetId ? null : item.assetId)}
                >
                  {editing === item.assetId ? "入力を閉じる" : "説明を追加・修正"}
                </Button>
              )}
              {item.status !== "withdrawn" && (
                <Button
                  variant="ghost"
                  disabled={locked}
                  onClick={() => {
                    if (
                      window.confirm(
                        `${dirty || file ? "未送信の入力も破棄します。" : ""}この画像を取り下げ、利用許可を停止します。公開済みサイトへの反映は運営が確認します。よろしいですか？`,
                      )
                    )
                      void run({
                        kind: "withdraw",
                        data: {
                          companyId,
                          assetId: item.assetId,
                          revision: item.revision,
                          requestId: crypto.randomUUID(),
                          confirmed: true,
                        },
                      });
                  }}
                >
                  取り下げる
                </Button>
              )}
            </div>
            {editing === item.assetId && (
              <form
                ref={formRef}
                hidden={comparison?.before.assetId === item.assetId}
                key={`${item.revision}:${formVersion}`}
                className="mt-5 space-y-4 border-t pt-5"
                onChange={() => setDirty(true)}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (locked) return;
                  void run({
                    kind: "revise",
                    data: {
                      ...fields(new FormData(e.currentTarget)),
                      companyId,
                      assetId: item.assetId,
                      revision: item.revision,
                      requestId: crypto.randomUUID(),
                    },
                  });
                }}
              >
                <fieldset disabled={locked} className="space-y-4">
                  <MaterialDetailsFields item={resumed?.assetId === item.assetId ? resumed.draft : item} />
                  <p className="text-xs text-slate-500">画像は差し替えできません。別の画像は新しく提出してください。</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit">説明を更新して確認を依頼</Button>
                    <Button type="button" data-material-compare variant="outline" onClick={() => void compare(item)}>
                      最新の内容と比較
                    </Button>
                  </div>
                </fieldset>
              </form>
            )}
            {comparison?.before.assetId === item.assetId && (
              <CustomerMaterialComparison
                before={comparison.before}
                latest={comparison.latest}
                draft={comparison.draft}
                onResume={resumeComparison}
                onClose={() => setComparison(null)}
                onFinish={finishComparison}
              />
            )}
          </article>
        ))}
      </div>
      <nav aria-label="素材のページ" className="flex justify-between text-sm">
        {page > 0 ? <Link href={`/customer/materials?company=${companyId}&page=${page - 1}`}>前の20件</Link> : <span />}
        {(page + 1) * 20 < listing.total && (
          <Link href={`/customer/materials?company=${companyId}&page=${page + 1}`}>次の20件</Link>
        )}
      </nav>
      <p className="text-xs leading-6 text-slate-500">
        この画面では自分が提出した素材を確認できます。提出しただけではサイトに掲載されません。1社の保存上限は100点・256MBです。上限に達した場合は運営へご相談ください。
      </p>
    </div>
  );
}
