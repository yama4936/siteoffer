/**
 * 運営画面の読み取りクエリ。すべて入口で requireOps を通す（AC-17）。
 * 営業ユーザー向けの読み取り（自分の担当だけ等）とは別。運営は全件を読む。
 */
import {
  type Actor,
  authorizeUser,
  DEFAULT_SETTINGS,
  getSetting,
  listOpsConsultations,
  ok,
  type Result,
  type SettingKey,
} from "@siteoffer/core";
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  appSettings,
  assignments,
  auditEvents,
  companies,
  contracts,
  type DbOrTx,
  deliveries,
  discoveryJobs,
  discoverySources,
  domainPreferences,
  findings,
  generationJobs,
  imageAssetFiles,
  imageAssets,
  productTerms,
  proposals,
  proposalVersions,
  siteAudits,
  users,
  websites,
} from "@siteoffer/db";
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { EDITABLE_SETTINGS, latestProposalVersions } from "./commands";
import { attachContractFinancials } from "./contract-financials";
import { requireOps } from "./guard";

type Company = typeof companies.$inferSelect;
export type PipelineStatus = Company["pipelineStatus"];
export type OfficialSiteStatus = Company["officialSiteStatus"];

const LIST_LIMIT = 200;

function guard(actor: Actor | null): Result<void, "forbidden"> {
  const ops = requireOps(actor);
  return ops.ok ? ok(undefined) : ops;
}

// ───────────── ダッシュボード ─────────────

export async function getOpsDashboard(db: DbOrTx, actor: Actor | null) {
  const g = guard(actor);
  if (!g.ok) return g;
  const [jobsFailed] = await db.select({ n: count() }).from(discoveryJobs).where(eq(discoveryJobs.status, "failed"));
  const [needsReview] = await db
    .select({ n: count() })
    .from(companies)
    .where(eq(companies.officialSiteStatus, "needs_review"));
  const [inReview] = await db
    .select({ n: count() })
    .from(proposalVersions)
    .where(eq(proposalVersions.status, "in_review"));
  const [awaitingOps] = await db.select({ n: count() }).from(assignments).where(eq(assignments.status, "awaiting_ops"));
  const [contractsOpen] = await db
    .select({ n: count() })
    .from(contracts)
    .where(inArray(contracts.status, ["reported", "under_review"]));
  const [domainsOpen] = await db
    .select({ n: count() })
    .from(domainPreferences)
    .where(isNull(domainPreferences.confirmedAt));
  const [sellable] = await db.select({ n: count() }).from(companies).where(eq(companies.pipelineStatus, "sellable"));
  return ok({
    failedJobs: jobsFailed?.n ?? 0,
    officialSiteNeedsReview: needsReview?.n ?? 0,
    proposalsInReview: inReview?.n ?? 0,
    assignmentsAwaitingOps: awaitingOps?.n ?? 0,
    contractsOpen: contractsOpen?.n ?? 0,
    domainPreferencesUnconfirmed: domainsOpen?.n ?? 0,
    sellableCompanies: sellable?.n ?? 0,
  });
}

// ───────────── 1. 収集条件・ジョブ・候補 ─────────────

export async function listDiscoveryJobs(db: DbOrTx, actor: Actor | null) {
  const g = guard(actor);
  if (!g.ok) return g;
  const rows = await db.select().from(discoveryJobs).orderBy(desc(discoveryJobs.createdAt)).limit(LIST_LIMIT);
  return ok(rows);
}

export async function getDiscoveryJob(db: DbOrTx, actor: Actor | null, jobId: string) {
  const g = guard(actor);
  if (!g.ok) return g;
  const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId));
  if (!job) return ok(null);
  const sources = await db
    .select({ source: discoverySources, companyName: companies.name })
    .from(discoverySources)
    .leftJoin(companies, eq(companies.id, discoverySources.companyId))
    .where(eq(discoverySources.jobId, jobId))
    .orderBy(asc(discoverySources.fetchedAt))
    .limit(LIST_LIMIT);
  return ok({ job, sources });
}

export interface CompanyFilter {
  q?: string;
  prefecture?: string;
  pipelineStatus?: PipelineStatus;
  officialSiteStatus?: OfficialSiteStatus;
  suppressed?: boolean;
}

