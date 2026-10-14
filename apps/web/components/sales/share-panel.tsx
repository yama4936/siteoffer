// 「提案を共有」の枠（サーバーコンポーネント）。発行済みリンクの一覧を読み、発行・取り消しのフォームを並べる。
import { type Actor, systemClock } from "@siteoffer/core";
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
    <div className="stack">
      <p className="hint">
        企業に改善デモを見せるときは、期限付きの共有リンクを発行して渡します。リンクは取り消せます。改善デモは非公式の改善提案で、企業の正式なサイトではありません。
      </p>
      <IssueShareForm action={issueAction} proposalVersionId={proposalVersionId} />
      <h3>発行済みのリンク（自分が発行したもの）</h3>
      {!links.ok ? (
        <p className="sub">発行済みのリンクを表示できません。</p>
      ) : links.value.length === 0 ? (
        <p className="sub">まだ発行していません。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>発行日時</th>
                <th>有効期限</th>
                <th>状態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {links.value.map((l) => (
                <tr key={l.id}>
                  <td>{formatDateTime(l.createdAt)}</td>
                  <td>{formatDateTime(l.expiresAt)}</td>
                  <td>
                    {STATE_LABEL[l.state]}
                    {l.revokedAt && <div className="sub">{formatDateTime(l.revokedAt)}</div>}
                  </td>
                  <td>{l.state === "active" ? <RevokeShareButton action={revokeAction} linkId={l.id} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">発行済みのリンクのURLは再表示できません。必要なら新しく発行してください。</p>
    </div>
  );
}
