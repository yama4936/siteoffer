import { ACTIVE_ASSIGNMENT_STATUSES, assignments, companies, contracts, type DbOrTx } from "@siteoffer/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import { type Clock, HOUR } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok, type Result } from "../common/result.ts";
import { getSetting } from "../common/settings.ts";
import { authorizeUser, requireUser } from "../permissions/policy.ts";
import { cancelOfferChangesOnAssignmentEnd } from "../sales-offer/lifecycle.ts";
import {
  type Assignment,
  type AssignmentStatus,
  countActiveAssignments,
  isActiveAssignmentConflict,
  isActiveStatus,
  loadAssignmentForActor,
  lockActiveSalesUser,
  runTx,
  snapshot,
} from "./shared.ts";

export type ReleaseError = "not_found" | "forbidden" | "not_active" | "contract_pending";

/**
 * 担当の解除。営業は自分の担当を手放せる。運営は全件を解除できる。
 * 企業の営業抑止には触れない（抑止は担当解除で消えない、12.3）。
 */
export async function releaseAssignment(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { assignmentId: string; reason: string },
): Promise<Result<Assignment, ReleaseError>> {
  return runTx<Assignment, ReleaseError>(db, async (tx, fail) => {
    const loaded = await loadAssignmentForActor(tx, actor, input.assignmentId, {
      type: "assignment",
      action: "release",
    });
    if (!loaded.ok) return fail(loaded.error);
    const before = loaded.value;
    if (!isActiveStatus(before.status)) fail("not_active");
    if (
      (
        await tx
          .select({ id: contracts.id })
          .from(contracts)
          .where(
            and(
              eq(contracts.assignmentId, before.id),
              inArray(contracts.status, ["reported", "under_review", "completed"]),
            ),
          )
      ).length
    )
      return fail("contract_pending", "契約確認中の担当は変更・解除できません。先に運営が成約報告を差し戻してください");
    const now = clock.now();
    const [after] = await tx
      .update(assignments)
      .set({ status: "released", releasedAt: now, releaseReason: input.reason })
      .where(eq(assignments.id, before.id))
      .returning();
    await cancelOfferChangesOnAssignmentEnd(tx, clock, actor, before.id, `担当解除：${input.reason}`);
    await recordEvent(tx, clock, {
      actor,
      action: actor.kind === "ops" ? "assignment.release_by_ops" : "assignment.release_by_sales",
      targetType: "assignment",
      targetId: before.id,
      before: snapshot(before),
      after: snapshot(after!),
    });
    return after!;
  });
}

export type ReassignError =
  | "forbidden"
  | "not_found"
  | "not_active"
  | "same_user"
  | "contract_pending"
  | "limit_reached"
  | "company_suppressed"
  | "already_assigned"
  | "user_not_found"
  | "user_not_sales"
  | "user_suspended";

/**
 * 運営による担当変更。旧担当を reassigned で解除し、同じ状態のまま新担当を作る。
 * 新担当の同時担当上限は守る（超える場合は先に別の担当を解除する）。期限は変更時点から設定時間。
 */
