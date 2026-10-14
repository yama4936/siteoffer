import {
  ACTIVE_ASSIGNMENT_STATUSES,
  assignments,
  companies,
  contracts,
  type DbOrTx,
  deliveries,
  deliveryVersions,
  proposals,
  proposalVersions,
  shareLinks,
} from "@siteoffer/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import { type Clock, HOUR } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok, type Result } from "../common/result.ts";
import { getSetting } from "../common/settings.ts";
import { authorizeUser } from "../permissions/policy.ts";
import { generateShareToken, hashShareToken, isShareTokenFormat } from "./token.ts";

export type SharePurpose = (typeof shareLinks.$inferSelect)["purpose"];
export type ShareLinkRow = typeof shareLinks.$inferSelect;

/** 画面に出してよい共有リンクの情報（トークンのハッシュは含めない） */
export interface ShareLinkInfo {
  id: string;
  purpose: SharePurpose;
  companyId: string;
  targetId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toInfo(row: ShareLinkRow): ShareLinkInfo {
  return {
    id: row.id,
    purpose: row.purpose,
    companyId: row.companyId,
    targetId: row.targetId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/** 履歴に残すリンクの要約（トークン・ハッシュは残さない） */
function eventSnapshot(row: ShareLinkRow) {
  return {
    purpose: row.purpose,
    companyId: row.companyId,
    targetId: row.targetId,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

interface LinkTarget {
  companyId: string;
  /** 提案の版は承認済み（approved）か。納品の版は常に true（顧客確認のための版） */
  approved: boolean;
  artifactDir: string | null;
}

/** 共有の対象（提案の版・納品の版）と、その企業をDBから読む */
async function loadTarget(db: DbOrTx, purpose: SharePurpose, targetId: string): Promise<LinkTarget | null> {
  if (!UUID_PATTERN.test(targetId)) return null;
  if (purpose === "proposal") {
    const [row] = await db
      .select({
        companyId: proposals.companyId,
        status: proposalVersions.status,
        artifactDir: proposalVersions.demoArtifactDir,
      })
      .from(proposalVersions)
      .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
      .where(eq(proposalVersions.id, targetId));
    return row ? { companyId: row.companyId, approved: row.status === "approved", artifactDir: row.artifactDir } : null;
  }
  const [row] = await db
    .select({ companyId: contracts.companyId, artifactDir: deliveryVersions.artifactDir })
    .from(deliveryVersions)
    .innerJoin(deliveries, eq(deliveries.id, deliveryVersions.deliveryId))
    .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
    .where(eq(deliveryVersions.id, targetId));
  return row ? { companyId: row.companyId, approved: true, artifactDir: row.artifactDir } : null;
}

/** 企業の有効な担当の営業ユーザー（いなければ null） */
async function activeAssignee(db: DbOrTx, companyId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: assignments.userId })
    .from(assignments)
    .where(and(eq(assignments.companyId, companyId), inArray(assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES])));
  return row?.userId ?? null;
}

export interface IssueShareLinkInput {
  purpose: SharePurpose;
  /** proposal なら proposal_versions.id、delivery なら delivery_versions.id */
  targetId: string;
  /** 有効期間（時間）。省略時は運営設定 shareLink.defaultTtlHours。営業は既定値より長くできない */
  ttlHours?: number;
}

export type IssueShareLinkError =
  | "forbidden"
  | "target_not_found"
  | "target_not_approved"
  | "target_no_artifact"
  | "company_suppressed"
  | "invalid_ttl";

export interface IssuedShareLink {
  link: ShareLinkInfo;
  /** トークンの平文。この戻り値でだけ渡す。DBには保存しない */
  token: string;
}

/**
 * 共有リンクの発行（11章）。
 * - 営業：自分が担当中の企業の、承認済み（approved）の提案版だけ。納品のリンクは発行できない。
 * - 運営：提案（承認済みの版）・納品の版。
 * トークンは乱数で作り、DBにはハッシュだけを保存する。平文は戻り値でだけ返す。
 */
export async function issueShareLink(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: IssueShareLinkInput,
): Promise<Result<IssuedShareLink, IssueShareLinkError>> {
  return db.transaction(async (tx): Promise<Result<IssuedShareLink, IssueShareLinkError>> => {
    const target = await loadTarget(tx, input.purpose, input.targetId);
    if (!target) return err("target_not_found");

    // 権限：属性はいま読んだ対象・担当の行から渡す（画面から来た値を使わない）
    const auth = authorizeUser(actor, "create", {
      type: "shareLink",
      purpose: input.purpose,
      companyId: target.companyId,
      assignedUserId: await activeAssignee(tx, target.companyId),
      createdBy: null,
    });
    if (!auth.ok) return err("forbidden", auth.message);
    const user = auth.value;

    if (!target.approved) return err("target_not_approved", "運営の承認が済んだ提案版だけを共有できます");
    if (!target.artifactDir) return err("target_no_artifact", "共有できる成果物がまだありません");

    if (input.purpose === "proposal") {
      const [company] = await tx
        .select({ suppression: companies.suppression })
        .from(companies)
        .where(eq(companies.id, target.companyId));
      if (company && company.suppression !== "none") {
        return err("company_suppressed", `営業抑止中（${company.suppression}）の企業には提案を共有できません`);
      }
    }

    const defaultTtl = await getSetting(tx, "shareLink.defaultTtlHours");
    const ttlHours = input.ttlHours ?? defaultTtl;
    if (!Number.isFinite(ttlHours) || ttlHours <= 0) return err("invalid_ttl", "有効期間は正の時間で指定してください");
    if (user.kind === "sales" && ttlHours > defaultTtl) {
      return err("invalid_ttl", `営業が指定できる有効期間は${defaultTtl}時間までです`);
    }

    const token = generateShareToken();
    const now = clock.now();
    const [row] = await tx
      .insert(shareLinks)
      .values({
        tokenHash: hashShareToken(token),
        purpose: input.purpose,
        companyId: target.companyId,
        targetId: input.targetId,
        expiresAt: new Date(now.getTime() + ttlHours * HOUR),
        createdBy: user.userId,
        createdAt: now,
      })
      .returning();
    await recordEvent(tx, clock, {
      actor: user,
      action: "share_link.issue",
      targetType: "share_link",
      targetId: row!.id,
      after: eventSnapshot(row!),
    });
    return ok({ link: toInfo(row!), token });
  });
}

export type RevokeShareLinkError = "forbidden" | "not_found" | "already_revoked";

/** 共有リンクの取り消し。発行者と運営だけが行える。取り消した時点から閲覧できなくなる（AC-14） */
export async function revokeShareLink(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  linkId: string,
): Promise<Result<ShareLinkInfo, RevokeShareLinkError>> {
  return db.transaction(async (tx): Promise<Result<ShareLinkInfo, RevokeShareLinkError>> => {
    if (!UUID_PATTERN.test(linkId)) return err("not_found");
    const [link] = await tx.select().from(shareLinks).where(eq(shareLinks.id, linkId)).for("update");
    if (!link) return err("not_found");

    const auth = authorizeUser(actor, "revoke", {
      type: "shareLink",
      purpose: link.purpose,
      companyId: link.companyId,
      assignedUserId: await activeAssignee(tx, link.companyId),
      createdBy: link.createdBy,
    });
    if (!auth.ok) return err("forbidden", auth.message);
    if (link.revokedAt) return err("already_revoked");

    const [row] = await tx
      .update(shareLinks)
      .set({ revokedAt: clock.now() })
      .where(and(eq(shareLinks.id, linkId), isNull(shareLinks.revokedAt)))
      .returning();
    if (!row) return err("already_revoked");
    await recordEvent(tx, clock, {
      actor: auth.value,
      action: "share_link.revoke",
      targetType: "share_link",
      targetId: row.id,
      before: eventSnapshot(link),
      after: eventSnapshot(row),
    });
    return ok(toInfo(row));
  });
}

/**
 * 対象（版）の共有リンクの一覧（画面表示用）。
 * 営業は自分が担当中の企業の提案版について、自分が発行したものだけ。運営はすべて。
 */
export async function listShareLinks(
  db: DbOrTx,
  actor: Actor | null,
  input: { purpose: SharePurpose; targetId: string },
): Promise<Result<ShareLinkInfo[], "forbidden" | "target_not_found">> {
  const target = await loadTarget(db, input.purpose, input.targetId);
  if (!target) return err("target_not_found");
  const auth = authorizeUser(actor, "read", {
    type: "shareLink",
    purpose: input.purpose,
    companyId: target.companyId,
    assignedUserId: await activeAssignee(db, target.companyId),
    createdBy: null,
  });
  if (!auth.ok) return err("forbidden", auth.message);
  const conds = [eq(shareLinks.purpose, input.purpose), eq(shareLinks.targetId, input.targetId)];
  if (auth.value.kind === "sales") conds.push(eq(shareLinks.createdBy, auth.value.userId));
  const rows = await db
    .select()
    .from(shareLinks)
    .where(and(...conds))
    .orderBy(desc(shareLinks.createdAt));
  return ok(rows.map(toInfo));
}

/** 検証に通った共有リンク。apps/preview の配信と、納品の顧客確認（T14）で使う */
export interface VerifiedShareLink {
  linkId: string;
  purpose: SharePurpose;
  companyId: string;
  targetId: string;
  expiresAt: Date;
  /** 配信する成果物ディレクトリ（proposal_versions.demo_artifact_dir または delivery_versions.artifact_dir） */
  artifactDir: string;
  /** このリンクで操作する顧客の操作主体（操作履歴に使う） */
  actor: Extract<Actor, { kind: "customer" }>;
}

/** 検証で拒否した理由。利用者には区別して見せない（すべて not_found）。サーバーのログ用 */
export type ShareLinkRejectReason =
  | "malformed"
  | "unknown"
  | "revoked"
  | "expired"
  | "target_mismatch"
  | "target_missing"
  | "target_not_approved"
  | "no_artifact";

/**
 * トークンの検証。不明・取り消し済み・期限切れ・対象の不一致はすべて not_found を返す
 * （存在を明かさない）。理由は message に入れる（ログ用。利用者には出さない）。
 * expect を渡すと、用途・対象の版が一致しないリンクも拒否する（例：顧客確認の承認で別の版のリンクを使わせない）。
 * 提案の版は検証の時点でも承認済みであること、対象の企業がリンクの企業と一致することを確かめる。
 */
export async function verifyShareLink(
  db: DbOrTx,
  clock: Clock,
  token: string,
  expect: { purpose?: SharePurpose; targetId?: string } = {},
): Promise<Result<VerifiedShareLink, "not_found">> {
  const reject = (reason: ShareLinkRejectReason) => err("not_found", reason);
  if (!isShareTokenFormat(token)) return reject("malformed");
  const [link] = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.tokenHash, hashShareToken(token)));
  if (!link) return reject("unknown");
  if (link.revokedAt) return reject("revoked");
  if (link.expiresAt.getTime() <= clock.now().getTime()) return reject("expired");
  if (expect.purpose !== undefined && expect.purpose !== link.purpose) return reject("target_mismatch");
  if (expect.targetId !== undefined && expect.targetId !== link.targetId) return reject("target_mismatch");

  const target = await loadTarget(db, link.purpose, link.targetId);
  if (!target) return reject("target_missing");
  if (target.companyId !== link.companyId) return reject("target_mismatch");
  if (!target.approved) return reject("target_not_approved");
  if (!target.artifactDir) return reject("no_artifact");

  return ok({
    linkId: link.id,
    purpose: link.purpose,
    companyId: link.companyId,
    targetId: link.targetId,
    expiresAt: link.expiresAt,
    artifactDir: target.artifactDir,
    actor: { kind: "customer", shareLinkId: link.id },
  });
}
