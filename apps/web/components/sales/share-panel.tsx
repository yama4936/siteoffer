// 「提案を共有」の枠（サーバーコンポーネント）。発行済みリンクの一覧を読み、発行・取り消しのフォームを並べる。
import { type Actor, systemClock } from "@siteoffer/core";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import type { SalesAction } from "@/lib/sales/action-state";
import { formatDateTime } from "@/lib/sales/labels";
import { listProposalShares, type ShareLinkState } from "@/lib/sales/share";
import { IssueShareForm, RevokeShareButton } from "./share";

const STATE_LABEL: Record<ShareLinkState, string> = {
  active: "有効",
  expired: "期限切れ",
  revoked: "取り消し済み",
};

const STATE_BADGE: Record<ShareLinkState, "success" | "secondary" | "destructive"> = {
  active: "success",
  expired: "secondary",
  revoked: "destructive",
};

export async function ProposalSharePanel({
  actor,
  proposalVersionId,
  issueAction,
  revokeAction,
}: {
  actor: Actor;
  proposalVersionId: string;
  issueAction: SalesAction;
  revokeAction: SalesAction;
}) {
  const links = await listProposalShares({ db: getDb(), clock: systemClock, actor }, proposalVersionId);
  return (
    <div className="space-y-5">
      <Alert variant="info">
        <Info />
        <AlertDescription>
          企業に改善デモを見せるときは、期限付きの共有リンクを発行して渡します。リンクは取り消せます。改善デモは非公式の改善提案で、企業の正式なサイトではありません。
        </AlertDescription>
      </Alert>
      <IssueShareForm action={issueAction} proposalVersionId={proposalVersionId} />
      <div className="space-y-2">
        <h3 className="font-semibold text-sm">発行済みのリンク（自分が発行したもの）</h3>
        {!links.ok ? (
          <p className="text-muted-foreground text-sm">発行済みのリンクを表示できません。</p>
        ) : links.value.length === 0 ? (
          <p className="text-muted-foreground text-sm">まだ発行していません。</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>発行日時</TableHead>
                <TableHead>有効期限</TableHead>
                <TableHead>状態</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.value.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(l.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(l.expiresAt)}</TableCell>
                  <TableCell>
                    <Badge variant={STATE_BADGE[l.state]}>{STATE_LABEL[l.state]}</Badge>
                    {l.revokedAt && (
                      <div className="mt-1 whitespace-nowrap text-muted-foreground text-xs">
                        {formatDateTime(l.revokedAt)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {l.state === "active" ? <RevokeShareButton action={revokeAction} linkId={l.id} /> : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-muted-foreground text-xs">
          発行済みのリンクのURLは再表示できません。必要なら新しく発行してください。
        </p>
      </div>
    </div>
  );
}
