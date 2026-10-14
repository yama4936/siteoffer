import { ACTIVE_ASSIGNMENT_STATUSES, assignments, type DbOrTx, users } from "@siteoffer/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import { err, ok, type Result } from "../common/result.ts";

export type Assignment = typeof assignments.$inferSelect;
export type AssignmentStatus = Assignment["status"];

export function isActiveStatus(status: AssignmentStatus): boolean {
  return (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(status);
}

/**
 * 担当を行ロックして読み、操作主体が触れるかを確かめる。
 * 営業は自分の担当だけ、運営は全件。それ以外（system・customer）は拒否。
 * 権限判定の共通関数（T1の can()）へのつなぎ込みは統合時に行う。
 */
export async function loadAssignmentForActor(
  tx: DbOrTx,
  actor: Actor,
  assignmentId: string,
): Promise<Result<Assignment, "not_found" | "forbidden">> {
  if (actor.kind !== "sales" && actor.kind !== "ops") return err("forbidden");
  const [row] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId)).for("update");
  if (!row) return err("not_found");
  if (actor.kind === "sales" && row.userId !== actor.userId) return err("forbidden");
  return ok(row);
}

/** 利用中の営業ユーザーかを確かめ、行ロックする（上限判定を本人単位で直列にするため） */
export async function lockActiveSalesUser(
  tx: DbOrTx,
  userId: string,
): Promise<Result<typeof users.$inferSelect, "user_not_found" | "user_not_sales" | "user_suspended">> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  if (!user) return err("user_not_found");
  if (user.role !== "sales") return err("user_not_sales");
  if (user.status !== "active") return err("user_suspended");
  return ok(user);
}

export async function countActiveAssignments(tx: DbOrTx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(assignments)
    .where(and(eq(assignments.userId, userId), inArray(assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES])));
  return row?.n ?? 0;
}

/** 有効な担当の一意制約（assignments_one_active_per_company）違反か */
export function isActiveAssignmentConflict(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const c = cur as { code?: string; constraint?: string; message?: string; cause?: unknown };
    if (c.code === "23505") {
      return c.constraint === undefined || c.constraint === "assignments_one_active_per_company";
    }
    if (typeof c.message === "string" && c.message.includes("assignments_one_active_per_company")) return true;
    cur = c.cause;
  }
  return false;
}

class Abort<E extends string> extends Error {
  readonly result: Result<never, E>;
  constructor(result: Result<never, E>) {
    super(result.ok ? "" : result.error);
    this.result = result;
  }
}

/**
 * トランザクションを実行し、fail() で中断した想定内の失敗を Result にして返す。
 * fail() はロールバックのために例外で抜ける。想定外の例外はそのまま投げる。
 */
export async function runTx<T, E extends string>(
  db: DbOrTx,
  fn: (tx: DbOrTx, fail: (e: E, message?: string) => never) => Promise<T>,
): Promise<Result<T, E>> {
  try {
    const value = await db.transaction((tx) =>
      fn(tx, (e, message) => {
        throw new Abort(err(e, message));
      }),
    );
    return ok(value);
  } catch (e) {
    if (e instanceof Abort) return e.result as Result<never, E>;
    throw e;
  }
}

/** 履歴に残す担当の要約 */
export function snapshot(a: Assignment) {
  return {
    companyId: a.companyId,
    userId: a.userId,
    status: a.status,
    expiresAt: a.expiresAt?.toISOString() ?? null,
    nextActionAt: a.nextActionAt?.toISOString() ?? null,
    releaseReason: a.releaseReason,
  };
}
