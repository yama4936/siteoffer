import { recordEvent } from "@siteoffer/core";
import { auditEvents, auditRequests, type DbOrTx } from "@siteoffer/db";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { auditRequestKey, auditRequestPayload, validateAuditRequest } from "./audit-request.ts";
import type { WorkerDeps } from "./deps.ts";
import { readStepState } from "./ledger.ts";
import { QUEUES } from "./queues.ts";

const actor = { kind: "system", job: "audit-request" } as const;
const RETRY_MESSAGE = "診断処理への引き継ぎを確認できませんでした。依頼は保存済みで、自動で再送します。";
export const AUDIT_REQUEST_SEND_TIMEOUT_MS = 10000;
/** 実行台帳の確定結果を受付へ反映。完了直後のクラッシュも定期処理が復元する。 */
export async function reconcileAuditRequest(db: DbOrTx, clock: WorkerDeps["clock"], id: string) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return;
  const [initial] = await db.select().from(auditRequests).where(eq(auditRequests.id, id));
  if (!initial || initial.finishedAt) return;
  await db.transaction(async (tx) => {
    const key = auditRequestKey(initial);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:step:${key}`}))`);
    const [r] = await tx.select().from(auditRequests).where(eq(auditRequests.id, id)).for("update");
    if (!r || r.finishedAt) return;
    const state = await readStepState(tx, key);
    if (state.succeeded || state.gaveUp) {
      const [applied] = await tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetType, "worker_step"),
            eq(auditEvents.targetId, key),
            eq(auditEvents.action, "pipeline.audit_result_applied"),
          ),
        )
        .limit(1);
      const status = applied ? "completed" : state.gaveUp ? "failed" : "blocked";
      const message = applied
        ? "診断結果を保存し、判定に応じた次の処理へ進めました。"
        : ((await validateAuditRequest(tx, auditRequestPayload(r))) ??
          "診断を完了できませんでした。処理状況で結果と設定を確認してください。");
      await tx
        .update(auditRequests)
        .set({ status, message, finishedAt: clock.now(), leaseToken: null, leaseUntil: null, updatedAt: clock.now() })
        .where(eq(auditRequests.id, id));
      await recordEvent(tx, clock, {
        actor,
        action: "audit.request_finished",
        targetType: "company",
        targetId: r.companyId,
        after: { requestId: id, status },
      });
    } else if (state.attempts > 0) {
      await tx
        .update(auditRequests)
        .set({
          status: "processing",
          message: state.running
            ? "診断を実行しています。結果は自動で反映されます。"
            : "診断を自動で再試行します。追加の依頼は不要です。",
          nextAttemptAt: new Date(clock.now().getTime() + 60000),
          updatedAt: clock.now(),
        })
        .where(eq(auditRequests.id, id));
    }
  });
}
/** 外部送信はロックの外。キューと実行台帳に同じキーを使う。 */
export async function dispatchAuditRequests(deps: WorkerDeps) {
  if (deps.discoveryOnly) return { sent: 0, deferred: 0 };
  const { db, clock } = deps;
  const now = clock.now();
  const rows = await db
    .select({ id: auditRequests.id })
    .from(auditRequests)
    .where(
      and(
        isNull(auditRequests.finishedAt),
        lte(auditRequests.nextAttemptAt, now),
        or(isNull(auditRequests.leaseUntil), lte(auditRequests.leaseUntil, now)),
      ),
    )
    .orderBy(asc(auditRequests.nextAttemptAt), asc(auditRequests.createdAt))
    .limit(20);
  let sent = 0,
    deferred = 0;
  for (const row of rows) {
    await reconcileAuditRequest(db, clock, row.id);
    const claim = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(auditRequests).where(eq(auditRequests.id, row.id)).for("update");
      const now = clock.now();
      if (!r || r.finishedAt || r.nextAttemptAt > now || (r.leaseUntil && r.leaseUntil > now)) return null;
      const issue = await validateAuditRequest(tx, auditRequestPayload(r));
      if (issue) {
        await tx
          .update(auditRequests)
          .set({ status: "blocked", message: issue, finishedAt: now, updatedAt: now })
          .where(eq(auditRequests.id, r.id));
        await recordEvent(tx, clock, {
          actor,
          action: "audit.request_finished",
          targetType: "company",
          targetId: r.companyId,
          after: { requestId: r.id, status: "blocked" },
        });
        return null;
      }
      const [claimed] = await tx
        .update(auditRequests)
        .set({
          leaseToken: crypto.randomUUID(),
          leaseUntil: new Date(now.getTime() + 60000),
          attempts: r.attempts + 1,
          updatedAt: now,
        })
        .where(eq(auditRequests.id, r.id))
        .returning();
      return claimed!;
    });
    if (!claim) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delivered = false;
    try {
      const payload = auditRequestPayload(claim);
      await Promise.race([
        deps.queue.send(QUEUES.audit, payload, { singletonKey: auditRequestKey(claim) }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), AUDIT_REQUEST_SEND_TIMEOUT_MS);
        }),
      ]);
      delivered = true;
    } catch {
      /* 接続情報を含み得る例外本文は保存しない。 */
    } finally {
      clearTimeout(timer);
    }
    const updated = await db
      .update(auditRequests)
      .set({
        sentAt: delivered ? clock.now() : claim.sentAt,
        message: delivered ? "ワーカーの診断開始を待っています。" : RETRY_MESSAGE,
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: new Date(
          clock.now().getTime() + (delivered ? 60000 : Math.min(300000, 30000 * 2 ** Math.min(claim.attempts - 1, 4))),
        ),
        updatedAt: clock.now(),
      })
      .where(
        and(
          eq(auditRequests.id, claim.id),
          eq(auditRequests.leaseToken, claim.leaseToken!),
          isNull(auditRequests.finishedAt),
          sql`${auditRequests.leaseUntil}>${clock.now()}`,
        ),
      )
      .returning({ id: auditRequests.id });
    if (delivered && updated.length) sent++;
    else deferred++;
  }
  return { sent, deferred };
}
