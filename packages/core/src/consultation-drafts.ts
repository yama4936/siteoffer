import {
  assignments,
  consultationCases,
  consultationDrafts,
  consultationEvents,
  type DbOrTx,
  salesActivities,
} from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import type { Actor } from "./common/actor.ts";
import type { Clock } from "./common/clock.ts";
import {
  authorizeConsultationActor,
  type ConsultationOperation,
  consultationReceiptKey,
  consultationVisibleTo,
  updateConsultationCase,
} from "./consultation.ts";
import { findSecretInFields } from "./domain-preference/secrets.ts";

export type ConsultationDraftValues = { note: string; mode: "reply" | "resolve"; caseRevision: string };
export type ConsultationDraftSnapshot = {
  revision: number;
  values: ConsultationDraftValues | null;
  updatedAt: string | null;
};
export class ConsultationDraftError extends Error {
  readonly code: string;
  constructor(message: string, code = "invalid_input") {
    super(message);
    this.code = code;
  }
}
export class ConsultationDraftConflict extends ConsultationDraftError {
  readonly snapshot: ConsultationDraftSnapshot;
  constructor(snapshot: ConsultationDraftSnapshot) {
    super("別の画面で下書きが更新されています", "draft_conflict");
    this.snapshot = snapshot;
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validate(raw: unknown): ConsultationDraftValues | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 3)
    throw new ConsultationDraftError("下書きの形式を確認してください");
  const v = raw as Record<string, unknown>;
  if (
    typeof v.note !== "string" ||
    v.note.length > 2000 ||
    !["reply", "resolve"].includes(v.mode as string) ||
    typeof v.caseRevision !== "string" ||
    !/^(0|[1-9]\d{0,9})$/.test(v.caseRevision)
  )
    throw new ConsultationDraftError("下書きの文字数・選択内容を確認してください");
  if (findSecretInFields({ note: v.note }))
    throw new ConsultationDraftError(
      "秘密情報らしき値があるため保存していません。パスワード・移管コード・鍵は入力しないでください",
    );
  return { note: v.note, mode: v.mode as "reply" | "resolve", caseRevision: v.caseRevision };
}
async function access(db: DbOrTx, actor: Actor | null, activityId: string, lock = false) {
  const auth = await authorizeConsultationActor(db, actor);
  if (!auth.ok) throw new ConsultationDraftError("ログイン状態を確認してください", "forbidden");
  if (!uuid.test(activityId)) throw new ConsultationDraftError("相談が見つかりません", "not_found");
  const query = db
    .select({ id: salesActivities.id })
    .from(salesActivities)
    .innerJoin(assignments, eq(assignments.id, salesActivities.assignmentId))
    .where(and(consultationVisibleTo(auth.value), eq(salesActivities.id, activityId)));
  const [activity] = await (lock ? query.for("update", { of: salesActivities }) : query);
  if (!activity) throw new ConsultationDraftError("この相談の下書きは利用できません", "not_found");
  return auth.value;
}
function where(userId: string, activityId: string) {
  return and(eq(consultationDrafts.userId, userId), eq(consultationDrafts.activityId, activityId));
}
async function read(db: DbOrTx, userId: string, activityId: string): Promise<ConsultationDraftSnapshot> {
  const [row] = await db.select().from(consultationDrafts).where(where(userId, activityId));
  return row
    ? { revision: row.revision, values: row.values, updatedAt: row.updatedAt.toISOString() }
    : { revision: 0, values: null, updatedAt: null };
}
function checkRevision(expected: number, current: ConsultationDraftSnapshot) {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new ConsultationDraftError("下書きの版を確認してください");
  if (expected !== current.revision) throw new ConsultationDraftConflict(current);
}
async function write(
  db: DbOrTx,
  clock: Clock,
  userId: string,
  activityId: string,
  current: ConsultationDraftSnapshot,
  values: ConsultationDraftValues | null,
) {
  const patch = { revision: current.revision + 1, values, updatedAt: clock.now() };
  await db
    .insert(consultationDrafts)
    .values({ userId, activityId, ...patch })
    .onConflictDoUpdate({ target: [consultationDrafts.userId, consultationDrafts.activityId], set: patch });
  return { ...patch, updatedAt: patch.updatedAt.toISOString() };
}
export async function loadConsultationDraft(db: DbOrTx, actor: Actor | null, activityId: string) {
  const user = await access(db, actor, activityId);
  return read(db, user.userId, activityId);
}
export async function saveConsultationDraft(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  activityId: string,
  revision: number,
  raw: unknown,
) {
  const values = validate(raw);
  return db.transaction(async (tx) => {
    const user = await access(tx, actor, activityId, true);
    const current = await read(tx, user.userId, activityId);
    checkRevision(revision, current);
    const [c] = await tx
      .select({ revision: consultationCases.revision })
      .from(consultationCases)
      .where(eq(consultationCases.activityId, activityId));
    if (values && Number(values.caseRevision) > (c?.revision ?? 0))
      throw new ConsultationDraftError("最新の相談履歴を確認してください");
    return write(tx, clock, user.userId, activityId, current, values);
  });
}
export interface SubmitConsultationDraftInput {
  revision: number;
  values: unknown;
  operation: Exclude<ConsultationOperation, "take">;
  requestKey: string;
}
export async function submitConsultationDraft(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  activityId: string,
  input: SubmitConsultationDraftInput,
) {
  if (!input || !uuid.test(input.requestKey)) throw new ConsultationDraftError("送信内容を確認してください");
  const values = validate(input.values);
  if (
    !values ||
    !["reply", "resolve", "reopen", "follow_up"].includes(input.operation) ||
    (["reply", "resolve"].includes(input.operation) && input.operation !== values.mode)
  )
    throw new ConsultationDraftError("送信する内容と回答後の状態を確認してください");
  return db.transaction(async (tx) => {
    const user = await access(tx, actor, activityId, true);
    const current = await read(tx, user.userId, activityId);
    const [receipt] = await tx
      .select({ id: consultationEvents.id })
      .from(consultationEvents)
      .where(eq(consultationEvents.receiptKey, consultationReceiptKey(user.userId, input.requestKey)));
    // 応答だけを失った再送は先に受付記録で判定し、後から書いた別の下書きを消さない。
    if (!receipt) checkRevision(input.revision, current);
    const result = await updateConsultationCase(tx, clock, user, {
      activityId,
      revision: Number(values.caseRevision),
      note: values.note,
      operation: input.operation,
      requestKey: input.requestKey,
    });
    if (!result.ok) throw new ConsultationDraftError(result.message ?? "この相談を更新できません", result.error);
    const snapshot = receipt ? current : await write(tx, clock, user.userId, activityId, current, null);
    return { ...result.value, snapshot, replayed: !!receipt };
  });
}
