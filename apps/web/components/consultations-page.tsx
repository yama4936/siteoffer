import {
  CONSULTATION_OPERATION_LABEL,
  CONSULTATION_STATUS_LABEL,
  type ConsultationOperation,
  countUnreadConsultations,
  getConsultationCase,
  listConsultationCases,
  loadConsultationDraft,
} from "@siteoffer/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConsultationForm } from "@/components/consultation-form";
import { ConsultationListRefresh, ConsultationReadMarker } from "@/components/consultation-read";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { fmtDate } from "@/lib/ops/format";
import { requireUser } from "@/lib/session";

type Params = Record<string, string | string[] | undefined>;
export async function ConsultationsPage({
  userRole: role,
  searchParams,
}: {
  userRole: "ops" | "sales";
  searchParams: Promise<Params>;
}) {
  const user = await requireUser(role);
  const sp = await searchParams;
  const db = getDb();
  const base = `/${role}/consultations`;
  const text = (key: string) => (typeof sp[key] === "string" ? (sp[key] as string) : "");
  const focus = text("focus");
  const assignmentId = text("assignment");
  if ((sp.focus !== undefined && !isUuid(focus)) || (sp.assignment !== undefined && !isUuid(assignmentId))) notFound();
  if (focus) {
    const result = await getConsultationCase(db, user.actor, focus);
    if (!result.ok) notFound();
    const backParams = new URLSearchParams();
    for (const key of ["status", "mine", "q", "page", "unread", "drafts", "assignment"])
      if (text(key)) backParams.set(key, text(key).slice(0, 100));
    const backHref = backParams.size ? `${base}?${backParams}` : base;
    const d = result.value;
    const initialDraft = await loadConsultationDraft(db, user.actor, d.activityId);
    const firstUnread = d.events.find((e) => e.revision > d.readRevision && e.authorId !== user.userId);
    const unreadAnchor =
      d.readRevision < 0 && role === "ops"
        ? "consultation-initial"
        : firstUnread
          ? `consultation-event-${firstUnread.id}`
          : "consultation-history-end";
    return (
      <>
        <Link href={backHref} className="mb-4 inline-block text-primary underline">
          相談の一覧へ
        </Link>
        <PageHeader
          title={d.companyName}
          description="相談の経緯と回答を一か所で確認できます。"
          actions={
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              href={
                role === "ops" ? `/ops/assignments?focus=${d.assignmentId}` : `/sales/assignments/${d.assignmentId}`
              }
            >
              担当案件を見る
            </Link>
          }
        />
        <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
          <Badge variant={d.status === "resolved" ? "success" : "warning"}>{CONSULTATION_STATUS_LABEL[d.status]}</Badge>
          <span>相談者：{d.requesterName}</span>
          <span>運営担当：{d.assignedName ?? "未定"}</span>
          <span className="text-muted-foreground">最終更新 {fmtDate(d.updatedAt)}</span>
        </div>
        {d.unread && (
          <p className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
            <strong>未確認の更新があります。</strong>{" "}
            <a href={`#${unreadAnchor}`} className="text-primary underline">
              最初の未読へ移動
            </a>
            <span className="mt-1 block text-xs text-muted-foreground">
              履歴の末尾を表示すると、表示済みの版まで確認済みになります。確認状態は自分だけに表示されます。
            </span>
          </p>
        )}
        <section aria-label="相談の履歴" className="mb-5 space-y-3">
          <article id="consultation-initial" tabIndex={-1} className="scroll-mt-20 rounded-xl border bg-card p-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <strong>{d.requesterName}からの相談</strong>
              <time className="text-xs text-muted-foreground">{fmtDate(d.requestedAt)}</time>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {d.note || "相談メモはありません。活動履歴を確認し、必要な内容を営業担当へ問い合わせてください。"}
            </p>
          </article>
          {d.events.map((e) => (
            <article
              key={e.id}
              id={`consultation-event-${e.id}`}
              tabIndex={-1}
              className={`scroll-mt-20 rounded-xl border p-5 ${e.role === "ops" ? "bg-blue-50/60" : "bg-card"}`}
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <strong>
                  {e.authorName} · {CONSULTATION_OPERATION_LABEL[e.operation as ConsultationOperation] ?? "更新"}
                </strong>
                <time className="text-xs text-muted-foreground">{fmtDate(e.createdAt)}</time>
              </div>
              {e.revision > d.readRevision && e.authorId !== user.userId && (
                <Badge variant="info" className="mb-2">
                  未読の更新
                </Badge>
              )}
              {e.note && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{e.note}</p>}
            </article>
          ))}
        </section>
        <div id="consultation-history-end" />
        {d.unread && (
          <ConsultationReadMarker
            key={`${d.activityId}:${d.revision}`}
            activityId={d.activityId}
            revision={d.revision}
          />
        )}
        <ConsultationForm
          key={d.activityId}
          activityId={d.activityId}
          initialDraft={initialDraft}
          revision={d.revision}
          status={d.status}
          userRole={role}
          userId={user.userId}
          assignedTo={d.assignedTo}
          assignedName={d.assignedName}
        />
      </>
    );
  }
  const status = ["pending", "resolved", "all"].includes(text("status"))
    ? (text("status") as "pending" | "resolved" | "all")
    : role === "ops"
      ? "pending"
      : "all";
  const unread = text("unread") === "1";
  const drafts = text("drafts") === "1";
  const unreadCount = await countUnreadConsultations(db, user.actor);
  const q = text("q").trim().slice(0, 100);
  const mine = role === "ops" && text("mine") === "1";
  const result = await listConsultationCases(db, user.actor, {
    status,
    mine,
    unread,
    drafts,
    q,
    page: Number(text("page")) || 1,
    assignmentId: assignmentId || undefined,
  });
  if (!result.ok) notFound();
  const { rows, total, page, pages } = result.value;
  function pageHref(next: number) {
    const p = new URLSearchParams({ status, page: String(next) });
    if (q) p.set("q", q);
    if (unread) p.set("unread", "1");
    if (drafts) p.set("drafts", "1");
    if (mine) p.set("mine", "1");
    if (assignmentId) p.set("assignment", assignmentId);
    return `${base}?${p}`;
  }
  function caseHref(activityId: string) {
    const params = new URLSearchParams(pageHref(page).split("?")[1]);
    params.set("focus", activityId);
    return `${base}?${params}`;
  }
  return (
    <>
      <PageHeader
        title={role === "ops" ? "営業からの相談" : "運営への相談"}
        description={
          role === "ops"
            ? "未対応・対応中の相談を古い順に表示します。回答すると営業担当もここで確認できます。"
            : "担当案件の相談と回答を確認できます。「すべて」では新しい更新から表示し、終了した案件の相談も残します。"
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <Link
          href={`${base}?status=all&unread=1`}
          className={buttonVariants({ variant: unread ? "default" : "outline", size: "sm" })}
        >
          未読の相談 {unreadCount.ok ? unreadCount.value : "—"}件
        </Link>
        <span className="text-muted-foreground">全担当案件・対応完了分も含めて、自分が未確認の更新を探せます。</span>
      </div>
      {assignmentId && (
        <p className="mb-4 text-sm">
          選んだ担当案件の相談を表示中です。
          <Link className="ml-2 text-primary underline" href={base}>
            すべての担当案件へ
          </Link>
        </p>
      )}
      <form
        key={`${status}:${q}:${mine}:${unread}:${drafts}:${assignmentId}`}
        action={base}
        className="mb-5 grid items-end gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-[10rem_minmax(12rem,1fr)_auto_auto]"
      >
        {assignmentId && <input type="hidden" name="assignment" value={assignmentId} />}
        <div className="grid gap-1 text-sm">
          <label htmlFor="consultation-filter-status">状態</label>
          <select
            id="consultation-filter-status"
            name="status"
            defaultValue={status}
            className="rounded-md border bg-background p-2"
          >
            <option value="pending">未対応・対応中</option>
            <option value="resolved">対応完了</option>
            <option value="all">すべて</option>
          </select>
        </div>
        <div className="grid min-w-0 flex-1 gap-1 text-sm">
          <label htmlFor="consultation-filter-q">企業名・相談者</label>
          <input
            id="consultation-filter-q"
            name="q"
            defaultValue={q}
            maxLength={100}
            className="min-w-0 rounded-md border p-2"
            placeholder="企業名で探す"
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {role === "ops" && (
            <label className="flex items-center gap-2 py-2 text-sm">
              <input type="checkbox" name="mine" value="1" defaultChecked={mine} />
              自分の担当
            </label>
          )}
          <label className="flex items-center gap-2 py-2 text-sm">
            <input type="checkbox" name="unread" value="1" defaultChecked={unread} />
            未読のみ
          </label>
          <label className="flex items-center gap-2 py-2 text-sm">
            <input type="checkbox" name="drafts" value="1" defaultChecked={drafts} />
            下書きあり
          </label>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit">絞り込む</Button>
          <Link href={base} className="py-2 text-sm text-primary underline">
            条件を解除
          </Link>
        </div>
      </form>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {total}件 · {page} / {pages}ページ
        </p>
        <ConsultationListRefresh />
      </div>
      <section aria-label="相談の一覧" className="space-y-3">
        {rows.map((d) => (
          <article key={d.activityId} className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                {d.unread && (
                  <Badge variant="info" className="mb-2">
                    未読の更新
                  </Badge>
                )}
                {d.hasDraft && (
                  <Badge variant="outline" className="mb-2 ml-1">
                    自分の下書き
                  </Badge>
                )}
                <h2 className="font-semibold">
                  <Link className="text-primary" href={caseHref(d.activityId)}>
                    {d.companyName}
                  </Link>
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {d.requesterName} · 受付 {fmtDate(d.requestedAt)}
                </p>
              </div>
              <Badge variant={d.status === "resolved" ? "success" : "warning"}>
                {CONSULTATION_STATUS_LABEL[d.status]}
              </Badge>
            </div>
            <p className="my-3 line-clamp-2 whitespace-pre-wrap break-words text-sm">{d.note ?? "相談メモなし"}</p>
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                運営担当：{d.assignedName ?? "未定"} · 更新 {fmtDate(d.updatedAt)}
              </span>
              <Link href={caseHref(d.activityId)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                {role === "ops" ? "内容を確認・回答" : "回答・状況を見る"}
              </Link>
            </div>
          </article>
        ))}
        {!rows.length && (
          <EmptyState>
            該当する相談はありません。
            {role === "sales" && (
              <>
                新しい相談は
                <Link href="/sales/assignments" className="text-primary underline">
                  担当案件
                </Link>
                で活動を記録するときに送れます。
              </>
            )}
          </EmptyState>
        )}
      </section>
      {pages > 1 && (
        <nav aria-label="相談のページ" className="mt-5 flex items-center justify-between gap-3">
          {page > 1 ? (
            <Link className={buttonVariants({ variant: "outline" })} href={pageHref(page - 1)}>
              前の30件
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm">
            {page} / {pages}
          </span>
          {page < pages ? (
            <Link className={buttonVariants({ variant: "outline" })} href={pageHref(page + 1)}>
              次の30件
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
