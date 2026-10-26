import type { DbOrTx } from "@siteoffer/db";
import { sql } from "drizzle-orm";

/** pg-boss 12.38.0 の試行識別子。ジョブIDだけでは再試行後の旧担当を区別できない。 */
export interface QueueClaim {
  id: string;
  retryCount: number;
}
export function parseQueueClaim(value: unknown): QueueClaim | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Partial<QueueClaim>;
  return typeof c.id === "string" &&
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(c.id) &&
    Number.isSafeInteger(c.retryCount) &&
    c.retryCount! >= 0
    ? { id: c.id, retryCount: c.retryCount! }
    : null;
}

/** キューの行も業務トランザクション内でロックし、失効した試行の保存を拒否する。 */
export async function lockQueueClaim(db: DbOrTx, queue: string, claim: QueueClaim) {
  const result = await db.execute(sql`select state::text, retry_count as "retryCount",
    (state = 'active' and retry_count = ${claim.retryCount}
      and started_on + expire_seconds * interval '1 second' > clock_timestamp()
      and (heartbeat_seconds is null or heartbeat_on + heartbeat_seconds * interval '1 second' > clock_timestamp())) as owned
    from pgboss.job where name = ${queue} and id = ${claim.id}::uuid for update`);
  return (result as { rows: { state: string; retryCount: number; owned: boolean }[] }).rows[0];
}
