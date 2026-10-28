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
import { makeFinalReviewSellable, reviewProposalVersion } from "./commands";
import { isUuid } from "./form";
import {
  EMPTY_REVIEW_DRAFT,
  type ReviewCommitInput,
  type ReviewDraftSnapshot,
  type ReviewSellableResult,
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
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1)
    throw new ReviewDraftError("確認メモの形式を確認してください");
  const { note } = value as Record<string, unknown>;
  if (typeof note !== "string" || note.length > 4000)
    throw new ReviewDraftError("確認メモは4000文字以内で入力してください");
  return { note };
}
/** 以前の形式（確認チェック付き）の下書きも、メモだけを読み出す */
function stored(value: unknown): ReviewValues | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { note } = value as Record<string, unknown>;
  return { note: typeof note === "string" ? note : "" };
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
    .select({ id: proposalVersions.id, status: proposalVersions.status, companyId: proposals.companyId })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(eq(proposalVersions.id, versionId));
  const [version] = await (lock ? query.for("update") : query);
  if (!version) throw new ReviewDraftError("対象の提案版がありません");
  return { userId: user.id, proposalVersionId: version.id, status: version.status, companyId: version.companyId };
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
    ? { revision: row.revision, values: stored(row.values), updatedAt: row.updatedAt.toISOString() }
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
export type ReviewCommitResult = {
  snapshot: ReviewDraftSnapshot;
  /** 承認後の営業可能化の結果。差し戻し・再送（受付済み）のときは undefined */
  sellable?: ReviewSellableResult;
};
/**
 * Review, private draft consumption and retry receipt commit atomically.
 * 承認したら同じトランザクション内で営業可能化まで進める。営業可能化はセーブポイントで
 * 囲むため、失敗しても承認は確定し、理由を返す。
 */
export async function commitReviewDraft(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  versionId: string,
  input: ReviewCommitInput,
): Promise<ReviewCommitResult> {
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
    if (receipt) return { snapshot: current };
    revisionCheck(input.revision, current);
    const note = current.values?.note ?? "";
    if (input.decision === "rejected" && !note.trim())
      throw new ReviewDraftError("修正してほしい内容を確認メモに入力してください");
    const result = await reviewProposalVersion({ db: tx, clock }, actor, {
      proposalVersionId: versionId,
      decision: input.decision,
      note,
    });
    if (!result.ok)
      throw new ReviewDraftError(result.message ?? "レビューを確定できませんでした。現在の状態を確認してください");
    const sellable =
      input.decision === "approved"
        ? await makeFinalReviewSellable({ db: tx, clock }, actor, {
            companyId: id.companyId,
            proposalVersionId: id.proposalVersionId,
          })
        : undefined;
    const snapshot = await write(tx, clock, id, current, null);
    await tx
      .insert(proposalReviewSubmissions)
      .values({ requestKey: key, proposalVersionId: id.proposalVersionId, createdAt: clock.now() });
    return { snapshot, ...(sellable ? { sellable } : {}) };
  });
}
