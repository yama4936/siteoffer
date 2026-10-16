import { createHash } from "node:crypto";
import {
  assignments,
  companies,
  consultationCases,
  consultationEvents,
  type DbOrTx,
  salesActivities,
  users,
} from "@siteoffer/db";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Actor } from "./common/actor.ts";
import type { Clock } from "./common/clock.ts";
import { recordEvent } from "./common/events.ts";
import { err, ok, type Result } from "./common/result.ts";
import { findSecretInFields } from "./domain-preference/secrets.ts";

export type ConsultationStatus = "open" | "in_progress" | "resolved";
export type ConsultationOperation = "take" | "reply" | "resolve" | "reopen" | "follow_up";
export type ConsultationError =
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "conflict"
  | "assigned_elsewhere"
  | "invalid_state";
type UserActor = Extract<Actor, { kind: "ops" | "sales" }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONSULTATION_PAGE_SIZE = 30;
export const CONSULTATION_STATUS_LABEL = { open: "未対応", in_progress: "対応中", resolved: "対応完了" } as const;
export const CONSULTATION_OPERATION_LABEL: Record<ConsultationOperation, string> = {
  take: "担当を引き受けました",
  reply: "回答しました",
  resolve: "回答して対応を完了しました",
  reopen: "対応を再開しました",
  follow_up: "追加の相談",
};
async function authorize(db: DbOrTx, actor: Actor | null): Promise<Result<UserActor, ConsultationError>> {
  if (!actor || (actor.kind !== "ops" && actor.kind !== "sales") || !uuid.test(actor.userId)) return err("forbidden");
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, actor.kind), eq(users.status, "active")));
  return u ? ok(actor) : err("forbidden");
}
const assigned = alias(users, "consultation_assigned");
const statusExpr = sql<ConsultationStatus>`coalesce(${consultationCases.status}, 'open')`;
const updatedExpr = sql<Date>`coalesce(${consultationCases.updatedAt}, ${salesActivities.createdAt})`.mapWith(
  salesActivities.createdAt,
);
function visible(actor: UserActor) {
  return and(
    eq(salesActivities.consultOps, true),
    actor.kind === "sales" ? eq(assignments.userId, actor.userId) : undefined,
  );
}
function selectCases(db: DbOrTx) {
  return db
    .select({
      activityId: salesActivities.id,
      assignmentId: salesActivities.assignmentId,
      companyId: companies.id,
      companyName: companies.name,
      requesterName: users.displayName,
      note: salesActivities.note,
      requestedAt: salesActivities.createdAt,
      occurredAt: salesActivities.occurredAt,
      assignmentStatus: assignments.status,
      status: statusExpr,
      revision: sql<number>`coalesce(${consultationCases.revision}, 0)`.mapWith(Number),
      assignedTo: consultationCases.assignedTo,
      assignedName: assigned.displayName,
      updatedAt: updatedExpr,
    })
    .from(salesActivities)
    .innerJoin(assignments, eq(assignments.id, salesActivities.assignmentId))
    .innerJoin(companies, eq(companies.id, salesActivities.companyId))
    .innerJoin(users, eq(users.id, salesActivities.userId))
    .leftJoin(consultationCases, eq(consultationCases.activityId, salesActivities.id))
    .leftJoin(assigned, eq(assigned.id, consultationCases.assignedTo));
}
export interface ConsultationFilter {
  status?: "pending" | "resolved" | "all";
  mine?: boolean;
  q?: string;
  page?: number;
  assignmentId?: string;
}
export async function listConsultationCases(db: DbOrTx, actor: Actor | null, filter: ConsultationFilter = {}) {
  const auth = await authorize(db, actor);
  if (!auth.ok) return auth;
  const user = auth.value;
  if (filter.assignmentId && !uuid.test(filter.assignmentId)) return err("invalid_input");
  const status = ["pending", "resolved", "all"].includes(filter.status ?? "") ? filter.status : "pending";
  const query = (filter.q ?? "")
    .trim()
    .slice(0, 100)
    .replace(/[\\%_]/g, "\\$&");
  const where = and(
    visible(user),
    status === "pending"
      ? sql`${statusExpr} <> 'resolved'`
      : status === "resolved"
        ? eq(consultationCases.status, "resolved")
        : undefined,
    filter.mine && user.kind === "ops" ? eq(consultationCases.assignedTo, user.userId) : undefined,
    filter.assignmentId ? eq(salesActivities.assignmentId, filter.assignmentId) : undefined,
    query ? or(ilike(companies.name, `%${query}%`), ilike(users.displayName, `%${query}%`)) : undefined,
  );
  const [totals] = await db
    .select({ total: count() })
    .from(salesActivities)
    .innerJoin(assignments, eq(assignments.id, salesActivities.assignmentId))
    .innerJoin(companies, eq(companies.id, salesActivities.companyId))
    .innerJoin(users, eq(users.id, salesActivities.userId))
    .leftJoin(consultationCases, eq(consultationCases.activityId, salesActivities.id))
    .where(where);
  const total = totals?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / CONSULTATION_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(filter.page) ? filter.page! : 1));
  const ordering =
    user.kind === "sales" && status === "all"
      ? [desc(updatedExpr), asc(salesActivities.id)]
      : [
          sql`case when ${statusExpr} = 'resolved' then 1 else 0 end`,
          status === "resolved" ? desc(updatedExpr) : asc(updatedExpr),
          asc(salesActivities.id),
        ];
  const rows = await selectCases(db)
    .where(where)
    .orderBy(...ordering)
    .limit(CONSULTATION_PAGE_SIZE)
    .offset((page - 1) * CONSULTATION_PAGE_SIZE);
  return ok({ rows, total, page, pages });
}
export async function getConsultationCase(db: DbOrTx, actor: Actor | null, activityId: string) {
  const auth = await authorize(db, actor);
  if (!auth.ok) return auth;
  if (!uuid.test(activityId)) return err("not_found");
  const [row] = await selectCases(db).where(and(visible(auth.value), eq(salesActivities.id, activityId)));
  if (!row) return err("not_found");
  const events = await db
    .select({
      id: consultationEvents.id,
      revision: consultationEvents.revision,
      operation: consultationEvents.operation,
      note: consultationEvents.note,
      createdAt: consultationEvents.createdAt,
      authorName: users.displayName,
      role: users.role,
    })
    .from(consultationEvents)
    .innerJoin(users, eq(users.id, consultationEvents.actorId))
    .where(eq(consultationEvents.activityId, activityId))
    .orderBy(asc(consultationEvents.revision));
  return ok({ ...row, events });
}
export interface ConsultationCommand {
  activityId: string;
  revision: number;
  operation: ConsultationOperation;
  note: string;
  requestKey: string;
}
export async function updateConsultationCase(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: ConsultationCommand,
): Promise<Result<{ revision: number; status: ConsultationStatus }, ConsultationError>> {
  const auth = await authorize(db, actor);
  if (!auth.ok) return auth;
  const user = auth.value;
  if (
    !input ||
    !uuid.test(input.activityId) ||
    !uuid.test(input.requestKey) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    typeof input.note !== "string" ||
    input.note.length > 2000 ||
    !Object.hasOwn(CONSULTATION_OPERATION_LABEL, input.operation)
  )
    return err("invalid_input", "入力内容を確認してください");
  const note = input.note.trim();
  if (input.operation !== "take" && !note) return err("invalid_input", "回答・追加相談・再開の理由を入力してください");
  if (findSecretInFields({ note }))
    return err("invalid_input", "パスワード・移管コード・鍵などの秘密情報は記録できません");
  if ((user.kind === "sales") !== (input.operation === "follow_up")) return err("forbidden");
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  const receiptKey = hash(`${user.userId}:${input.requestKey}`);
  const payloadHash = hash(JSON.stringify([input.activityId, input.revision, input.operation, note]));
  return db.transaction(async (tx) => {
    // 活動の行を共通ロックにし、最初の受付（ケースが未作成）も一つの順序で処理する。
    const [activity] = await tx
      .select({ id: salesActivities.id, owner: assignments.userId })
      .from(salesActivities)
      .innerJoin(assignments, eq(assignments.id, salesActivities.assignmentId))
      .where(and(eq(salesActivities.id, input.activityId), eq(salesActivities.consultOps, true)))
      .for("update", { of: salesActivities });
    if (!activity || (user.kind === "sales" && activity.owner !== user.userId)) return err("not_found");
    const [before] = await tx
      .select()
      .from(consultationCases)
      .where(eq(consultationCases.activityId, input.activityId));
    const revision = before?.revision ?? 0;
    const status = before?.status ?? "open";
    const [receipt] = await tx.select().from(consultationEvents).where(eq(consultationEvents.receiptKey, receiptKey));
    if (receipt)
      return receipt.payloadHash === payloadHash
        ? ok({ revision, status })
        : err("invalid_input", "送信内容が変わっています。最新の状態から操作してください");
    if (revision !== input.revision)
      return err("conflict", "別の画面で相談が更新されました。最新の履歴を確認してください");
    const operation = input.operation;
    if (
      (status === "resolved" && ["take", "reply", "resolve"].includes(operation)) ||
      (status !== "resolved" && operation === "reopen")
    )
      return err("invalid_state", "現在の状態では実行できません。最新の履歴を確認してください");
    if (["reply", "resolve"].includes(operation) && before?.assignedTo && before.assignedTo !== user.userId)
      return err("assigned_elsewhere", "別の運営担当が対応中です。自分に引き継いでから回答してください");
    const nextStatus: ConsultationStatus =
      operation === "resolve"
        ? "resolved"
        : operation === "reopen" || (operation === "follow_up" && status === "resolved")
          ? "open"
          : operation === "follow_up"
            ? status
            : "in_progress";
    const assignedTo =
      operation === "reopen" || (operation === "follow_up" && status === "resolved")
        ? null
        : operation === "follow_up"
          ? (before?.assignedTo ?? null)
          : user.userId;
    const after = {
      activityId: input.activityId,
      revision: revision + 1,
      status: nextStatus,
      assignedTo,
      updatedAt: clock.now(),
    };
    await tx
      .insert(consultationCases)
      .values(after)
      .onConflictDoUpdate({ target: consultationCases.activityId, set: after });
    await tx.insert(consultationEvents).values({
      activityId: input.activityId,
      revision: after.revision,
      actorId: user.userId,
      operation,
      note: operation === "take" ? "" : note,
      receiptKey,
      payloadHash,
      createdAt: clock.now(),
    });
    await recordEvent(tx, clock, {
      actor: user,
      action: `consultation.${operation}`,
      targetType: "sales_activity",
      targetId: input.activityId,
      before: { revision, status, assignedTo: before?.assignedTo ?? null },
      after: { revision: after.revision, status: after.status, assignedTo },
    });
    return ok({ revision: after.revision, status: nextStatus });
  });
}