export async function listCompanies(db: DbOrTx, actor: Actor | null, filter: CompanyFilter = {}) {
  const g = guard(actor);
  if (!g.ok) return g;
  const conds: (SQL | undefined)[] = [
    filter.q
      ? or(ilike(companies.name, `%${filter.q}%`), ilike(companies.corporateNumber, `%${filter.q}%`))
      : undefined,
    filter.prefecture ? eq(companies.prefecture, filter.prefecture) : undefined,
    filter.pipelineStatus ? eq(companies.pipelineStatus, filter.pipelineStatus) : undefined,
    filter.officialSiteStatus ? eq(companies.officialSiteStatus, filter.officialSiteStatus) : undefined,
    filter.suppressed === true ? ne(companies.suppression, "none") : undefined,
    filter.suppressed === false ? eq(companies.suppression, "none") : undefined,
  ];
  const rows = await db
    .select()
    .from(companies)
    .where(and(...conds))
    .orderBy(desc(companies.updatedAt))
    .limit(LIST_LIMIT);
  return ok(rows);
}

/** 企業（候補）の詳細：サイト・出典・診断・提案版・担当・ドメイン希望 */
export async function getCompanyDetail(db: DbOrTx, actor: Actor | null, companyId: string) {
  const g = guard(actor);
  if (!g.ok) return g;
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) return ok(null);
  const sites = await db
    .select()
    .from(websites)
    .where(eq(websites.companyId, companyId))
    .orderBy(asc(websites.createdAt));
  const sources = await db
    .select()
    .from(discoverySources)
    .where(eq(discoverySources.companyId, companyId))
    .orderBy(desc(discoverySources.fetchedAt));
  const audits = await db
    .select()
    .from(siteAudits)
    .where(eq(siteAudits.companyId, companyId))
    .orderBy(desc(siteAudits.createdAt));
  const latestAudit = audits[0] ?? null;
  const auditFindings = latestAudit
    ? await db.select().from(findings).where(eq(findings.auditId, latestAudit.id)).orderBy(asc(findings.itemCode))
    : [];
  const versions = await db
    .select({ v: proposalVersions })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(eq(proposals.companyId, companyId))
    .orderBy(desc(proposalVersions.version));
  const jobs = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.companyId, companyId))
    .orderBy(desc(generationJobs.createdAt))
    .limit(20);
  const assets = await db
    .select({
      asset: imageAssets,
      confirmerName: users.displayName,
      file: {
        assetId: imageAssetFiles.assetId,
        width: imageAssetFiles.width,
        height: imageAssetFiles.height,
        byteSize: imageAssetFiles.byteSize,
      },
    })
    .from(imageAssets)
    .leftJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
    .leftJoin(users, eq(users.id, imageAssets.confirmedBy))
    .where(eq(imageAssets.companyId, companyId))
    .orderBy(desc(imageAssets.createdAt));
  const assignmentRows = await db
    .select({ a: assignments, userName: users.displayName })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(eq(assignments.companyId, companyId))
    .orderBy(desc(assignments.claimedAt));
  return ok({
    company,
    websites: sites,
    sources,
    audits,
    latestAudit,
    findings: auditFindings,
    proposalVersions: versions.map((r) => r.v),
    generationJobs: jobs,
    imageAssets: assets,
    assignments: assignmentRows,
  });
}

// ───────────── 2. 診断・生成・レビュー・営業可能化 ─────────────

/** 運営確認待ちの提案版と、承認済みで営業可能化を待つ候補 */
export async function listReviewQueue(db: DbOrTx, actor: Actor | null) {
  const g = guard(actor);
  if (!g.ok) return g;
  const inReview = await db
    .select({
      v: proposalVersions,
      companyId: companies.id,
      companyName: companies.name,
      pipelineStatus: companies.pipelineStatus,
    })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .innerJoin(companies, eq(companies.id, proposals.companyId))
    .where(
      and(
        eq(proposalVersions.status, "in_review"),
        eq(companies.suppression, "none"),
        sql`not exists(select 1 from proposal_versions newer where newer.proposal_id=${proposalVersions.proposalId} and newer.version>${proposalVersions.version})`,
      ),
    )
    .orderBy(asc(proposalVersions.createdAt))
    .limit(LIST_LIMIT);
  // 営業可能化の候補：営業可能でなく、抑止がなく、承認済みの版がある企業
  const approvedCompanies = await db
    .selectDistinct({ company: companies })
    .from(companies)
    .innerJoin(proposals, eq(proposals.companyId, companies.id))
    .innerJoin(proposalVersions, eq(proposalVersions.proposalId, proposals.id))
    .where(
      and(
        eq(proposalVersions.status, "approved"),
        sql`not exists(select 1 from proposal_versions newer where newer.proposal_id=${proposalVersions.proposalId} and newer.version>${proposalVersions.version})`,
        ne(companies.pipelineStatus, "sellable"),
        eq(companies.suppression, "none"),
      ),
    )
    .limit(LIST_LIMIT);
  const latest = await latestProposalVersions(
    db,
    approvedCompanies.map((r) => r.company.id),
  );
  const terms = await db
    .select()
    .from(productTerms)
    .where(eq(productTerms.active, true))
    .orderBy(desc(productTerms.createdAt));
  return ok({
    inReview,
    readyCandidates: approvedCompanies.map((r) => ({
      company: r.company,
      latestVersion: latest.get(r.company.id) ?? null,
    })),
    activeTerms: terms,
  });
}

