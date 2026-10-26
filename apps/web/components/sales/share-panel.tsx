// サーバーで権限付き履歴と運営設定を読み、画面には公開可能なメタデータだけを渡す。
import { type Actor, getSetting, systemClock } from "@siteoffer/core";
import { checkShareAction, recoverShareAction } from "@/app/(sales)/actions";
import { getDb } from "@/lib/db";
import type { SalesAction } from "@/lib/sales/action-state";
import { listProposalShares } from "@/lib/sales/share";
import { ShareWorkspace } from "./share";

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
  const db = getDb();
  const [links, ttl] = await Promise.all([
    listProposalShares({ db, clock: systemClock, actor }, proposalVersionId),
    getSetting(db, "shareLink.defaultTtlHours"),
  ]);
  return (
    <ShareWorkspace
      key={proposalVersionId}
      proposalVersionId={proposalVersionId}
      issueAction={issueAction}
      revokeAction={revokeAction}
      checkAction={checkShareAction}
      recoverAction={recoverShareAction}
      maxHours={ttl}
      historyAvailable={links.ok}
      serverNow={systemClock.now().toISOString()}
      links={
        links.ok
          ? links.value.map((l) => ({
              id: l.id,
              recoverable: l.recoverable,
              createdAt: l.createdAt.toISOString(),
              expiresAt: l.expiresAt.toISOString(),
              revokedAt: l.revokedAt?.toISOString() ?? null,
            }))
          : []
      }
    />
  );
}
