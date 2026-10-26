import { systemClock } from "@siteoffer/core";
import Link from "next/link";
import { AssignmentStatusBadge, ContractStatusBadge } from "@/components/sales/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/sales/labels";
import { ASSIGNMENT_VIEWS, type AssignmentView, prioritizeAssignments } from "@/lib/sales/priorities";
import { listMyAssignments } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";

export const metadata = { title: "担当案件 | SiteOffer" };

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/** 担当案件の一覧（自分の担当だけ） */
export default async function AssignmentsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser("sales");
  const sp = await searchParams;
  const includeEnded = sp.all === "1";
  const view: AssignmentView =
    typeof sp.view === "string" && Object.hasOwn(ASSIGNMENT_VIEWS, sp.view) && sp.view !== "all"
      ? (sp.view as AssignmentView)
      : "all";
  const r = await listMyAssignments(getDb(), user.actor, { includeEnded });

  const rows = r.ok ? prioritizeAssignments(r.value, systemClock.now()) : [];
  const visible = rows.filter((a) => view === "all" || a.next.group === view);
  return (
    <>
      <PageHeader
        title="担当案件"
        description="今日の予定と期限を確認し、次にすることから進められます。日付の区切りは日本時間です。"
        actions={
          includeEnded ? (
            <Link href="/sales/assignments" className={buttonVariants({ variant: "outline", size: "sm" })}>
              対応中の担当だけを表示
            </Link>
          ) : (
            <Link href="/sales/assignments?all=1" className={buttonVariants({ variant: "outline", size: "sm" })}>
              終了した担当も表示
            </Link>
          )
        }
      />
      {r.ok && (
        <>
          <nav aria-label="担当案件の絞り込み" className="mb-5 flex flex-wrap gap-2">
            {Object.entries(ASSIGNMENT_VIEWS)
              .filter(([key]) => includeEnded || key !== "closed")
              .map(([key, label]) => {
                const n = key === "all" ? rows.length : rows.filter((a) => a.next.group === key).length;
                return (
                  <Link
                    key={key}
                    href={`/sales/assignments?view=${key}${includeEnded ? "&all=1" : ""}`}
                    aria-current={view === key ? "page" : undefined}
                    className={buttonVariants({ variant: view === key ? "default" : "outline", size: "sm" })}
                  >
                    {key === "all" && includeEnded ? "すべて" : label} <span className="ml-1 tabular-nums">{n}</span>
                  </Link>
                );
              })}
          </nav>
          {rows.some((a) => a.next.group === "overdue") && (
            <Alert variant="warning" className="mb-5">
              <AlertDescription>
                予定・期限を過ぎた案件が {rows.filter((a) => a.next.group === "overdue").length}{" "}
                件あります。先頭から状況を確認できます。
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
      {!r.ok ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>担当案件を表示できませんでした。</AlertDescription>
        </Alert>
      ) : r.value.length === 0 ? (
        <EmptyState>
          担当中の案件はありません。
          <Link href="/sales/companies" className="text-primary underline-offset-4 hover:underline">
            企業一覧
          </Link>
          から担当を確保できます。
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>
          この条件に該当する案件はありません。
          <Link href="/sales/assignments" className="text-primary underline">
            対応中の案件をすべて表示
          </Link>
        </EmptyState>
      ) : (
        <>
          <section className="grid gap-3 md:hidden" aria-label="担当案件のカード">
            {visible.map((a) => (
              <article key={a.id} className="rounded-xl border bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/sales/assignments/${a.id}`} className="font-semibold text-primary">
                    {a.companyName}
                  </Link>
                  <AssignmentStatusBadge status={a.status} />
                </div>
                <p className="mt-2 text-sm font-medium">{a.next.label}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{a.next.reason}</p>
                <dl className="my-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">次回対応</dt>
                  <dd>{formatDateTime(a.nextActionAt)}</dd>
                  <dt className="text-muted-foreground">担当期限</dt>
                  <dd>{formatDateTime(a.expiresAt)}</dd>
                  {a.contractStatus && (
                    <>
                      <dt className="text-muted-foreground">契約確認</dt>
                      <dd>
                        <ContractStatusBadge status={a.contractStatus} />
                      </dd>
                    </>
                  )}
                </dl>
                <Link
                  href={`/sales/assignments/${a.id}`}
                  className={buttonVariants({ variant: "outline", size: "sm", className: "w-full" })}
                >
                  案件を開いて対応する →
                </Link>
              </article>
            ))}
          </section>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>企業</TableHead>
                  <TableHead>次にすること</TableHead>
                  <TableHead>状態</TableHead>
                  <TableHead>次回対応日</TableHead>
                  <TableHead>担当の期限</TableHead>
                  <TableHead>契約確認</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="min-w-40">
                      <Link href={`/sales/assignments/${a.id}`} className="font-medium text-primary hover:underline">
                        {a.companyName}
                      </Link>
                      <div className="text-muted-foreground text-xs">
                        {[a.prefecture, a.city].filter(Boolean).join(" ")}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-64 max-w-md">
                      <Link href={`/sales/assignments/${a.id}`} className="font-medium text-primary hover:underline">
                        {a.next.label} →
                      </Link>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{a.next.reason}</p>
                    </TableCell>
                    <TableCell>
                      <AssignmentStatusBadge status={a.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(a.nextActionAt)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(a.expiresAt)}</TableCell>
                    <TableCell>{a.contractStatus ? <ContractStatusBadge status={a.contractStatus} /> : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </>
  );
}