export async function listProductTerms(db: DbOrTx, actor: Actor | null) {
  const g = guard(actor);
  if (!g.ok) return g;
  return ok(await db.select().from(productTerms).orderBy(desc(productTerms.createdAt)));
}

// ───────────── 3. 担当状況・営業拒否・引き継ぎ ─────────────

export async function listAssignmentsOverview(
  db: DbOrTx,
  actor: Actor | null,
  filter: { includeClosed?: boolean; id?: string } = {},
) {
  const g = guard(actor);
  if (!g.ok) return g;
  const rows = await db
    .select({
      a: assignments,
      companyName: companies.name,
      suppression: companies.suppression,
      userName: users.displayName,
      userStatus: users.status,
    })
    .from(assignments)
    .innerJoin(companies, eq(companies.id, assignments.companyId))
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(
      and(
        filter.id ? eq(assignments.id, filter.id) : undefined,
        filter.includeClosed ? undefined : inArray(assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES]),
      ),
    )
    .orderBy(desc(assignments.claimedAt))
    .limit(LIST_LIMIT);
  return ok(rows);
}

export async function listSuppressedCompanies(db: DbOrTx, actor: Actor | null) {
  const g = guard(actor);
  if (!g.ok) return g;
  return ok(
    await db
      .select()
      .from(companies)
      .where(ne(companies.suppression, "none"))
      .orderBy(desc(companies.suppressionUpdatedAt))
      .limit(LIST_LIMIT),
  );
}

/** 運営への相談（core の listOpsConsultations）に企業名・営業ユーザー名を付ける */
export async function listConsultations(db: DbOrTx, actor: Actor | null) {
  const ops = requireOps(actor);
  if (!ops.ok) return ops;
  const r = await listOpsConsultations(db, ops.value);
  if (!r.ok) return r;
  const list = r.value.slice(0, LIST_LIMIT);
  const companyIds = [...new Set(list.map((x) => x.companyId))];
  const userIds = [...new Set(list.map((x) => x.userId))];
  const cs = companyIds.length
    ? await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : [];
  const us = userIds.length
    ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, userIds))
    : [];
  const cName = new Map(cs.map((c) => [c.id, c.name]));
  const uName = new Map(us.map((u) => [u.id, u.name]));
  return ok(
    list.map((x) => ({ activity: x, companyName: cName.get(x.companyId) ?? "", userName: uName.get(x.userId) ?? "" })),
  );
}

/** 付け替え先に選べる営業ユーザー（利用中のみ） */
export async function listActiveSalesUsers(db: DbOrTx, actor: Actor | null) {
  const g = guard(actor);
  if (!g.ok) return g;
  return ok(
    await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(and(eq(users.role, "sales"), eq(users.status, "active")))
      .orderBy(asc(users.displayName)),
  );
}

// ───────────── 4. 契約確認・入金・報酬 ─────────────

export async function listContractsOverview(db: DbOrTx, actor: Actor | null, filter: { id?: string } = {}) {
  const g = guard(actor);
  if (!g.ok) return g;
  const rows = await db
    .select({ c: contracts, companyName: companies.name, salesName: users.displayName })
    .from(contracts)
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .innerJoin(users, eq(users.id, contracts.salesUserId))
    .where(filter.id ? eq(contracts.id, filter.id) : undefined)
    .orderBy(desc(contracts.reportedAt))
    .limit(LIST_LIMIT);
  return ok(await attachContractFinancials(db, rows));
}

// ───────────── 5. 制作・ドメイン希望 ─────────────

