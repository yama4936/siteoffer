import { createHash } from "node:crypto";
import type { Actor, Clock } from "@siteoffer/core";
import {
  type DbOrTx,
  proposalReviewDrafts,
  proposalReviewSubmissions,
  proposals,
  proposalVersions,
  users,
} from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import { reviewProposalVersion } from "./commands";
import { isUuid } from "./form";
import {
  EMPTY_REVIEW_DRAFT,
  REVIEW_CHECKS,
  type ReviewCommitInput,
  type ReviewDraftSnapshot,
  type ReviewValues,
} from "./review-draft-types";

export class ReviewDraftError extends Error {}
export class ReviewDraftConflict extends ReviewDraftError {
  readonly snapshot: ReviewDraftSnapshot;
  constructor(snapshot: ReviewDraftSnapshot) {
    super("別の画面で下書きが更新されました");
    this.snapshot = snapshot;
  }
}
function validate(value: unknown): ReviewValues | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 6)
    throw new ReviewDraftError("確認項目とメモの形式を確認してください");
  const fields = value as Record<string, unknown>;
  if (
    typeof fields.note !== "string" ||
    fields.note.length > 4000 ||
    REVIEW_CHECKS.some(([key]) => typeof fields[key] !== "boolean")
  )
    throw new ReviewDraftError("確認メモは4000文字以内で入力してください。確認項目はチェック欄から選択してください");
  return { note: fields.note, ...Object.fromEntries(REVIEW_CHECKS.map(([key]) => [key, fields[key]])) } as ReviewValues;
}
async function authorize(db: DbOrTx, actor: Actor | null, versionId: string, lock = false) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId) || !isUuid(versionId))
    throw new ReviewDraftError("運営としてログインし、対象の提案を開いてください");
  const userQuery = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  const [user] = await (lock ? userQuery.for("share") : userQuery);
  if (!user) throw new ReviewDraftError("運営としてログインしてください");
  if (lock) {
    // Lock the proposal before a joined version query can retain its child lock.
    // Autosave and commit share the order used by review and condition changes.
    const [target] = await db
      .select({ proposalId: proposalVersions.proposalId })
      .from(proposalVersions)
      .where(eq(proposalVersions.id, versionId));
    if (!target) throw new ReviewDraftError("対象の提案版がありません");
    await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.id, target.proposalId)).for("update");
  }
  const query = db
    .select({ id: proposalVersions.id, status: proposalVersions.status })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(eq(proposalVersions.id, versionId));
  const [version] = await (lock ? query.for("update") : query);
  if (!version) throw new ReviewDraftError("対象の提案版がありません");
  return { userId: user.id, proposalVersionId: version.id, status: version.status };
}
type Identity = Awaited<ReturnType<typeof authorize>>;
async function read(db: DbOrTx, id: Identity): Promise<ReviewDraftSnapshot> {
  const [row] = await db
    .select()
    .from(proposalReviewDrafts)
    .where(
      and(eq(proposalReviewDrafts.userId, id.userId), eq(proposalReviewDrafts.proposalVersionId, id.proposalVersionId)),
    );
  return row
    ? { revision: row.revision, values: row.values as ReviewValues | null, updatedAt: row.updatedAt.toISOString() }
    : EMPTY_REVIEW_DRAFT;
}
function revisionCheck(expected: number, current: ReviewDraftSnapshot) {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new ReviewDraftError("下書きの版を確認してください");
  if (expected !== current.revision) throw new ReviewDraftConflict(current);
}
async function write(
  db: DbOrTx,
  clock: Clock,
  id: Identity,
  current: ReviewDraftSnapshot,
  values: ReviewValues | null,
) {
  const patch = { revision: current.revision + 1, values, updatedAt: clock.now() };
  await db
    .insert(proposalReviewDrafts)
    .values({ userId: id.userId, proposalVersionId: id.proposalVersionId, ...patch })
    .onConflictDoUpdate({ target: [proposalReviewDrafts.userId, proposalReviewDrafts.proposalVersionId], set: patch });
  return { ...patch, updatedAt: patch.updatedAt.toISOString() };
}
export async function loadReviewDraft(db: DbOrTx, actor: Actor | null, versionId: string) {
  return read(db, await authorize(db, actor, versionId));
}
export async function saveReviewDraft(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  versionId: string,
  revision: number,
  input: unknown,
) {
  const values = validate(input);
  return db.transaction(async (tx) => {
    const id = await authorize(tx, actor, versionId, true);
    const current = await read(tx, id);
    revisionCheck(revision, current);
    // Keep late notes on a superseded in-review version; they never carry over to the new version.
    if (values && id.status !== "in_review")
      throw new ReviewDraftError("この提案版は確認待ちではありません。入力を残したまま、現在の状態を確認してください");
    return write(tx, clock, id, current, values);
  });
}
/** Review, private draft consumption and retry receipt commit atomically. */
export async function commitReviewDraft(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  versionId: string,
  input: ReviewCommitInput,
) {
  if (
    !input ||
    !isUuid(input.requestKey) ||
    !["approved", "rejected"].includes(input.decision) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0
  )
    throw new ReviewDraftError("レビューの操作を確認してください");
  return db.transaction(async (tx) => {
    const id = await authorize(tx, actor, versionId, true);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          id.userId,
          id.proposalVersionId,
          input.requestKey.toLowerCase(),
          input.revision,
          input.decision,
        ]),
      )
      .digest("hex");
    const current = await read(tx, id);
    const [receipt] = await tx
      .select()
      .from(proposalReviewSubmissions)
      .where(eq(proposalReviewSubmissions.requestKey, key));
    if (receipt) return current;
    revisionCheck(input.revision, current);
    const values = current.values;
    if (!values) throw new ReviewDraftError("確認項目または修正メモを入力してください");
    if (input.decision === "approved" && REVIEW_CHECKS.some(([key]) => !values[key]))
      throw new ReviewDraftError("5つの確認項目を確認してください");
    if (input.decision === "rejected" && !values.note.trim())
      throw new ReviewDraftError("修正してほしい内容を確認メモに入力してください");
    const note =
      input.decision === "approved"
        ? `確認済み：${REVIEW_CHECKS.map(([, title]) => title).join("、")}\n${values.note}`
        : values.note;
    const result = await reviewProposalVersion({ db: tx, clock }, actor, {
      proposalVersionId: versionId,
      decision: input.decision,
      note,
    });
    if (!result.ok)
      throw new ReviewDraftError(result.message ?? "レビューを確定できませんでした。現在の状態を確認してください");
    const snapshot = await write(tx, clock, id, current, null);
    await tx
      .insert(proposalReviewSubmissions)
      .values({ requestKey: key, proposalVersionId: id.proposalVersionId, createdAt: clock.now() });
    return snapshot;
  });
}
