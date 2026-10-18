/**
 * 運営画面のサーバー処理。Server Function（app/(ops)/ops/actions.ts）から呼ぶ。
 * - 入口で requireOps を通し、運営以外は forbidden を返す（AC-17）
 * - 担当・抑止・契約・入金・報酬・ドメイン希望・利用停止は core の業務関数を呼ぶ
 * - core に無い運営の操作（候補の修正、提案版のレビュー、営業可能化、販売・報酬条件の版、運営設定、収集ジョブの作成）は
 *   ここで実装し、状態を変える処理は同じトランザクションで recordEvent を呼ぶ
 */

import {
  type Actor,
  adjustReward,
  authorizeUser,
  type Clock,
  cancelReward,
  confirmContract,
  confirmDomainPreference,
  DEFAULT_SETTINGS,
  err,
  extendAssignment,
  findSalesContract,
  liftSuppression,
  markRewardPaid,
  nextSalesOfferVersion,
  ok,
  type PaymentTargetStatus,
  parseRewardRule,
  type Result,
  reactivateUser,
  reassignAssignment,
  recordEvent,
  recordPayment,
  rejectContract,
  releaseAssignment,
  type SettingKey,
  scheduleRewardPayment,
  startContractReview,
  suppressCompany,
  suspendUser,
  updatePaymentStatus,
} from "@siteoffer/core";
import {
  appSettings,
  auditEvents,
  companies,
  type DbOrTx,
  designVersions,
  discoveryJobs,
  imageAssets,
  imageSubmissions,
  productTerms,
  proposals,
  proposalVersions,
  salesOffers,
  users,
} from "@siteoffer/db";
import {
  createDiscoveryJob,
  discoveryAvailability,
  discoveryCriteriaSchema,
  NtaCorporateNumberProvider,
} from "@siteoffer/discovery";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { isUuid } from "./form.ts";
import { type OpsActor, requireOps } from "./guard.ts";
import { type SellableIssue, sellableIssues } from "./sellable.ts";
import { reviewOfficialWebsite } from "./website-candidate.ts";

export interface OpsDeps {
  db: DbOrTx;
  clock: Clock;
}

type Company = typeof companies.$inferSelect;
type OfficialSiteStatus = Company["officialSiteStatus"];
type ImageAsset = typeof imageAssets.$inferSelect;
type ImageAssetSource = ImageAsset["sourceType"];
type ImageAssetRightsStatus = ImageAsset["rightsStatus"];

class Abort extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  constructor(code: string, detail?: string) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/** トランザクション内で fail() すると巻き戻して Result の err を返す */
async function inTx<T>(db: DbOrTx, fn: (tx: DbOrTx, fail: (code: string, detail?: string) => never) => Promise<T>) {
  try {
    const value = await db.transaction((tx) =>
      fn(tx, (code, detail) => {
        throw new Abort(code, detail);
      }),
    );
    return ok(value) as Result<T, string>;
  } catch (e) {
    if (e instanceof Abort) return err(e.code, e.detail) as Result<T, string>;
    throw e;
  }
}