export async function listDomainPreferencesForOps(db: DbOrTx, actor: Actor | null, filter: { id?: string } = {}) {
  const g = guard(actor);
  if (!g.ok) return g;
  const auth = authorizeUser(actor, "read", { type: "domainPreference", ownerUserId: null });
  if (!auth.ok) return auth;
  const rows = await db
    .select({ d: domainPreferences, companyName: companies.name, recordedByName: users.displayName })
    .from(domainPreferences)
    .innerJoin(companies, eq(companies.id, domainPreferences.companyId))
    .innerJoin(users, eq(users.id, domainPreferences.recordedBy))
    .where(filter.id ? eq(domainPreferences.id, filter.id) : undefined)
    // 件数制限の前に未確認・古い順へ並べる。新しい確認済み行で未対応を押し出さない。
    .orderBy(desc(isNull(domainPreferences.confirmedAt)), asc(domainPreferences.updatedAt), asc(domainPreferences.id))
    .limit(LIST_LIMIT);
  return ok(rows);
}

/** 納品の一覧（入口だけ。状態遷移はT14） */
export async function listDeliveriesForOps(db: DbOrTx, actor: Actor | null) {
  const g = guard(actor);
  if (!g.ok) return g;
  return ok(
    await db
      .select({ d: deliveries, companyName: companies.name, contractStatus: contracts.status })
      .from(deliveries)
      .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
      .innerJoin(companies, eq(companies.id, contracts.companyId))
      .orderBy(desc(deliveries.createdAt))
      .limit(LIST_LIMIT),
  );
}

// ───────────── 6. 設定・操作履歴・ユーザー ─────────────

export async function getSettingsForOps(db: DbOrTx, actor: Actor | null) {
  const g = guard(actor);
  if (!g.ok) return g;
  const auth = authorizeUser(actor, "read", { type: "settings" });
  if (!auth.ok) return auth;
  const stored = await db.select().from(appSettings);
  const byKey = new Map(stored.map((s) => [s.key, s]));
  const keys = Object.keys(DEFAULT_SETTINGS) as SettingKey[];
  const out = [];
  for (const key of keys) {
    out.push({
      key,
      label: EDITABLE_SETTINGS[key].label,
      min: EDITABLE_SETTINGS[key].min,
      max: EDITABLE_SETTINGS[key].max,
      value: (await getSetting(db, key)) as number,
      defaultValue: DEFAULT_SETTINGS[key] as number,
      updatedAt: byKey.get(key)?.updatedAt ?? null,
    });
  }
  return ok(out);
}

export async function listAuditEventsForOps(
  db: DbOrTx,
  actor: Actor | null,
  filter: { targetType?: string; targetId?: string; actionPrefix?: string; limit?: number } = {},
) {
  const g = guard(actor);
  if (!g.ok) return g;
  const auth = authorizeUser(actor, "read", { type: "auditLog" });
  if (!auth.ok) return auth;
  const rows = await db
    .select({ e: auditEvents, actorName: users.displayName })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorId))
    .where(
      and(
        filter.targetType ? eq(auditEvents.targetType, filter.targetType) : undefined,
        filter.targetId ? eq(auditEvents.targetId, filter.targetId) : undefined,
        filter.actionPrefix ? ilike(auditEvents.action, `${filter.actionPrefix}%`) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(Math.min(filter.limit ?? LIST_LIMIT, 500));
  return ok(rows);
}

/** アカウント管理の一覧。filter は役割・状態の絞り込み（省略時は全件） */
export async function listUsersForOps(
  db: DbOrTx,
  actor: Actor | null,
  filter: { role?: "sales" | "ops" | "customer"; status?: "active" | "suspended" } = {},
) {
  const g = guard(actor);
  if (!g.ok) return g;
  const auth = authorizeUser(actor, "list", { type: "user", userId: "", role: "sales" });
  if (!auth.ok) return auth;
  const conditions: SQL[] = [];
  if (filter.role) conditions.push(eq(users.role, filter.role));
  if (filter.status) conditions.push(eq(users.status, filter.status));
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(users.role), asc(users.createdAt));
  const activeCounts = await db
    .select({ userId: assignments.userId, n: count() })
    .from(assignments)
    .where(inArray(assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES]))
    .groupBy(assignments.userId);
  const byUser = new Map(activeCounts.map((r) => [r.userId, r.n]));
  return ok(rows.map((u) => ({ ...u, activeAssignments: byUser.get(u.id) ?? 0 })));
}
