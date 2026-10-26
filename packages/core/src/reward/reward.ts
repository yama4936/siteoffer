import { type DbOrTx, rewardAdjustments, rewards } from "@siteoffer/db";
import { asc, eq, inArray, type SQL } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok, type Result } from "../common/result.ts";
import { authorizeUser } from "../permissions/policy.ts";

/**
 * 報酬の状態（18章）：契約完了で accrued → scheduled（支払予定）→ paid。取り消しは cancelled。
 * 金額の変更・取り消しは reward_adjustments に追記し、rewards.amount（発生時の額）は書き換えない。
 * 顧客の入金（payments）とは独立している。入金の有無で報酬の状態は変わらない（14章で確定）。
 */
export type Reward = typeof rewards.$inferSelect;
export type RewardAdjustment = typeof rewardAdjustments.$inferSelect;

export type RewardError = "forbidden" | "not_found" | "invalid_state" | "invalid_input";

export interface RewardSummary {
  reward: Reward;
  adjustments: RewardAdjustment[];
  /** 発生時の額 + 調整の合計 */
  currentAmount: number;
}

export async function getRewardSummary(db: DbOrTx, rewardId: string): Promise<RewardSummary | null> {
  return [...(await readRewardSummaries(db, eq(rewards.id, rewardId))).values()][0] ?? null;
}

/** Internal read helper; callers authorize the contracts before supplying their IDs. */
export async function getRewardSummariesForContracts(db: DbOrTx, contractIds: string[]) {
  if (!contractIds.length) return new Map<string, RewardSummary>();
  const summaries = await readRewardSummaries(db, inArray(rewards.contractId, contractIds));
  return new Map([...summaries.values()].map((summary) => [summary.reward.contractId, summary]));
}

async function readRewardSummaries(db: DbOrTx, where: SQL) {
  const rows = await db.select().from(rewards).where(where);
  const result = new Map<string, RewardSummary>();
  for (const reward of rows) result.set(reward.id, { reward, adjustments: [], currentAmount: reward.amount });
  if (!rows.length) return result;
  const adjustments = await db
    .select()
    .from(rewardAdjustments)
    .where(
      inArray(
        rewardAdjustments.rewardId,
        rows.map((reward) => reward.id),
      ),
    )
    .orderBy(asc(rewardAdjustments.createdAt));
  for (const adjustment of adjustments) {
    const summary = result.get(adjustment.rewardId)!;
    summary.adjustments.push(adjustment);
    summary.currentAmount += adjustment.delta;
  }
  return result;
}

/** 営業本人は自分の報酬を、運営は全件を見られる */
export async function getRewardForActor(
  db: DbOrTx,
  actor: Actor,
  rewardId: string,
): Promise<Result<RewardSummary, RewardError>> {
  const summary = await getRewardSummary(db, rewardId);
  if (!summary) return err("not_found");
  const auth = authorizeUser(actor, "read", { type: "reward", ownerUserId: summary.reward.userId });
  if (!auth.ok) return auth;
  return ok(summary);
}

async function lockReward(db: DbOrTx, rewardId: string): Promise<Reward | undefined> {
  const [row] = await db.select().from(rewards).where(eq(rewards.id, rewardId)).for("update");
  return row;
}

/** 支払予定日を決める（accrued・scheduled → scheduled） */
export async function scheduleRewardPayment(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { rewardId: string; scheduledFor: Date },
): Promise<Result<Reward, RewardError>> {
  // 対象を読む前に確かめる（所有者を限定しない確認。営業は常に拒否される）
  const auth = authorizeUser(actor, "manage", { type: "reward", ownerUserId: null });
  if (!auth.ok) return auth;
  return db.transaction(async (tx) => {
    const before = await lockReward(tx, input.rewardId);
    if (!before) return err("not_found");
    if (before.status !== "accrued" && before.status !== "scheduled") return err("invalid_state");
    const [after] = await tx
      .update(rewards)
      .set({ status: "scheduled", scheduledFor: input.scheduledFor })
      .where(eq(rewards.id, input.rewardId))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "reward.schedule",
      targetType: "reward",
      targetId: input.rewardId,
      before,
      after,
    });
    return ok(after!);
  });
}

