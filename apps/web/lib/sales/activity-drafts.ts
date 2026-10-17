import { createHash } from "node:crypto";
import { type Actor, type Clock, findSecretInFields, isActiveStatus } from "@siteoffer/core";
import { activityDrafts, activitySubmissions, assignments, companies, type DbOrTx, users } from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import { isUuid } from "../ops/form";
import type { ActivityDraftSnapshot, ActivityValues } from "./activity-draft-types";
import { ACTIVITY_KINDS } from "./labels";
import { recordSalesActivity } from "./operations";
export class ActivityDraftError extends Error {}
export class ActivityDraftConflict extends ActivityDraftError {
  readonly snapshot: ActivityDraftSnapshot;
  constructor(snapshot: ActivityDraftSnapshot) {
    super("別の画面で活動の下書きが更新されました");
    this.snapshot = snapshot;
  }
}
const limits = {
  kind: 30,
  occurredAt: 16,
  nextActionMode: 7,
  nextActionAt: 16,
  note: 2000,
  declineKind: 20,
  recontactAfter: 10,
  declineReason: 500,
};
function validate(input: unknown): ActivityValues | null {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 9)
    throw new ActivityDraftError("入力内容を確認してください");
  const values = input as Record<string, unknown>;
  for (const [key, max] of Object.entries(limits))
    if (typeof values[key] !== "string" || (values[key] as string).length > max)
      throw new ActivityDraftError("入力内容の形式・文字数を確認してください");
  if (
    typeof values.consultOps !== "boolean" ||
    !ACTIVITY_KINDS.some((k) => k.value === values.kind) ||
    !["keep", "replace", "clear"].includes(values.nextActionMode as string) ||
    !["", "not_now", "do_not_contact"].includes(values.declineKind as string)
  )
    throw new ActivityDraftError("選択内容を確認してください");
  for (const key of ["occurredAt", "nextActionAt"] as const) {
    if (!/^(?:|\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/.test(values[key] as string))
      throw new ActivityDraftError("日時は入力欄から指定してください");
  }
  if (!/^(?:|\d{4}-\d{2}-\d{2})$/.test(values.recontactAfter as string))
    throw new ActivityDraftError("再連絡の目安は日付で指定してください");
  if (findSecretInFields({ note: values.note as string, declineReason: values.declineReason as string }))
    throw new ActivityDraftError(
      "秘密情報らしき値があるため下書きに保存していません。パスワード・移管コード・鍵は入力しないでください",
    );
  return Object.fromEntries([...Object.keys(limits), "consultOps"].map((key) => [key, values[key]])) as ActivityValues;
}
async function authorize(db: DbOrTx, actor: Actor | null, assignmentId: string, lock = false, companyFirst = false) {
  if (actor?.kind !== "sales" || !isUuid(assignmentId))
    throw new ActivityDraftError("営業としてログインし、自分の担当案件を開いてください");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "sales"), eq(users.status, "active")));
  if (!user) throw new ActivityDraftError("営業としてログインしてください");
  if (companyFirst) {
    const [candidate] = await db
      .select({ companyId: assignments.companyId })
      .from(assignments)
      .where(and(eq(assignments.id, assignmentId), eq(assignments.userId, actor.userId)));
    if (!candidate) throw new ActivityDraftError("自分の担当案件を開いてください");
    await db.select({ id: companies.id }).from(companies).where(eq(companies.id, candidate.companyId)).for("update");
  }
  const query = db
    .select()
    .from(assignments)
    .where(and(eq(assignments.id, assignmentId), eq(assignments.userId, actor.userId)));
  const [assignment] = await (lock ? query.for("update") : query);
  if (!assignment) throw new ActivityDraftError("自分の担当案件を開いてください");
  return assignment;
}
function where(userId: string, assignmentId: string) {
  return and(eq(activityDrafts.userId, userId), eq(activityDrafts.assignmentId, assignmentId));
}
async function read(db: DbOrTx, userId: string, assignmentId: string): Promise<ActivityDraftSnapshot> {
  const [row] = await db.select().from(activityDrafts).where(where(userId, assignmentId));
  return row
    ? { revision: row.revision, values: row.values as ActivityValues | null, updatedAt: row.updatedAt.toISOString() }
    : { revision: 0, values: null, updatedAt: null };
}
function revisionCheck(revision: number, current: ActivityDraftSnapshot) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new ActivityDraftError("下書きの版を確認してください");
  if (revision !== current.revision) throw new ActivityDraftConflict(current);
}
async function write(
  db: DbOrTx,
  clock: Clock,
  userId: string,
  assignmentId: string,
  current: ActivityDraftSnapshot,
  values: ActivityValues | null,
) {
  const patch = { revision: current.revision + 1, values, updatedAt: clock.now() };
  await db
    .insert(activityDrafts)
    .values({ userId, assignmentId, ...patch })
    .onConflictDoUpdate({ target: [activityDrafts.userId, activityDrafts.assignmentId], set: patch });
  return { ...patch, updatedAt: patch.updatedAt.toISOString() };
}
export async function loadActivityDraft(db: DbOrTx, actor: Actor | null, assignmentId: string) {
  const a = await authorize(db, actor, assignmentId);
  return read(db, a.userId, a.id);
}
export async function saveActivityDraft(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  assignmentId: string,
  revision: number,
  input: unknown,
) {
  const values = validate(input);
  return db.transaction(async (tx) => {
    const a = await authorize(tx, actor, assignmentId, true);
    if (!isActiveStatus(a.status))
      throw new ActivityDraftError("担当が終了しているため保存できません。画面を更新してください");
    const current = await read(tx, a.userId, a.id);
    revisionCheck(revision, current);
    return write(tx, clock, a.userId, a.id, current, values);
  });
}
export async function commitActivityDraft(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  assignmentId: string,
  input: { revision: number; values: unknown; requestKey: string; confirmEnd: boolean },
) {
  const values = validate(input.values);
  if (!values || !isUuid(input.requestKey)) throw new ActivityDraftError("入力内容を確認してください");
  if (["lost", "declined"].includes(values.kind) && input.confirmEnd !== true)
    throw new ActivityDraftError("担当が終了することを確認してください");
  return db.transaction(async (tx) => {
    const a = await authorize(tx, actor, assignmentId, true, true);
    const requestKey = createHash("sha256")
      .update(JSON.stringify([a.userId, a.id, input.requestKey, values]))
      .digest("hex");
    const [receipt] = await tx.select().from(activitySubmissions).where(eq(activitySubmissions.requestKey, requestKey));
    const current = await read(tx, a.userId, a.id);
    if (receipt) return { activityId: receipt.activityId, snapshot: current };
    if (!isActiveStatus(a.status))
      throw new ActivityDraftError("担当が終了しているため記録できません。画面を更新してください");
    revisionCheck(input.revision, current);
    const fd = new FormData();
    fd.set("assignmentId", a.id);
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string") fd.set(key, value);
      else if (value) fd.set(key, "on");
    }
    // Hidden draft fields are retained for editing, but never silently applied to business state.
    if (values.nextActionMode !== "replace") fd.delete("nextActionAt");
    if (["lost", "declined"].includes(values.kind)) {
      fd.set("nextActionMode", "clear");
      fd.delete("nextActionAt");
    }
    if (values.declineKind !== "not_now") fd.delete("recontactAfter");
    if (values.kind !== "declined") {
      fd.delete("declineKind");
      fd.delete("declineReason");
      fd.delete("recontactAfter");
    }
    const result = await recordSalesActivity({ db: tx, clock, actor }, fd);
    if (result?.status !== "ok" || !result.activityId)
      throw new ActivityDraftError(result?.message ?? "活動を記録できませんでした");
    await tx.insert(activitySubmissions).values({ requestKey, activityId: result.activityId, createdAt: clock.now() });
    const snapshot = await write(tx, clock, a.userId, a.id, current, null);
    return { activityId: result.activityId, snapshot };
  });
}
