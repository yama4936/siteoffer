import { Info } from "lucide-react";
import { ContractStatusBadge, RewardStatusBadge } from "@/components/sales/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState, PageHeader, Section, Stat } from "@/components/ui/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime, formatYen } from "@/lib/sales/labels";
import { getMyEarnings } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";

export const metadata = { title: "実績・報酬 | SiteOffer" };

/** 実績・報酬（16章）：契約完了、発生報酬、支払予定、支払済み。自分の分だけ */
export default async function EarningsPage() {
  const user = await requireUser("sales");
  const r = await getMyEarnings(getDb(), user.actor);
  if (!r.ok) {
    return (
      <>
        <PageHeader title="実績・報酬" />
        <Alert variant="destructive" role="alert">
          <AlertDescription>表示できませんでした。</AlertDescription>
        </Alert>
      </>
    );
  }
  const { contracts, rewards, totals } = r.value;

  return (
    <>
      <PageHeader title="実績・報酬" />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="契約完了" value={`${totals.completedContracts}件`} />
        <Stat label="発生報酬（取り消しを除く）" value={formatYen(totals.accrued)} />
        <Stat label="支払予定" value={formatYen(totals.scheduled)} />
        <Stat label="支払済み" value={formatYen(totals.paid)} />
      </div>
      <Alert variant="info" className="mb-8">
        <Info />
        <AlertDescription>
          報酬は運営が契約資料を確認して契約完了にした時点で発生します。成約報告だけでは発生しません。支払日・金額の変更は運営が記録します。
        </AlertDescription>
      </Alert>

      <Section title="報酬">
        {rewards.length === 0 ? (
          <EmptyState>報酬はまだありません。</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>企業</TableHead>
                <TableHead>状態</TableHead>
                <TableHead className="text-right">金額</TableHead>
                <TableHead>発生日</TableHead>
                <TableHead>支払予定日</TableHead>
                <TableHead>支払日</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rewards.map((x) => (
                <TableRow key={x.id}>
                  <TableCell className="min-w-32 font-medium">{x.companyName}</TableCell>
                  <TableCell>
                    <RewardStatusBadge status={x.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {formatYen(x.currentAmount)}
                    {x.adjusted && <span className="block text-muted-foreground text-xs">（運営が調整）</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(x.accruedAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(x.scheduledFor)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(x.paidAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="成約報告と契約">
        {contracts.length === 0 ? (
          <EmptyState>成約報告はまだありません。</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>企業</TableHead>
                <TableHead>契約の状態</TableHead>
                <TableHead>報告日時</TableHead>
                <TableHead>契約完了</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contracts.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="min-w-32 font-medium">{c.companyName}</TableCell>
                  <TableCell>
                    <ContractStatusBadge status={c.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(c.reportedAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(c.completedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </>
  );
}
