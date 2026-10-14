import { contracts, type DbOrTx, payments } from "@siteoffer/db";
import { asc, eq } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok, type Result } from "../common/result.ts";
import { findSecretInFields } from "../domain-preference/secrets.ts";

/**
 * 顧客からの入金（payments）。営業報酬（rewards）とは別に記録し、互いの状態を変えない（14章・AC-16）。
 * 未入金・解約・返金時の報酬の扱いは未決のため、入金の状態変更は報酬に連動させない。
 */
export type Payment = typeof payments.$inferSelect;
export type PaymentError = "forbidden" | "not_found" | "invalid_state" | "invalid_input" | "secret_like_value";

/** 入金予定（または入金済み）を登録する。完了した契約に対してだけ登録できる */
export async function recordPayment(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { contractId: string; amount: number; received?: boolean; note?: string | null },
): Promise<Result<Payment, PaymentError>> {
  if (actor.kind !== "ops") return err("forbidden");
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return err("invalid_input", "amount");
  if (findSecretInFields({ note: input.note })) return err("secret_like_value");
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(contracts).where(eq(contracts.id, input.contractId));
    if (!c) return err("not_found");
    if (c.status !== "completed") return err("invalid_state");
    const now = clock.now();
    const [p] = await tx
      .insert(payments)
      .values({
        contractId: c.id,
        amount: input.amount,
        status: input.received ? "received" : "pending",
        receivedAt: input.received ? now : null,
        note: input.note?.trim() || null,
        recordedBy: actor.userId,
        createdAt: now,
      })
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "payment.record",
      targetType: "payment",
      targetId: p!.id,
      after: p,
    });
    return ok(p!);
  });
}

export type PaymentTargetStatus = "received" | "refunded" | "cancelled";

const TRANSITIONS: Record<PaymentTargetStatus, Payment["status"][]> = {
  received: ["pending"],
  refunded: ["received"],
  cancelled: ["pending"],
};

/** 入金の状態を変える：pending → received / cancelled、received → refunded */
export async function updatePaymentStatus(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { paymentId: string; status: PaymentTargetStatus },
): Promise<Result<Payment, PaymentError>> {
  if (actor.kind !== "ops") return err("forbidden");
  const allowedFrom = TRANSITIONS[input.status];
  if (!allowedFrom) return err("invalid_input", "status");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).for("update");
    if (!before) return err("not_found");
    if (!allowedFrom.includes(before.status)) return err("invalid_state");
    const now = clock.now();
    const [after] = await tx
      .update(payments)
      .set({
        status: input.status,
        ...(input.status === "received" ? { receivedAt: now } : {}),
        ...(input.status === "refunded" ? { refundedAt: now } : {}),
      })
      .where(eq(payments.id, input.paymentId))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: `payment.${input.status}`,
      targetType: "payment",
      targetId: input.paymentId,
      before: { status: before.status },
      after: { status: after!.status },
    });
    return ok(after!);
  });
}

export async function listPaymentsForContract(db: DbOrTx, contractId: string): Promise<Payment[]> {
  return db.select().from(payments).where(eq(payments.contractId, contractId)).orderBy(asc(payments.createdAt));
}
