/**
 * 営業の「提案を共有」（11章）。承認済みの提案版の期限付き共有リンクを発行・一覧・取り消しする。
 * - 発行・取り消し・一覧の権限（自分の担当企業だけ、取り消しは発行者か運営）は core の share-link が判定する。
 * - トークンの平文は発行の戻り値でだけ画面に渡す。DB・URLのクエリ・ログには残さない。再表示はできない。
 * Next.js に依存しない形にして、PGlite の結合テストから直接呼べるようにしている。
 */
import { type Actor, type Clock, issueShareLink, listShareLinks, revokeShareLink, shareLinkUrl } from "@siteoffer/core";
import { companies, type DbOrTx, proposals, proposalVersions, users } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import type { SalesActionState } from "./action-state.ts";
import { previewOrigin } from "./preview.ts";
import { UUID_RE } from "./queries.ts";
import type { ShareCheckResult } from "./share-presentation.ts";

export interface ShareDeps {
  db: DbOrTx;
  clock: Clock;
  actor: Actor | null;
}

/** 発行・取り消しのエラーコード → 画面の文言 */
export const SHARE_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "この提案は共有できません。自分が担当中の企業の提案だけを共有できます。",
  target_not_found: "共有する提案が見つかりません。",
  target_not_approved: "運営の承認が済んでいない提案版は共有できません。",
  target_no_artifact: "この提案版には改善デモがまだないため、共有できません。",
  company_suppressed: "この企業は営業拒否などにより営業が止まっているため、提案を共有できません。",
  invalid_ttl: "有効期間を確認してください。",
  not_found: "共有リンクが見つかりません。",
  already_revoked: "この共有リンクはすでに取り消されています。",
  unauthenticated: "ログインしてください。",
};

async function activeUser(deps: ShareDeps): Promise<boolean> {
  const actor = deps.actor;
  if (!actor || (actor.kind !== "sales" && actor.kind !== "ops") || !UUID_RE.test(actor.userId)) return false;
  const [user] = await deps.db
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, actor.userId));
  return user?.status === "active" && user.role === actor.kind;
}

const fail = (message: string): SalesActionState => ({ status: "error", message });

function shareError(r: { error: string; message?: string }): SalesActionState {
  const base = SHARE_ERROR_MESSAGES[r.error] ?? "処理できませんでした。";
  // invalid_ttl は上限の時間を含む core の文言（日本語）を添える。権限判定の内部文言（英字の識別子）は出さない
  if (r.error === "invalid_ttl" && r.message) return fail(`${base}（${r.message}）`);
  return fail(base);
}

const str = (fd: FormData, key: string): string => {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
};

/**
 * 提案版の共有リンクを発行し、URLをその場で一度だけ返す。
 * 有効期間（ttlHours）の空欄は運営設定の既定値。既定値より長い指定は core が invalid_ttl にする。
 */
export async function issueProposalShare(
  deps: ShareDeps,
  fd: FormData,
  origin: string = previewOrigin(),
): Promise<SalesActionState> {
  const versionId = str(fd, "proposalVersionId");
  if (!UUID_RE.test(versionId)) return fail("共有する提案が指定されていません。");
  const ttlRaw = str(fd, "ttlHours");
  let ttlHours: number | undefined;
  if (ttlRaw) {
    if (!/^\d{1,5}$/.test(ttlRaw)) return fail("有効期間を確認してください。");
    ttlHours = Number(ttlRaw);
  }
  if (!(await activeUser(deps))) return fail(SHARE_ERROR_MESSAGES.unauthenticated!);
  const r = await issueShareLink(deps.db, deps.clock, deps.actor, {
    purpose: "proposal",
    targetId: versionId,
    ...(ttlHours !== undefined ? { ttlHours } : {}),
  });
  if (!r.ok) return shareError(r);
  return {
    status: "ok",
    message:
      "共有リンクを発行しました。このURLはこの画面でだけ表示します。閉じると再表示できないため、必要なら新しく発行してください。",
    shareUrl: shareLinkUrl(origin, r.value.token),
    shareLinkId: r.value.link.id,
    shareExpiresAt: r.value.link.expiresAt.toISOString(),
  };
}

/** 共有リンクの取り消し（発行者・運営だけ。判定は core） */
export async function revokeProposalShare(deps: ShareDeps, fd: FormData): Promise<SalesActionState> {
  const linkId = str(fd, "linkId");
  if (!UUID_RE.test(linkId)) return fail("取り消すリンクが指定されていません。");
  if (!(await activeUser(deps))) return fail(SHARE_ERROR_MESSAGES.unauthenticated!);
  const r = await revokeShareLink(deps.db, deps.clock, deps.actor, linkId);
  if (!r.ok && r.error !== "already_revoked") return shareError(r);
  return { status: "ok", message: "共有リンクを取り消しました。このリンクでは改善デモを開けなくなります。" };
}

export type ShareLinkState = "active" | "expired" | "revoked";

export interface ShareLinkView {
  id: string;
  state: ShareLinkState;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** 提案版について自分が発行したリンク（営業）。URL（トークン）は返さない */
export async function listProposalShares(
  deps: ShareDeps,
  versionId: string,
): Promise<{ ok: true; value: ShareLinkView[] } | { ok: false; error: string }> {
  if (!UUID_RE.test(versionId)) return { ok: false, error: "target_not_found" };
  if (!(await activeUser(deps))) return { ok: false, error: "forbidden" };
  const r = await listShareLinks(deps.db, deps.actor, { purpose: "proposal", targetId: versionId });
  if (!r.ok) return { ok: false, error: r.error };
  const now = deps.clock.now().getTime();
  return {
    ok: true,
    value: r.value.map((l) => ({
      id: l.id,
      state: l.revokedAt ? "revoked" : l.expiresAt.getTime() <= now ? "expired" : "active",
      createdAt: l.createdAt,
      expiresAt: l.expiresAt,
      revokedAt: l.revokedAt,
    })),
  };
}

/** コピー直前の再確認。ブラウザから会社・担当・期限を受け取らず、現在のDBで判定する。 */
export async function checkProposalShare(
  deps: ShareDeps,
  versionId: string,
  linkId: string,
): Promise<ShareCheckResult> {
  const denied: ShareCheckResult = {
    status: "error",
    message: "このリンクは共有できません。担当・提案の承認状態を確認してください。",
    unavailable: true,
  };
  if (!UUID_RE.test(versionId) || !UUID_RE.test(linkId)) return denied;
  const links = await listProposalShares(deps, versionId);
  if (!links.ok) return denied;
  const link = links.value.find((l) => l.id === linkId);
  if (!link) return denied;
  if (link.state !== "active")
    return {
      status: "error",
      message: link.state === "revoked" ? "この共有リンクは取り消されています。" : "この共有リンクは期限切れです。",
      unavailable: true,
    };
  const [target] = await deps.db
    .select({
      status: proposalVersions.status,
      artifact: proposalVersions.demoArtifactDir,
      suppression: companies.suppression,
    })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .innerJoin(companies, eq(companies.id, proposals.companyId))
    .where(eq(proposalVersions.id, versionId));
  if (target?.status !== "approved" || !target.artifact || target.suppression !== "none") return denied;
  return { status: "ok", expiresAt: link.expiresAt.toISOString() };
}
