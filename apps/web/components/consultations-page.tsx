import {
  CONSULTATION_OPERATION_LABEL,
  CONSULTATION_STATUS_LABEL,
  type ConsultationOperation,
  getConsultationCase,
  listConsultationCases,
} from "@siteoffer/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConsultationForm } from "@/components/consultation-form";
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
    const d = result.value;
    return (
      <>
        <Link href={base} className="mb-4 inline-block text-primary underline">
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
        <section aria-label="相談の履歴" className="mb-5 space-y-3">
          <article className="rounded-xl border bg-card p-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <strong>{d.requesterName}からの相談</strong>
              <time className="text-xs text-muted-foreground">{fmtDate(d.requestedAt)}</time>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {d.note || "相談メモはありません。活動履歴を確認し、必要な内容を営業担当へ問い合わせてください。"}
            </p>
          </article>
          {d.events.map((e) => (
            <article key={e.id} className={`rounded-xl border p-5 ${e.role === "ops" ? "bg-blue-50/60" : "bg-card"}`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <strong>
                  {e.authorName} · {CONSULTATION_OPERATION_LABEL[e.operation as ConsultationOperation] ?? "更新"}
                </strong>
                <time className="text-xs text-muted-foreground">{fmtDate(e.createdAt)}</time>
              </div>
              {e.note && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{e.note}</p>}
            </article>
          ))}
        </section>
        <ConsultationForm
          key={d.activityId}
          activityId={d.activityId}
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
  const q = text("q").trim().slice(0, 100);
  const mine = role === "ops" && text("mine") === "1";
  const result = await listConsultationCases(db, user.actor, {
    status,
    mine,
    q,
    page: Number(text("page")) || 1,
    assignmentId: assignmentId || undefined,
  });
  if (!result.ok) notFound();
  const { rows, total, page, pages } = result.value;
  function pageHref(next: number) {
    const p = new URLSearchParams({ status, page: String(next) });
    if (q) p.set("q", q);
    if (mine) p.set("mine", "1");
    if (assignmentId) p.set("assignment", assignmentId);
    return `${base}?${p}`;
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
      {assignmentId && (
        <p className="mb-4 text-sm">
          選んだ担当案件の相談を表示中です。
          <Link className="ml-2 text-primary underline" href={base}>
            すべての担当案件へ
          </Link>
        </p>
      )}
      <form
        action={base}
        className="mb-5 grid items-end gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-[12rem_minmax(12rem,1fr)_auto_auto]"
      >
        {assignmentId && <input type="hidden" name="assignment" value={assignmentId} />}
        <label className="grid gap-1 text-sm">
          状態
          <select name="status" defaultValue={status} className="rounded-md border bg-background p-2">
            <option value="pending">未対応・対応中</option>
            <option value="resolved">対応完了</option>
            <option value="all">すべて</option>
          </select>
        </label>
        <label className="grid min-w-0 flex-1 gap-1 text-sm">
          企業名・相談者
          <input
            name="q"
            defaultValue={q}
            maxLength={100}
            className="min-w-0 rounded-md border p-2"
            placeholder="企業名で探す"
          />
        </label>
        {role === "ops" && (
          <label className="flex items-center gap-2 py-2 text-sm">
            <input type="checkbox" name="mine" value="1" defaultChecked={mine} />
            自分の担当
          </label>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit">絞り込む</Button>
          <Link href={base} className="py-2 text-sm text-primary underline">
            条件を解除
          </Link>
        </div>
      </form>
      <p className="mb-3 text-sm text-muted-foreground">
        {total}件 · {page} / {pages}ページ
      </p>
      <section aria-label="相談の一覧" className="space-y-3">
        {rows.map((d) => (
          <article key={d.activityId} className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">
                  <Link className="text-primary" href={`${base}?focus=${d.activityId}`}>
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
              <Link
                href={`${base}?focus=${d.activityId}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
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