export async function reassignAssignment(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { assignmentId: string; toUserId: string; reason: string },
): Promise<Result<{ released: Assignment; created: Assignment }, ReassignError>> {
  // 対象を読む前に確かめる（所有者を限定しない確認。営業は常に拒否される）
  const auth = authorizeUser(
    actor,
    "reassign",
    { type: "assignment", ownerUserId: null },
    "担当の変更は運営だけが行えます",
  );
  if (!auth.ok) return auth;
  try {
    return await runTx<{ released: Assignment; created: Assignment }, ReassignError>(db, async (tx, fail) => {
      const loaded = await loadAssignmentForActor(tx, actor, input.assignmentId, {
        type: "assignment",
        action: "reassign",
      });
      if (!loaded.ok) return fail(loaded.error);
      const before = loaded.value;
      if (!isActiveStatus(before.status)) fail("not_active");
      if (
        (
          await tx
            .select({ id: contracts.id })
            .from(contracts)
            .where(
              and(
                eq(contracts.assignmentId, before.id),
                inArray(contracts.status, ["reported", "under_review", "completed"]),
              ),
            )
        ).length
      )
        return fail(
          "contract_pending",
          "契約確認中の担当は変更・解除できません。先に運営が成約報告を差し戻してください",
        );
      if (before.userId === input.toUserId) fail("same_user");

      const user = await lockActiveSalesUser(tx, input.toUserId);
      if (!user.ok) fail(user.error);
      const [company] = await tx.select().from(companies).where(eq(companies.id, before.companyId)).for("update");
      if (company && company.suppression !== "none") fail("company_suppressed");

      const max = await getSetting(tx, "assignment.maxActivePerUser");
      if ((await countActiveAssignments(tx, input.toUserId)) >= max) fail("limit_reached");

      const now = clock.now();
      const [released] = await tx
        .update(assignments)
        .set({ status: "released", releasedAt: now, releaseReason: `reassigned: ${input.reason}` })
        .where(eq(assignments.id, before.id))
        .returning();
      await cancelOfferChangesOnAssignmentEnd(tx, clock, actor, before.id, `担当変更：${input.reason}`);
      const hours = await getSetting(tx, "assignment.unstartedTimeoutHours");
      const [created] = await tx
        .insert(assignments)
        .values({
          companyId: before.companyId,
          salesOfferId: before.salesOfferId,
          userId: input.toUserId,
          status: before.status,
          claimedAt: now,
          expiresAt: new Date(now.getTime() + hours * HOUR),
          lastActivityAt: before.lastActivityAt,
          nextActionAt: before.nextActionAt,
          createdAt: now,
        })
        .returning();
      await recordEvent(tx, clock, {
        actor,
        action: "assignment.reassign",
        targetType: "assignment",
        targetId: before.id,
        before: snapshot(before),
        after: { ...snapshot(released!), newAssignmentId: created!.id, toUserId: input.toUserId, reason: input.reason },
      });
      await recordEvent(tx, clock, {
        actor,
        action: "assignment.claim_by_reassign",
        targetType: "assignment",
        targetId: created!.id,
        after: { ...snapshot(created!), fromAssignmentId: before.id },
      });
      return { released: released!, created: created! };
    });
  } catch (e) {
    if (isActiveAssignmentConflict(e)) return err("already_assigned");
    throw e;
  }
}

export type ExtendError = "forbidden" | "not_found" | "not_active" | "invalid_expiry";

/**
 * 運営による期限延長。運営確認待ち（awaiting_ops）の担当は、延長と同時に resumeStatus（既定は negotiating）へ戻す。
 */
export async function extendAssignment(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: {
    assignmentId: string;
    expiresAt: Date;
    resumeStatus?: Extract<AssignmentStatus, "claimed" | "working" | "negotiating" | "contract_pending">;
    reason?: string;
  },
): Promise<Result<Assignment, ExtendError>> {
  const auth = authorizeUser(
    actor,
    "extend",
    { type: "assignment", ownerUserId: null },
    "期限の延長は運営だけが行えます",
  );
  if (!auth.ok) return auth;
  return runTx<Assignment, ExtendError>(db, async (tx, fail) => {
    const loaded = await loadAssignmentForActor(tx, actor, input.assignmentId, {
      type: "assignment",
      action: "extend",
    });
    if (!loaded.ok) return fail(loaded.error);
    const before = loaded.value;
    if (!isActiveStatus(before.status)) fail("not_active");
    if (input.expiresAt.getTime() <= clock.now().getTime()) fail("invalid_expiry", "期限は現在より後にしてください");
    const status =
      before.status === "awaiting_ops" ? (input.resumeStatus ?? "negotiating") : (input.resumeStatus ?? before.status);
    const [after] = await tx
      .update(assignments)
      .set({ expiresAt: input.expiresAt, status })
      .where(eq(assignments.id, before.id))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "assignment.extend",
      targetType: "assignment",
      targetId: before.id,
      before: snapshot(before),
      after: { ...snapshot(after!), reason: input.reason ?? null },
    });
    return after!;
  });
}

/** 担当の一覧。営業は自分の担当だけ、運営は全件（status で絞り込み可）。既定は有効な担当のみ */
export async function listAssignments(
  db: DbOrTx,
  actor: Actor,
  filter: { statuses?: AssignmentStatus[]; userId?: string } = {},
): Promise<Result<Assignment[], "forbidden">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // 営業は自分の担当に絞る。運営は userId の指定がなければ全件（所有者を限定しない）
  const userId = user.value.kind === "sales" ? user.value.userId : filter.userId;
  const auth = authorizeUser(actor, "read", { type: "assignment", ownerUserId: userId ?? null });
  if (!auth.ok) return auth;
  const statuses = filter.statuses ?? [...ACTIVE_ASSIGNMENT_STATUSES];
  const rows = await db
    .select()
    .from(assignments)
    .where(and(inArray(assignments.status, statuses), userId ? eq(assignments.userId, userId) : undefined))
    .orderBy(desc(assignments.claimedAt));
  return ok(rows);
}
