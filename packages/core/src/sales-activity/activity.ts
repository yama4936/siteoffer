import { assignments, type DbOrTx, salesActivities } from "@siteoffer/db";
import { and, desc, eq, gte } from "drizzle-orm";
import {
  type Assignment,
  type AssignmentStatus,
  isActiveStatus,
  loadAssignmentForActor,
  runTx,
  snapshot,
} from "../assignment/shared.ts";
import type { Actor } from "../common/actor.ts";
import { type Clock, HOUR } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok, type Result } from "../common/result.ts";
import { getSetting } from "../common/settings.ts";
import { applySuppression, type DeclineKind } from "./suppression.ts";

export type SalesActivity = typeof salesActivities.$inferSelect;
/** 活動の種類（12.3の9種）：未着手、不在、再連絡予定、提案送付、商談中、契約確認待ち、契約完了、失注、営業拒否 */
export type SalesActivityKind = SalesActivity["kind"];

export interface RecordActivityInput {
  assignmentId: string;
  kind: SalesActivityKind;
  /** 活動した日時。省略時は現在。未来は不可 */
  occurredAt?: Date;
  note?: string;
  /** 次回対応日。再連絡予定（callback_scheduled）では必須 */
  nextActionAt?: Date;
  /** 運営への相談 */
  consultOps?: boolean;
  /** 営業拒否（declined）のときの内容 */
  decline?: { kind: DeclineKind; recontactAfter?: Date; reason?: string };
}

export type RecordActivityError =
  | "forbidden"
  | "not_found"
  | "not_active"
  | "invalid_input"
  | "company_not_found"
  | "stronger_suppression_exists";

/** 担当の進み具合（後戻りさせない） */
const PROGRESS: Partial<Record<AssignmentStatus, number>> = {
  claimed: 0,
  working: 1,
  negotiating: 2,
  contract_pending: 3,
};

/**
 * 活動から導く担当の状態。null は状態を変えない。
 * 契約完了（contract_completed）は営業の申告であり、勝手に完了扱いにしない（12.1）。
 * 契約確認待ち（contract_pending）に進め、完了は契約・入金の確認（T3）で行う。
 */
const TARGET: Record<SalesActivityKind, AssignmentStatus | null> = {
  not_started: null,
  no_answer: "working",
  callback_scheduled: "working",
  proposal_sent: "working",
  negotiating: "negotiating",
  contract_review: "contract_pending",
  contract_completed: "contract_pending",
  lost: "lost",
  declined: "lost",
};

function nextStatus(current: AssignmentStatus, kind: SalesActivityKind): AssignmentStatus {
  const target = TARGET[kind];
  if (target === null) return current;
  if (target === "lost") return "lost";
  // 運営確認待ちは運営が戻す（extendAssignment）。営業の活動記録では動かさない
  if (current === "awaiting_ops") return current;
  return (PROGRESS[target] ?? 0) > (PROGRESS[current] ?? 0) ? target : current;
}

/**
 * 活動の記録（12.3）。営業は自分の担当にだけ記録できる。運営は全件に記録できる。
 * 活動に応じて担当の状態を進め、最終活動日時・次回対応日・期限を更新する。
 * 期限は「最後の活動から設定時間」と「次回対応日」の遅い方まで延ばす（継続中の期限ルールは12.2で未決のための仮の扱い）。
 * 営業拒否（declined）は企業共通の営業抑止にし、担当を失注で終える。
 */
