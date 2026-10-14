import Link from "next/link";
import { AssignmentStatusBadge, ContractStatusBadge } from "@/components/sales/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/sales/labels";
import { listMyAssignments } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";

export const metadata = { title: "担当案件 | SiteOffer" };

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/** 担当案件の一覧（自分の担当だけ） */
export default async function AssignmentsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser("sales");
  const includeEnded = (await searchParams).all === "1";
  const r = await listMyAssignments(getDb(), user.actor, { includeEnded });

  return (
    <>
      <PageHeader
        title="担当案件"
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
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>企業</TableHead>
              <TableHead>状態</TableHead>
              <TableHead>次回対応日</TableHead>
              <TableHead>担当の期限</TableHead>
              <TableHead>契約確認</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.value.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="min-w-40">
                  <Link href={`/sales/assignments/${a.id}`} className="font-medium text-primary hover:underline">
                    {a.companyName}
                  </Link>
                  <div className="text-muted-foreground text-xs">
                    {[a.prefecture, a.city].filter(Boolean).join(" ")}
                  </div>
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
      )}
    </>
  );
}
