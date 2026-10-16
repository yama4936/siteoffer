import { authAttempts, type DbOrTx } from "@siteoffer/db";
import { eq, lt, lte, or, sql } from "drizzle-orm";
import type { Clock } from "../common/clock.ts";
import { hashToken } from "./crypto.ts";
export const AUTH_ATTEMPT_LIMIT = 5;
export const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export function authAttemptKey(purpose: "credential" | "recovery_request", identity: string) {
  return hashToken(`${purpose}:${identity.trim().toLowerCase()}`);
}
/** Reserve outside the credential transaction so a failure cannot undo the attempt. */
export async function claimAuthAttempt(db: DbOrTx, clock: Clock, key: string) {
  const now = clock.now(),
    cutoff = new Date(now.getTime() - AUTH_ATTEMPT_WINDOW_MS);
  // One statement: a concurrent successful login may delete the bucket at any time.
  const accepted = await db
    .insert(authAttempts)
    .values({ key, attempts: 1, windowStartedAt: now })
    .onConflictDoUpdate({
      target: authAttempts.key,
      set: {
        attempts: sql`case when ${authAttempts.windowStartedAt} <= ${cutoff.toISOString()}::timestamptz then 1 else ${authAttempts.attempts} + 1 end`,
        windowStartedAt: sql`case when ${authAttempts.windowStartedAt} <= ${cutoff.toISOString()}::timestamptz then ${now.toISOString()}::timestamptz else ${authAttempts.windowStartedAt} end`,
      },
      setWhere: or(lt(authAttempts.attempts, AUTH_ATTEMPT_LIMIT), lte(authAttempts.windowStartedAt, cutoff)),
    })
    .returning({ key: authAttempts.key });
  return accepted.length > 0;
}
export async function clearAuthAttempts(db: DbOrTx, key: string) {
  await db.delete(authAttempts).where(eq(authAttempts.key, key));
}
/** Remove expired buckets during existing worker maintenance. */
export async function cleanupAuthAttempts(db: DbOrTx, clock: Clock) {
  await db
    .delete(authAttempts)
    .where(lt(authAttempts.windowStartedAt, new Date(clock.now().getTime() - 24 * 60 * 60 * 1000)));
}