/** 支払済みにする（scheduled → paid）。顧客入金の有無は条件にしない */
export async function markRewardPaid(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { rewardId: string },
): Promise<Result<Reward, RewardError>> {
  // 対象を読む前に確かめる（所有者を限定しない確認。営業は常に拒否される）
  const auth = authorizeUser(actor, "manage", { type: "reward", ownerUserId: null });
  if (!auth.ok) return auth;
  return db.transaction(async (tx) => {
    const before = await lockReward(tx, input.rewardId);
    if (!before) return err("not_found");
    if (before.status !== "scheduled") return err("invalid_state");
    const [after] = await tx
      .update(rewards)
      .set({ status: "paid", paidAt: clock.now() })
      .where(eq(rewards.id, input.rewardId))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "reward.pay",
      targetType: "reward",
      targetId: input.rewardId,
      before,
      after,
    });
    return ok(after!);
  });
}

/**
 * 報酬額を調整する。差額を reward_adjustments に追記し、元の額は変えない。
 * 取り消し済みの報酬は調整できない。調整後の額が負になる変更は拒否する。
 */
export async function adjustReward(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { rewardId: string; delta: number; reason: string },
): Promise<Result<RewardSummary, RewardError>> {
  // 対象を読む前に確かめる（所有者を限定しない確認。営業は常に拒否される）
  const auth = authorizeUser(actor, "manage", { type: "reward", ownerUserId: null });
  if (!auth.ok) return auth;
  if (!Number.isSafeInteger(input.delta) || input.delta === 0) return err("invalid_input", "delta");
  if (!input.reason.trim()) return err("invalid_input", "reason");
  return db.transaction(async (tx) => {
    const reward = await lockReward(tx, input.rewardId);
    if (!reward) return err("not_found");
    if (reward.status === "cancelled") return err("invalid_state");
    const before = (await getRewardSummary(tx, input.rewardId))!;
    if (before.currentAmount + input.delta < 0) return err("invalid_input", "調整後の額が負になります");
    const [adj] = await tx
      .insert(rewardAdjustments)
      .values({
        rewardId: input.rewardId,
        kind: "amount_change",
        delta: input.delta,
        reason: input.reason.trim(),
        createdBy: auth.value.userId,
        createdAt: clock.now(),
      })
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "reward.adjust",
      targetType: "reward",
      targetId: input.rewardId,
      before: { currentAmount: before.currentAmount },
      after: { currentAmount: before.currentAmount + input.delta, adjustmentId: adj!.id },
    });
    return ok((await getRewardSummary(tx, input.rewardId))!);
  });
}

/**
 * 報酬を取り消す。現在額を打ち消す調整（cancellation）を追記し、状態を cancelled にする。
 * 支払済みの報酬の取り消し（返還）の扱いは未決のため、ここでは拒否する。
 */
export async function cancelReward(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { rewardId: string; reason: string },
): Promise<Result<RewardSummary, RewardError>> {
  // 対象を読む前に確かめる（所有者を限定しない確認。営業は常に拒否される）
  const auth = authorizeUser(actor, "manage", { type: "reward", ownerUserId: null });
  if (!auth.ok) return auth;
  if (!input.reason.trim()) return err("invalid_input", "reason");
  return db.transaction(async (tx) => {
    const reward = await lockReward(tx, input.rewardId);
    if (!reward) return err("not_found");
    if (reward.status === "cancelled" || reward.status === "paid") return err("invalid_state");
    const before = (await getRewardSummary(tx, input.rewardId))!;
    await tx.insert(rewardAdjustments).values({
      rewardId: input.rewardId,
      kind: "cancellation",
      delta: -before.currentAmount,
      reason: input.reason.trim(),
      createdBy: auth.value.userId,
      createdAt: clock.now(),
    });
    const [after] = await tx
      .update(rewards)
      .set({ status: "cancelled", cancelledAt: clock.now() })
      .where(eq(rewards.id, input.rewardId))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "reward.cancel",
      targetType: "reward",
      targetId: input.rewardId,
      before: { ...before.reward, currentAmount: before.currentAmount },
      after: { ...after, currentAmount: 0 },
    });
    return ok((await getRewardSummary(tx, input.rewardId))!);
  });
}