export async function recordActivity(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: RecordActivityInput,
): Promise<Result<{ activity: SalesActivity; assignment: Assignment }, RecordActivityError>> {
  if (actor.kind !== "sales" && actor.kind !== "ops") return err("forbidden");
  const actorUserId = actor.userId;
  const now = clock.now();
  const occurredAt = input.occurredAt ?? now;

  if (occurredAt.getTime() > now.getTime()) return err("invalid_input", "活動日時に未来は指定できません");
  if (input.kind === "callback_scheduled" && !input.nextActionAt) {
    return err("invalid_input", "再連絡予定には次回対応日が必要です");
  }
  if (input.nextActionAt && input.nextActionAt.getTime() <= now.getTime()) {
    return err("invalid_input", "次回対応日は現在より後にしてください");
  }
  if ((input.kind === "declined") !== (input.decline !== undefined)) {
    return err("invalid_input", "営業拒否の内容（今は不要／今後連絡しないで）は営業拒否のときだけ指定します");
  }
  if (input.decline && input.decline.kind !== "not_now" && input.decline.recontactAfter) {
    return err("invalid_input", "再連絡の目安は「今は不要」のときだけ記録できます");
  }

  return runTx<{ activity: SalesActivity; assignment: Assignment }, RecordActivityError>(db, async (tx, fail) => {
    const loaded = await loadAssignmentForActor(tx, actor, input.assignmentId);
    if (!loaded.ok) return fail(loaded.error);
    const before = loaded.value;
    if (!isActiveStatus(before.status)) fail("not_active");

    const [activity] = await tx
      .insert(salesActivities)
      .values({
        assignmentId: before.id,
        companyId: before.companyId,
        userId: actorUserId,
        kind: input.kind,
        occurredAt,
        note: input.note ?? null,
        nextActionAt: input.nextActionAt ?? null,
        consultOps: input.consultOps ?? false,
        createdAt: now,
      })
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "sales_activity.record",
      targetType: "sales_activity",
      targetId: activity!.id,
      after: {
        assignmentId: before.id,
        companyId: before.companyId,
        kind: input.kind,
        occurredAt: occurredAt.toISOString(),
        nextActionAt: input.nextActionAt?.toISOString() ?? null,
        consultOps: input.consultOps ?? false,
        decline: input.decline
          ? { kind: input.decline.kind, recontactAfter: input.decline.recontactAfter ?? null }
          : null,
      },
    });

    if (input.decline) {
      const r = await applySuppression(
        tx,
        clock,
        actor,
        {
          companyId: before.companyId,
          kind: input.decline.kind,
          reason: input.decline.reason ?? input.note,
          recontactAfter: input.decline.recontactAfter,
        },
        { status: "lost", reason: `declined:${input.decline.kind}` },
      );
      if (!r.ok) return fail(r.error, r.message);
      const [ended] = await tx.select().from(assignments).where(eq(assignments.id, before.id));
      return { activity: activity!, assignment: ended! };
    }

    const status = nextStatus(before.status, input.kind);
    const patch: Partial<typeof assignments.$inferInsert> = { status };
    if (status === "lost") {
      patch.releasedAt = now;
      patch.releaseReason = "lost";
    } else if (input.kind !== "not_started") {
      const hours = await getSetting(tx, "assignment.unstartedTimeoutHours");
      const candidates = [before.expiresAt?.getTime() ?? 0, now.getTime() + hours * HOUR];
      if (input.nextActionAt) candidates.push(input.nextActionAt.getTime());
      patch.lastActivityAt = now;
      patch.expiresAt = new Date(Math.max(...candidates));
    }
    if (input.nextActionAt) patch.nextActionAt = input.nextActionAt;

    const [after] = await tx.update(assignments).set(patch).where(eq(assignments.id, before.id)).returning();
    if (before.status !== after!.status || before.expiresAt?.getTime() !== after!.expiresAt?.getTime()) {
      await recordEvent(tx, clock, {
        actor,
        action: "assignment.update_by_activity",
        targetType: "assignment",
        targetId: before.id,
        before: snapshot(before),
        after: { ...snapshot(after!), activityId: activity!.id },
      });
    }
    return { activity: activity!, assignment: after! };
  });
}

/** 担当の活動履歴（新しい順）。営業は自分の担当だけ、運営は全件 */
export async function listActivities(
  db: DbOrTx,
  actor: Actor,
  assignmentId: string,
): Promise<Result<SalesActivity[], "forbidden" | "not_found">> {
  if (actor.kind !== "sales" && actor.kind !== "ops") return err("forbidden");
  const [a] = await db.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!a) return err("not_found");
  if (actor.kind === "sales" && a.userId !== actor.userId) return err("forbidden");
  const rows = await db
    .select()
    .from(salesActivities)
    .where(eq(salesActivities.assignmentId, assignmentId))
    .orderBy(desc(salesActivities.occurredAt));
  return ok(rows);
}

/** 運営への相談がある活動（運営のみ）。対応済みの管理は未実装（スキーマに列がない） */
export async function listOpsConsultations(
  db: DbOrTx,
  actor: Actor,
  filter: { since?: Date } = {},
): Promise<Result<SalesActivity[], "forbidden">> {
  if (actor.kind !== "ops") return err("forbidden");
  const rows = await db
    .select()
    .from(salesActivities)
    .where(
      and(
        eq(salesActivities.consultOps, true),
        filter.since ? gte(salesActivities.createdAt, filter.since) : undefined,
      ),
    )
    .orderBy(desc(salesActivities.createdAt));
  return ok(rows);
}