function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    if ((cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** 運営だけに許した上で core の業務関数を呼ぶ。core 側でも権限を判定する（二重の確認） */
async function asOps<T>(
  actor: Actor | null,
  fn: (ops: OpsActor) => Promise<Result<T, string>>,
): Promise<Result<T, string>> {
  const ops = requireOps(actor);
  if (!ops.ok) return ops;
  return fn(ops.value);
}

/** 企業の manage 権限（運営だけ）。対象を読む前の確認 */
function authorizeCompanyManage(actor: Actor | null, companyId: string) {
  const ops = requireOps(actor);
  if (!ops.ok) return ops;
  const auth = authorizeUser(ops.value, "manage", {
    type: "company",
    companyId,
    sellable: false,
    assignedUserId: null,
  });
  if (!auth.ok) return auth;
  return ops;
}

// ───────────── 1. 収集条件・ジョブ・候補 ─────────────

/** 収集ジョブの登録（実行はワーカーの担当）。運営かどうかはここで確かめ、登録は discovery の createDiscoveryJob に任せる */
export const DISCOVERY_PROVIDERS = ["fixture", "nta-corporate-number"] as const;
export type DiscoveryProviderName = (typeof DISCOVERY_PROVIDERS)[number];

export async function createDiscoveryJobByOps(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { provider: string; criteria: unknown },
): Promise<Result<{ jobId: string }, string>> {
  const ops = requireOps(actor);
  if (!ops.ok) return ops;
  if (!(DISCOVERY_PROVIDERS as readonly string[]).includes(input.provider)) {
    return err("invalid_provider", "取得元が不正です");
  }
  const parsed = discoveryCriteriaSchema.safeParse(input.criteria);
  if (!parsed.success)
    return err("invalid_criteria", "収集条件が不正です。市区町村を指定する場合は都道府県も入力してください");
  if (input.provider === "nta-corporate-number") {
    if (parsed.data.industry)
      return err("invalid_criteria", "国税庁APIでは業種で絞り込めません。業種を空欄にしてください");
    const request = new NtaCorporateNumberProvider().buildRequests(parsed.data, clock.now());
    if (!request.ok) return err(request.error, request.message);
  }
  const capability = (await discoveryAvailability(db, clock)).find((p) => p.provider === input.provider);
  if (!capability?.ready) return err("provider_unavailable", capability?.reason ?? "取得元を確認できません");
  const r = await createDiscoveryJob(db, clock, {
    provider: input.provider,
    criteria: input.criteria,
    createdBy: ops.value.userId,
    actor: ops.value,
  });
  if (!r.ok) return err(r.error, r.message ?? "収集条件が不正です");
  return ok({ jobId: r.value.jobId });
}

/** Keep failed history and use a fresh queue key. Lock and unique parent prevent double-click duplicates. */
export async function retryDiscoveryJobByOps(
  deps: OpsDeps,
  actor: Actor | null,
  jobId: string,
): Promise<Result<{ jobId: string }, string>> {
  const auth = requireOps(actor);
  if (!auth.ok) return auth;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) return err("not_found");
  return deps.db.transaction(async (tx) => {
    const key = `discovery:${jobId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:step:${key}`}))`);
    const [old] = await tx.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId)).for("update");
    if (!old) return err("not_found");
    if (old.status !== "failed") return err("invalid_state", "失敗した収集ジョブだけを再試行できます");
    const [existing] = await tx
      .select({ jobId: discoveryJobs.id })
      .from(discoveryJobs)
      .where(eq(discoveryJobs.retryOfJobId, jobId));
    if (existing) return ok(existing);
    const events = await tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetType, "worker_step"), eq(auditEvents.targetId, key)));
    const started = events.filter((e) => e.action === "worker.step_started").length;
    const finished = events.filter((e) => ["worker.step_failed", "worker.step_succeeded"].includes(e.action)).length;
    if (started > finished) return err("invalid_state", "自動再試行が実行中です。完了してから再試行してください");
    const next = await createDiscoveryJobByOps({ db: tx, clock: deps.clock }, actor, {
      provider: old.provider,
      criteria: old.criteria,
    });
    if (!next.ok) return next;
    // Retire the old queue key before creating an independent retry chain.
    await recordEvent(tx, deps.clock, {
      actor: auth.value,
      action: "worker.step_failed",
      targetType: "worker_step",
      targetId: key,
      after: { queue: "discovery", attempt: started, final: true, reason: "運営による再試行ジョブに引き継ぎました" },
    });
    await tx.update(discoveryJobs).set({ retryOfJobId: jobId }).where(eq(discoveryJobs.id, next.value.jobId));
    await recordEvent(tx, deps.clock, {
      actor: auth.value,
      action: "discovery.job_retried",
      targetType: "discovery_job",
      targetId: jobId,
      after: { newJobId: next.value.jobId },
    });
    return next;
  });
}

export interface CandidatePatch {
  name?: string;
  prefecture?: string | null;
  city?: string | null;
  address?: string | null;
  addressSourceUrl?: string | null;
  industry?: string | null;
  representativePhone?: string | null;
}

const PATCH_KEYS = [
  "name",
  "prefecture",
  "city",
  "address",
  "addressSourceUrl",
  "industry",
  "representativePhone",
] as const satisfies readonly (keyof CandidatePatch)[];

/** 候補の修正（運営）。変更した項目だけを操作履歴に残す */
export async function updateCandidate(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { companyId: string; patch: CandidatePatch },
): Promise<Result<Company, string>> {
  const ops = authorizeCompanyManage(actor, input.companyId);
  if (!ops.ok) return ops;
  if (input.patch.name !== undefined && !input.patch.name.trim()) return err("invalid_input", "企業名は必須です");
  if (input.patch.addressSourceUrl && !/^https?:\/\//.test(input.patch.addressSourceUrl)) {
    return err("invalid_input", "住所の出典URLは http(s) で始めてください");
  }
  return inTx(db, async (tx, fail) => {
    const [before] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("update");
    if (!before) return fail("not_found");
    const changes: Partial<Record<(typeof PATCH_KEYS)[number], string | null>> = {};
    const prev: Record<string, unknown> = {};
    for (const key of PATCH_KEYS) {
      const v = input.patch[key];
      if (v === undefined) continue;
      const next = key === "name" ? (v ?? "").trim() : v?.trim() || null;
      if (next !== before[key]) {
        changes[key] = next;
        prev[key] = before[key];
      }
    }
    if (Object.keys(changes).length === 0) return before;
    const [after] = await tx
      .update(companies)
      .set({ ...changes, name: changes.name ?? undefined, updatedAt: clock.now() })
      .where(eq(companies.id, before.id))
      .returning();
    await recordEvent(tx, clock, {
      actor: ops.value,
      action: "company.update_by_ops",
      targetType: "company",
      targetId: before.id,
      before: prev,
      after: changes,
    });
    return after!;
  });
}

/**
 * 公式サイトの確度を運営が確定・変更する（needs_review → confirmed など）。
 * confirmed にするときに websiteId を渡すと、そのサイトを企業の主サイトにする。
 */
export async function setOfficialSiteStatus(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { companyId: string; status: OfficialSiteStatus; websiteId?: string | null; note?: string },
): Promise<Result<Company, string>> {
  return reviewOfficialWebsite({ db, clock }, actor, input);
}

/** 候補の除外・既存顧客の記録（企業共通の抑止。再収集で営業可能に戻らない） */
export function excludeCandidate(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { companyId: string; kind: "excluded" | "existing_customer"; reason: string },
) {
  return asOps(actor, (ops) => {
    if (input.kind !== "excluded" && input.kind !== "existing_customer") {
      return Promise.resolve(err("invalid_input", "除外の種類が不正です"));
    }
    if (!input.reason.trim()) return Promise.resolve(err("invalid_input", "理由を入力してください"));
    return suppressCompany(db, clock, ops, {
      companyId: input.companyId,
      kind: input.kind,
      reason: input.reason.trim(),
    });
  });
}

const IMAGE_ASSET_SOURCES = ["original_site", "customer_upload", "generated", "operator_upload"] as const;
const IMAGE_RIGHTS_STATUSES = ["unknown", "customer_claimed", "license_verified", "use_approved"] as const;

/** 画像そのものではなく、出所と利用可否を企業単位の素材台帳へ登録する。 */
export async function createImageAsset(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { companyId: string; label: string; sourceType: ImageAssetSource; sourceUrl?: string | null; note?: string },
): Promise<Result<ImageAsset, string>> {
  const ops = authorizeCompanyManage(actor, input.companyId);
  if (!ops.ok) return ops;
  const label = input.label.trim();
  const sourceUrl = input.sourceUrl?.trim() || null;
  if (!label) return err("invalid_input", "素材名は必須です");
  if (!(IMAGE_ASSET_SOURCES as readonly string[]).includes(input.sourceType)) {
    return err("invalid_input", "素材の出所が不正です");
  }
  if (sourceUrl && !/^https?:\/\//.test(sourceUrl)) return err("invalid_input", "出典URLは http(s) で始めてください");
  if (input.sourceType === "original_site" && !sourceUrl) {
    return err("invalid_input", "元サイト由来の素材には出典URLが必要です");
  }
  return inTx(db, async (tx, fail) => {
    const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, input.companyId));
    if (!company) return fail("not_found");
    const [row] = await tx
      .insert(imageAssets)
      .values({
        companyId: input.companyId,
        label,
        sourceType: input.sourceType,
        sourceUrl,
        note: input.note?.trim() || null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      })
      .returning();
    await recordEvent(tx, clock, {
      actor: ops.value,
      action: "image_asset.create",
      targetType: "company",
      targetId: input.companyId,
      after: { imageAssetId: row!.id, label, sourceType: input.sourceType, rightsStatus: "unknown" },
    });
    return row!;
  });
}

/** 権利状態と営業デモ・本番の利用範囲を同時に更新する。未確認のまま利用許可は出せない。 */
export async function updateImageAssetPolicy(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: {
    companyId: string;
    imageAssetId: string;
    rightsStatus: ImageAssetRightsStatus;
    allowSalesDemo: boolean;
    allowProduction: boolean;
    note?: string;
    placement?: "reference" | "hero" | "logo";
    expectedRevision?: number;
  },
): Promise<Result<ImageAsset, string>> {
  if (
    !isUuid(input.companyId) ||
    !isUuid(input.imageAssetId) ||
    (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0))
  )
    return err("invalid_input");
  const ops = authorizeCompanyManage(actor, input.companyId);
  if (!ops.ok) return ops;
  if (!(IMAGE_RIGHTS_STATUSES as readonly string[]).includes(input.rightsStatus)) {
    return err("invalid_input", "権利状態が不正です");
  }
  if (input.rightsStatus === "unknown" && (input.allowSalesDemo || input.allowProduction)) {
    return err("rights_unconfirmed", "権利未確認の素材は評価参照にしか使えません");
  }
  if (input.placement !== undefined && !["reference", "hero", "logo"].includes(input.placement))
    return err("invalid_input", "配置先が不正です");
  return inTx(db, async (tx, fail) => {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .for("update");
    if (!company) return fail("not_found");
    const locked = await tx
      .select()
      .from(imageAssets)
      .where(eq(imageAssets.companyId, input.companyId))
      .orderBy(asc(imageAssets.id))
      .for("update");
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, ops.value.userId), eq(users.role, "ops"), eq(users.status, "active")))
      .for("share");
    if (!user) return fail("forbidden");
    const before = locked.find((a) => a.id === input.imageAssetId);
    if (!before) return fail("not_found");
    if (input.expectedRevision !== undefined && before.policyRevision !== input.expectedRevision)
      return fail("conflict", "別の担当が素材を更新しました。最新の画像と許諾を確認してから更新してください");
    const [submission] = await tx
      .select()
      .from(imageSubmissions)
      .where(eq(imageSubmissions.assetId, before.id))
      .for("share");
    if (
      submission &&
      (input.allowSalesDemo ||
        input.allowProduction ||
        (input.placement !== undefined && input.placement !== "reference")) &&
      (submission.status !== "accepted" ||
        (input.allowSalesDemo && !submission.requestedDemo) ||
        (input.allowProduction && !submission.requestedProduction))
    )
      return fail(
        "customer_scope",
        "顧客提出の確認結果と許可された用途を確認してください。未確認・取り下げ済みの画像は利用できません",
      );
    const placement = input.placement ?? before.placement;
    const note = input.note?.trim() || null;
    const confirmed = input.rightsStatus !== "unknown";
    // Saving unchanged values must not invalidate proposals pinned to this permission revision.
    // Keep this after authorization, optimistic concurrency, and customer-scope checks.
    if (
      placement === before.placement &&
      input.rightsStatus === before.rightsStatus &&
      input.allowSalesDemo === before.allowSalesDemo &&
      input.allowProduction === before.allowProduction &&
      note === before.note &&
      (confirmed ? !!before.confirmedBy && !!before.confirmedAt : !before.confirmedBy && !before.confirmedAt)
    )
      return before;
    const replaced =
      placement !== "reference" ? locked.filter((a) => a.id !== before.id && a.placement === placement) : [];
    for (const a of replaced)
      await tx
        .update(imageAssets)
        .set({ placement: "reference", policyRevision: a.policyRevision + 1, updatedAt: clock.now() })
        .where(eq(imageAssets.id, a.id));
    const [after] = await tx
      .update(imageAssets)
      .set({
        placement,
        policyRevision: before.policyRevision + 1,
        rightsStatus: input.rightsStatus,
        allowSalesDemo: input.allowSalesDemo,
        allowProduction: input.allowProduction,
        confirmedBy: confirmed ? ops.value.userId : null,
        confirmedAt: confirmed ? clock.now() : null,
        note,
        updatedAt: clock.now(),
      })
      .where(eq(imageAssets.id, before.id))
      .returning();
    await recordEvent(tx, clock, {
      actor: ops.value,
      action: "image_asset.policy_update",
      targetType: "company",
      targetId: input.companyId,
      before: {
        imageAssetId: before.id,
        placement: before.placement,
        rightsStatus: before.rightsStatus,
        allowSalesDemo: before.allowSalesDemo,
        allowProduction: before.allowProduction,
      },
      after: {
        imageAssetId: before.id,
        placement,
        replacedPlacementAssetIds: replaced.map((a) => a.id),
        rightsStatus: input.rightsStatus,
        allowSalesDemo: input.allowSalesDemo,
        allowProduction: input.allowProduction,
      },
    });
    return after!;
  });
}

// ───────────── 2. 診断・生成・レビュー・営業可能化 ─────────────

/**
 * 提案版のレビュー（運営確認）。in_review の版だけを承認・差し戻しできる。
 * 承認しただけでは営業可能にしない（販売条件・報酬条件の確認が別に要る、makeSellable）。
 */
export async function reviewProposalVersion(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { proposalVersionId: string; decision: "approved" | "rejected"; note?: string },
): Promise<Result<typeof proposalVersions.$inferSelect, string>> {
  const ops = requireOps(actor);
  if (!ops.ok) return ops;
  if (input.decision !== "approved" && input.decision !== "rejected") return err("invalid_input", "判定が不正です");
  const note = input.note?.trim() || null;
  if (input.decision === "rejected" && !note) return err("invalid_input", "差し戻しの理由を入力してください");
  return inTx(db, async (tx, fail) => {
    const [target] = await tx
      .select({ proposalId: proposalVersions.proposalId, companyId: proposals.companyId })
      .from(proposalVersions)
      .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
      .where(eq(proposalVersions.id, input.proposalVersionId));
    if (!target) return fail("not_found");
    // Lock the proposal parent before any version, then its company. A joined FOR UPDATE
    // can otherwise retain a version lock while waiting for its proposal parent.
    await tx.select({ id: proposals.id }).from(proposals).where(eq(proposals.id, target.proposalId)).for("update");
    await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, target.companyId))
      .for("no key update");
    const [row] = await tx
      .select({ version: proposalVersions, companyId: proposals.companyId })
      .from(proposalVersions)
      .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
      .where(eq(proposalVersions.id, input.proposalVersionId))
      .for("update");
    if (!row) return fail("not_found");
    const auth = authorizeUser(ops.value, "manage", {
      type: "company",
      companyId: row.companyId,
      sellable: false,
      assignedUserId: null,
    });
    if (!auth.ok) return fail(auth.error, auth.message);
    const before = row.version;
    const [latest] = await tx
      .select({ id: proposalVersions.id })
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, before.proposalId))
      .orderBy(desc(proposalVersions.version))
      .limit(1);
    if (latest?.id !== before.id)
      return fail("superseded_version", "新しい提案版があります。最新版を開いて確認してください");

    if (before.status !== "in_review") return fail("invalid_state", "運営確認待ちの版だけをレビューできます");
    if (input.decision === "approved") {
      const content = before.content as {
        designVersionId?: string;
        designSha256?: string;
        demoCheck?: { ok?: boolean };
      } | null;
      if (content?.designVersionId) {
        const [design] = await tx.select().from(designVersions).where(eq(designVersions.id, content.designVersionId));
        if (
          design?.status !== "approved" ||
          design.companyId !== row.companyId ||
          design.auditId !== before.auditId ||
          design.imageSha256 !== content.designSha256
        )
          return fail("design_not_approved", "この提案版のデザイン承認を確認できません");
        if (!content.demoCheck?.ok || !before.demoArtifactDir)
          return fail("quality_check_failed", "サイトのビルド・検査を完了してください");
        const required = [
          "会社情報の確認",
          "画像の利用許諾",
          "PC・スマホの表示",
          "リンク・問い合わせ導線",
          "既存機能の引き継ぎ",
        ];
        if (!note?.startsWith("確認済み：") || required.some((check) => !note.split("\n")[0]?.includes(check)))
          return fail("review_incomplete", "公開前の5項目を確認してください");
      }
    }
    const now = clock.now();
    const [after] = await tx
      .update(proposalVersions)
      .set({ status: input.decision, reviewedBy: ops.value.userId, reviewedAt: now, reviewNote: note })
      .where(eq(proposalVersions.id, before.id))
      .returning();
    // 提案の準備段階：差し戻しは保留（再生成待ち）にする。承認は運営確認中のまま（営業可能化は別操作）
    const [company] = await tx.select().from(companies).where(eq(companies.id, row.companyId)).for("update");
    if (company && (company.pipelineStatus === "generated" || company.pipelineStatus === "in_review")) {
      const nextPipeline = input.decision === "approved" ? "in_review" : "on_hold";
      if (nextPipeline !== company.pipelineStatus) {
        await tx
          .update(companies)
          .set({ pipelineStatus: nextPipeline, updatedAt: now })
          .where(eq(companies.id, company.id));
      }
    }
    await recordEvent(tx, clock, {
      actor: ops.value,
      action: input.decision === "approved" ? "proposal_version.approve" : "proposal_version.reject",
      targetType: "proposal_version",
      targetId: before.id,
      before: { status: before.status },
      after: { status: after!.status, note, companyId: row.companyId },
    });
    return after!;
  });
}

/** 企業の最新の提案版（版番号が最大） */
export async function latestProposalVersion(db: DbOrTx, companyId: string) {
  const [row] = await db
    .select({
      id: proposalVersions.id,
      version: proposalVersions.version,
      status: proposalVersions.status,
    })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(eq(proposals.companyId, companyId))
    .orderBy(desc(proposalVersions.version))
    .limit(1);
  return row ?? null;
}

const SELLABLE_ISSUE_TEXT: Record<SellableIssue, string> = {
  company_suppressed: "営業抑止（営業拒否・除外・既存顧客）があります",
  already_sellable: "すでに営業可能です",
  no_proposal_version: "提案版がありません",
  review_not_approved: "最新の提案版が運営確認（承認）されていません",
  terms_not_selected: "販売条件・報酬条件の版を選んでください",
  terms_not_ready: "販売条件・報酬条件が未設定または無効です",
};

export function sellableIssueText(issue: SellableIssue): string {
  return SELLABLE_ISSUE_TEXT[issue];
}

/**
 * 営業可能にする（AC-09・14章）。サーバー側で次をすべて確かめる：
 * 運営だけ／最新の提案版が承認済み／販売条件・報酬条件が設定済み（isTermsReadyForSales）／営業抑止がない。
 * 使った提案版と条件の版をsales_offersに固定し、操作履歴と一括で保存する。
 */
export async function makeSellable(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: {
    companyId: string;
    productTermsId: string | null;
    expectedProposalVersionId?: string;
    expectedCompanyUpdatedAt?: string;
    allowExisting?: boolean;
  },
): Promise<Result<Company, string>> {
  const ops = authorizeCompanyManage(actor, input.companyId);
  if (!ops.ok) return ops;
  if (
    !isUuid(ops.value.userId) ||
    !isUuid(input.companyId) ||
    (input.productTermsId !== null && !isUuid(input.productTermsId)) ||
    (input.expectedProposalVersionId !== undefined && !isUuid(input.expectedProposalVersionId)) ||
    (input.expectedCompanyUpdatedAt !== undefined &&
      (!input.expectedCompanyUpdatedAt || !Number.isFinite(Date.parse(input.expectedCompanyUpdatedAt))))
  )
    return err("invalid_input", "対象の企業・提案版・販売条件を確認してください");
  return inTx(db, async (tx, fail) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, ops.value.userId), eq(users.role, "ops"), eq(users.status, "active")))
      .for("share");
    if (!user) return fail("forbidden", "有効な運営アカウントでログインしてください");
    // Match review's parent-before-company order; also blocks insertion of a new proposal version.
    await tx.select({ id: proposals.id }).from(proposals).where(eq(proposals.companyId, input.companyId)).for("update");
    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("update");
    if (!company) return fail("not_found");
    if (await findSalesContract(tx, company.id))
      return fail("company_contracted", "契約確認中または契約済みのため、営業へ引き継げません");
    const latest = await latestProposalVersion(tx, company.id);
    if (input.expectedProposalVersionId && latest?.id !== input.expectedProposalVersionId.toLowerCase())
      return fail("proposal_changed", "確認した提案版から更新されています。最新版を確認して選び直してください");
    let terms: typeof productTerms.$inferSelect | null = null;
    if (input.productTermsId) {
      const [t] = await tx.select().from(productTerms).where(eq(productTerms.id, input.productTermsId)).for("share");
      if (!t) return fail("terms_not_found", "販売条件・報酬条件の版が見つかりません");
      terms = t;
    }
    const [previousOffer] = await tx
      .select()
      .from(salesOffers)
      .where(and(eq(salesOffers.companyId, company.id), eq(salesOffers.isPublic, true)))
      .orderBy(desc(salesOffers.version))
      .limit(1);
    const issues = sellableIssues({ company, latestVersion: latest, terms }).filter(
      (issue) => issue !== "already_sellable" || !!previousOffer,
    );
    if (
      input.allowExisting &&
      issues.length === 1 &&
      issues[0] === "already_sellable" &&
      input.expectedProposalVersionId
    ) {
      if (previousOffer?.proposalVersionId === latest?.id && previousOffer?.productTermsId === terms?.id)
        return company;
    }
    if (
      input.expectedCompanyUpdatedAt !== undefined &&
      company.updatedAt.getTime() !== Date.parse(input.expectedCompanyUpdatedAt)
    )
      return fail("company_changed", "企業の状態が更新されています。現在の内容を確認して選び直してください");
    if (issues.length > 0) return fail(issues[0]!, issues.map(sellableIssueText).join(" / "));
    const now = clock.now();
    const [offer] = await tx
      .insert(salesOffers)
      .values({
        companyId: company.id,
        version: await nextSalesOfferVersion(tx, company.id),
        productTermsId: terms!.id,
        proposalVersionId: latest!.id,
        createdBy: ops.value.userId,
        createdAt: now,
      })
      .returning();
    const [after] = await tx
      .update(companies)
      .set({ pipelineStatus: "sellable", updatedAt: now })
      .where(eq(companies.id, company.id))
      .returning();
    await recordEvent(tx, clock, {
      actor: ops.value,
      action: "company.make_sellable",
      targetType: "company",
      targetId: company.id,
      before: { pipelineStatus: company.pipelineStatus },
      after: {
        pipelineStatus: "sellable",
        proposalVersionId: latest!.id,
        proposalVersion: latest!.version,
        productTermsId: terms!.id,
        productTermsVersion: terms!.version,
        salesOfferId: offer!.id,
      },
    });
    return after!;
  });
}

/** 営業可能の取り下げ（sellable → on_hold）。既存の担当には触れない */
export async function withdrawSellable(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { companyId: string; reason: string },
): Promise<Result<Company, string>> {
  const ops = authorizeCompanyManage(actor, input.companyId);
  if (!ops.ok) return ops;
  if (!input.reason.trim()) return err("invalid_input", "理由を入力してください");
  return inTx(db, async (tx, fail) => {
    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("update");
    if (!company) return fail("not_found");
    if (company.pipelineStatus !== "sellable") return fail("invalid_state", "営業可能な候補ではありません");
    const [after] = await tx
      .update(companies)
      .set({ pipelineStatus: "on_hold", updatedAt: clock.now() })
      .where(eq(companies.id, company.id))
      .returning();
    await recordEvent(tx, clock, {
      actor: ops.value,
      action: "company.withdraw_sellable",
      targetType: "company",
      targetId: company.id,
      before: { pipelineStatus: company.pipelineStatus },
      after: { pipelineStatus: "on_hold", reason: input.reason.trim() },
    });
    return after!;
  });
}

// ───────────── 3. 担当状況・営業拒否・引き継ぎ ─────────────

export const releaseAssignmentByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { assignmentId: string; reason: string },
) =>
  asOps(actor, (ops) =>
    input.reason.trim()
      ? releaseAssignment(db, clock, ops, { assignmentId: input.assignmentId, reason: input.reason.trim() })
      : Promise.resolve(err("invalid_input", "解除の理由を入力してください")),
  );

export const reassignAssignmentByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { assignmentId: string; toUserId: string; reason: string },
) =>
  asOps(actor, (ops) =>
    input.reason.trim()
      ? reassignAssignment(db, clock, ops, { ...input, reason: input.reason.trim() })
      : Promise.resolve(err("invalid_input", "付け替えの理由を入力してください")),
  );

export const extendAssignmentByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: Parameters<typeof extendAssignment>[3],
) => asOps(actor, (ops) => extendAssignment(db, clock, ops, input));

export const liftSuppressionByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { companyId: string; reason: string },
) =>
  asOps(actor, (ops) =>
    input.reason.trim()
      ? liftSuppression(db, clock, ops, { companyId: input.companyId, reason: input.reason.trim() })
      : Promise.resolve(err("invalid_input", "解除の理由を入力してください")),
  );

// ───────────── 4. 商品条件・契約確認・入金・報酬 ─────────────

export interface ProductTermsInput {
  version: string;
  name: string;
  scopeText: string;
  price: number | null;
  monthlyFee: number | null;
  rewardRule: unknown | null;
}

/**
 * 販売条件・報酬条件の版を作る。既存の版は書き換えない（契約は完了時の写しで固定、14章・AC-16）。
 * 価格・報酬条件が未設定の版も保存できるが、その版では営業可能にできない（isTermsReadyForSales）。
 */
export async function createProductTermsVersion(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: ProductTermsInput,
): Promise<Result<typeof productTerms.$inferSelect, string>> {
  const ops = requireOps(actor);
  if (!ops.ok) return ops;
  const auth = authorizeUser(ops.value, "manage", { type: "productTerms" });
  if (!auth.ok) return auth;
  const version = input.version.trim();
  const name = input.name.trim();
  if (!version || !name) return err("invalid_input", "版と名称は必須です");
  for (const [label, v] of [
    ["価格", input.price],
    ["月額", input.monthlyFee],
  ] as const) {
    if (v !== null && (!Number.isSafeInteger(v) || v < 0)) return err("invalid_input", `${label}は0以上の整数（円）`);
  }
  if (input.rewardRule !== null) {
    const rule = parseRewardRule(input.rewardRule);
    if (!rule.ok) return err("invalid_input", "報酬条件が不正です（定額は0以上の整数、割合は0〜10000の万分率）");
  }
  try {
    return await inTx(db, async (tx) => {
      const [row] = await tx
        .insert(productTerms)
        .values({
          version,
          name,
          scope: { description: input.scopeText.trim() },
          price: input.price,
          monthlyFee: input.monthlyFee,
          rewardRule: input.rewardRule,
          active: true,
          createdAt: clock.now(),
        })
        .returning();
      await recordEvent(tx, clock, {
        actor: ops.value,
        action: "product_terms.create",
        targetType: "product_terms",
        targetId: row!.id,
        after: row,
      });
      return row!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) return err("version_taken", "同じ版名が既にあります");
    throw e;
  }
}

/** 版の有効・無効を切り替える（無効の版では営業可能にできない。既存契約の写しは変わらない） */
export async function setProductTermsActive(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { productTermsId: string; active: boolean },
): Promise<Result<typeof productTerms.$inferSelect, string>> {
  const ops = requireOps(actor);
  if (!ops.ok) return ops;
  const auth = authorizeUser(ops.value, "manage", { type: "productTerms" });
  if (!auth.ok) return auth;
  return inTx(db, async (tx, fail) => {
    const [before] = await tx
      .select()
      .from(productTerms)
      .where(eq(productTerms.id, input.productTermsId))
      .for("update");
    if (!before) return fail("not_found");
    const [after] = await tx
      .update(productTerms)
      .set({ active: input.active })
      .where(eq(productTerms.id, before.id))
      .returning();
    await recordEvent(tx, clock, {
      actor: ops.value,
      action: input.active ? "product_terms.activate" : "product_terms.deactivate",
      targetType: "product_terms",
      targetId: before.id,
      before: { active: before.active },
      after: { active: input.active },
    });
    return after!;
  });
}

export const startContractReviewByOps = ({ db, clock }: OpsDeps, actor: Actor | null, contractId: string) =>
  asOps(actor, (ops) => startContractReview(db, clock, ops, { contractId }));

export const confirmContractByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: Parameters<typeof confirmContract>[3],
) => asOps(actor, (ops) => confirmContract(db, clock, ops, input));

export const rejectContractByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { contractId: string; reason: string },
) =>
  asOps(actor, (ops) =>
    input.reason.trim()
      ? rejectContract(db, clock, ops, input)
      : Promise.resolve(err("invalid_input", "差し戻しの理由を入力してください")),
  );

export const recordPaymentByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: Parameters<typeof recordPayment>[3],
) => asOps(actor, (ops) => recordPayment(db, clock, ops, input));

export const updatePaymentStatusByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { paymentId: string; status: PaymentTargetStatus },
) => asOps(actor, (ops) => updatePaymentStatus(db, clock, ops, input));

export const scheduleRewardByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { rewardId: string; scheduledFor: Date },
) => asOps(actor, (ops) => scheduleRewardPayment(db, clock, ops, input));

export const markRewardPaidByOps = ({ db, clock }: OpsDeps, actor: Actor | null, rewardId: string) =>
  asOps(actor, (ops) => markRewardPaid(db, clock, ops, { rewardId }));

export const adjustRewardByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { rewardId: string; delta: number; reason: string },
) => asOps(actor, (ops) => adjustReward(db, clock, ops, input));

export const cancelRewardByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { rewardId: string; reason: string },
) => asOps(actor, (ops) => cancelReward(db, clock, ops, input));

// ───────────── 5. ドメイン希望 ─────────────

export const confirmDomainPreferenceByOps = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  id: string,
  revision: number,
) => asOps(actor, (ops) => confirmDomainPreference(db, clock, ops, { id, revision }));

// ───────────── 6. 設定・操作履歴・利用停止 ─────────────

/** 運営が画面から変更できる設定と、受け付ける範囲（整数） */
export const EDITABLE_SETTINGS: Record<SettingKey, { label: string; min: number; max: number }> = {
  "assignment.maxActivePerUser": { label: "同時担当の上限（社）", min: 1, max: 100 },
  "assignment.unstartedTimeoutHours": { label: "未着手の自動解除（時間）", min: 1, max: 24 * 90 },
  "shareLink.defaultTtlHours": { label: "提案リンクの既定の有効期間（時間）", min: 1, max: 24 * 90 },
  "session.ttlHours": { label: "ログインの有効期間（時間）", min: 1, max: 24 * 90 },
};

/** 運営設定の変更。変更前後を操作履歴に残す（同じトランザクション） */
export async function updateSetting(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { key: string; value: number },
): Promise<Result<{ key: SettingKey; value: number }, string>> {
  const ops = requireOps(actor);
  if (!ops.ok) return ops;
  const auth = authorizeUser(ops.value, "update", { type: "settings" });
  if (!auth.ok) return auth;
  if (!Object.hasOwn(EDITABLE_SETTINGS, input.key)) return err("invalid_input", "変更できない設定です");
  const key = input.key as SettingKey;
  const rule = EDITABLE_SETTINGS[key];
  if (!Number.isSafeInteger(input.value) || input.value < rule.min || input.value > rule.max) {
    return err("invalid_input", `${rule.label}は${rule.min}〜${rule.max}の整数で入力してください`);
  }
  return inTx(db, async (tx) => {
    const [row] = await tx.select().from(appSettings).where(eq(appSettings.key, key)).for("update");
    const before = (row?.value ?? DEFAULT_SETTINGS[key]) as number;
    const now = clock.now();
    await tx
      .insert(appSettings)
      .values({ key, value: input.value, updatedBy: ops.value.userId, updatedAt: now })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: input.value, updatedBy: ops.value.userId, updatedAt: now },
      });
    await recordEvent(tx, clock, {
      actor: ops.value,
      action: "settings.update",
      targetType: "settings",
      targetId: key,
      before: { value: before, default: row === undefined },
      after: { value: input.value },
    });
    return { key, value: input.value };
  });
}

export const suspendSalesUser = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { userId: string; reason?: string },
) => asOps(actor, (ops) => suspendUser(db, clock, ops, input.userId, input.reason?.trim() || undefined));

export const reactivateSalesUser = (
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { userId: string; reason?: string },
) => asOps(actor, (ops) => reactivateUser(db, clock, ops, input.userId, input.reason?.trim() || undefined));

/** 複数の企業の最新の提案版をまとめて読む（一覧での営業可能化の可否表示用） */
export async function latestProposalVersions(db: DbOrTx, companyIds: string[]) {
  if (companyIds.length === 0) return new Map<string, { id: string; version: number; status: string }>();
  const rows = await db
    .select({
      companyId: proposals.companyId,
      id: proposalVersions.id,
      version: proposalVersions.version,
      status: proposalVersions.status,
    })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(inArray(proposals.companyId, companyIds))
    .orderBy(desc(proposalVersions.version));
  const map = new Map<string, { id: string; version: number; status: string }>();
  for (const r of rows) if (!map.has(r.companyId)) map.set(r.companyId, r);
  return map;
}
