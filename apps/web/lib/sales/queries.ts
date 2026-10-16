/**
 * 営業画面の読み取りクエリ（サーバー側専用）。
 * - 他の営業ユーザーの非公開情報（担当者・活動・契約・報酬）は返さない（5.1・AC-17）。
 *   他人の担当は「担当中かどうか」だけを返す。
 * - 企業一覧は営業可能（pipelineStatus = sellable）な企業だけ（16章）。
 * - 権限の判定は core の can / authorize と業務関数に任せる。ここで独自の規則を作らない。
 */
import {
  type Actor,
  authorize,
  can,
  err,
  getSalesOffer,
  isActiveStatus,
  isTermsReadyForSales,
  listActivities,
  listAssignments,
  ok,
  parseRewardRule,
  type Result,
  type RewardRule,
  requireUser,
} from "@siteoffer/core";
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  assignments,
  companies,
  contracts,
  type DbOrTx,
  domainPreferences,
  findings,
  productTerms,
  rewardAdjustments,
  rewards,
  siteAudits,
  websites,
} from "@siteoffer/db";
import { type CallScript, callScriptSchema, type ProposalText, proposalTextSchema } from "@siteoffer/schemas";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

type QueryError = "forbidden" | "not_found";

const MAX_LIST = 200;

/** URLから来たIDの形式。形式違いはDBに渡さず「見つからない」にする */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- 企業一覧 ----------

/** 企業一覧の並び順。score_asc（既定）／score_desc：最新の評価の総合点順、region：地域・企業名順 */
export const COMPANY_SORTS = ["score_asc", "score_desc", "region"] as const;
export type CompanySort = (typeof COMPANY_SORTS)[number];

export const parseCompanySort = (v: string | undefined): CompanySort =>
  (COMPANY_SORTS as readonly string[]).includes(v ?? "") ? (v as CompanySort) : "score_asc";

export interface CompanyListFilter {
  prefecture?: string | undefined;
  city?: string | undefined;
  industry?: string | undefined;
  sort?: CompanySort | undefined;
}

/** 担当の共通状態。他人の担当は誰が持っているかを返さない */
export type SharedAssignmentState = "mine" | "other" | "none";

export interface CompanyListItem {
  id: string;
  name: string;
  prefecture: string | null;
  city: string | null;
  industry: string | null;
  suppression: string;
  assignment: SharedAssignmentState;
  /** 自分の担当のときだけ */
  myAssignmentId: string | null;
  siteUrl: string | null;
  /** 最新の評価（evaluated／unevaluable）の総合点。未評価・評価不能・カバー率不足はnull */
  totalScore: string | null;
  scoreConfirmed: boolean | null;
}

/** 空白だけの値は「指定なし」にする */
const clean = (v: string | undefined) => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** 有効な担当（企業ごとに最大1件）。担当者のIDは呼び出し側で自分かどうかの判定だけに使う */
async function activeAssignmentsByCompany(db: DbOrTx, companyIds: string[]) {
  if (companyIds.length === 0) return new Map<string, { id: string; userId: string; salesOfferId: string | null }>();
  const rows = await db
    .select({
      id: assignments.id,
      userId: assignments.userId,
      companyId: assignments.companyId,
      salesOfferId: assignments.salesOfferId,
    })
    .from(assignments)
    .where(
      and(inArray(assignments.companyId, companyIds), inArray(assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES])),
    );
  return new Map(rows.map((r) => [r.companyId, { id: r.id, userId: r.userId, salesOfferId: r.salesOfferId }]));
}

function sharedState(actorUserId: string, a: { id: string; userId: string } | undefined) {
  if (!a) return { assignment: "none" as const, myAssignmentId: null };
  return a.userId === actorUserId
    ? { assignment: "mine" as const, myAssignmentId: a.id }
    : { assignment: "other" as const, myAssignmentId: null };
}

async function primarySiteUrls(db: DbOrTx, companyIds: string[]): Promise<Map<string, string>> {
  if (companyIds.length === 0) return new Map();
  const rows = await db
    .select({ companyId: websites.companyId, url: websites.url, isPrimary: websites.isPrimary })
    .from(websites)
    .where(and(inArray(websites.companyId, companyIds), eq(websites.kind, "current")))
    .orderBy(desc(websites.isPrimary), asc(websites.createdAt));
  const map = new Map<string, string>();
  for (const r of rows) if (!map.has(r.companyId)) map.set(r.companyId, r.url);
  return map;
}

/** 営業可能な企業の一覧（地域・業種で絞り込み）。URL登録の入口は持たない（F-05） */
export async function listSellableCompanies(
  db: DbOrTx,
  actor: Actor | null,
  filter: CompanyListFilter = {},
): Promise<Result<CompanyListItem[], "forbidden">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const prefecture = clean(filter.prefecture);
  const city = clean(filter.city);
  const industry = clean(filter.industry);
  // 企業ごとの最新の評価（企業詳細と同じ条件）。点数順でも上限件数の前に並べるためSQLで結合する
  const latestAudit = db
    .selectDistinctOn([siteAudits.companyId], {
      companyId: siteAudits.companyId,
      totalScore: siteAudits.totalScore,
      scoreConfirmed: siteAudits.scoreConfirmed,
    })
    .from(siteAudits)
    .where(inArray(siteAudits.status, ["evaluated", "unevaluable"]))
    .orderBy(siteAudits.companyId, desc(siteAudits.createdAt))
    .as("latest_audit");
  const regionOrder = [asc(companies.prefecture), asc(companies.city), asc(companies.name)];
  // 点数のない企業（未評価・評価不能）は低評価に置き換えず、どちらの並びでも末尾に置く
  const sort = filter.sort ?? "score_asc";
  const order =
    sort === "score_asc"
      ? [sql`${latestAudit.totalScore} asc nulls last`, ...regionOrder]
      : sort === "score_desc"
        ? [sql`${latestAudit.totalScore} desc nulls last`, ...regionOrder]
        : regionOrder;
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      prefecture: companies.prefecture,
      city: companies.city,
      industry: companies.industry,
      suppression: companies.suppression,
      totalScore: latestAudit.totalScore,
      scoreConfirmed: latestAudit.scoreConfirmed,
    })
    .from(companies)
    .leftJoin(latestAudit, eq(latestAudit.companyId, companies.id))
    .where(
      and(
        eq(companies.pipelineStatus, "sellable"),
        prefecture ? eq(companies.prefecture, prefecture) : undefined,
        city ? eq(companies.city, city) : undefined,
        industry ? eq(companies.industry, industry) : undefined,
      ),
    )
    .orderBy(...order)
    .limit(MAX_LIST);

  const ids = rows.map((r) => r.id);
  const [active, sites] = await Promise.all([activeAssignmentsByCompany(db, ids), primarySiteUrls(db, ids)]);
  const items: CompanyListItem[] = [];
  for (const r of rows) {
    const a = active.get(r.id);
    // 共通状態（担当中か・営業拒否）は営業に常に見せてよい（read_shared）
    if (
      !can(user.value, "read_shared", {
        type: "company",
        companyId: r.id,
        sellable: true,
        assignedUserId: a?.userId ?? null,
      })
    )
      continue;
    items.push({ ...r, ...sharedState(user.value.userId, a), siteUrl: sites.get(r.id) ?? null });
  }
  return ok(items);
}

export interface CompanyFilterOptions {
  prefectures: string[];
  cities: { prefecture: string | null; city: string }[];
  industries: string[];
}

/** 絞り込みの選択肢（営業可能な企業にある値だけ） */
export async function getCompanyFilterOptions(db: DbOrTx): Promise<CompanyFilterOptions> {
  const rows = await db
    .selectDistinct({ prefecture: companies.prefecture, city: companies.city, industry: companies.industry })
    .from(companies)
    .where(eq(companies.pipelineStatus, "sellable"));
  const prefectures = new Set<string>();
  const cities = new Map<string, { prefecture: string | null; city: string }>();
  const industries = new Set<string>();
  for (const r of rows) {
    if (r.prefecture) prefectures.add(r.prefecture);
    if (r.city) cities.set(`${r.prefecture ?? ""}/${r.city}`, { prefecture: r.prefecture, city: r.city });
    if (r.industry) industries.add(r.industry);
  }
  const ja = (a: string, b: string) => a.localeCompare(b, "ja");
  return {
    prefectures: [...prefectures].sort(ja),
    cities: [...cities.values()].sort((a, b) => ja(`${a.prefecture}${a.city}`, `${b.prefecture}${b.city}`)),
    industries: [...industries].sort(ja),
  };
}

// ---------- 販売条件・報酬条件 ----------

export interface TermsView {
  id: string;
  name: string;
  version: string;
  price: number | null;
  monthlyFee: number | null;
  scope?: string;
  reward: RewardRule | null;
  /** 販売条件・報酬条件の両方が設定済みか（14章） */
  ready: boolean;
}

/** 有効な販売条件と報酬条件（営業は read だけ可能） */
export async function listActiveTerms(db: DbOrTx, actor: Actor | null): Promise<Result<TermsView[], "forbidden">> {
  const auth = authorize(actor, "read", { type: "productTerms" });
  if (!auth.ok) return err("forbidden");
  const rows = await db
    .select()
    .from(productTerms)
    .where(eq(productTerms.active, true))
    .orderBy(asc(productTerms.version));
  return ok(
    rows.map((t) => {
      const rule = parseRewardRule(t.rewardRule);
      return {
        id: t.id,
        name: t.name,
        version: t.version,
        price: t.price,
        monthlyFee: t.monthlyFee,
        reward: rule.ok ? rule.value : null,
        ready: isTermsReadyForSales(t),
      };
    }),
  );
}

function offerTerms(bound: NonNullable<Awaited<ReturnType<typeof getSalesOffer>>>): TermsView {
  const t = bound.terms;
  const rule = parseRewardRule(t.rewardRule);
  const scope = t.scope as { description?: unknown };
  return {
    id: t.id,
    name: t.name,
    version: t.version,
    price: t.price,
    monthlyFee: t.monthlyFee,
    reward: rule.ok ? rule.value : null,
    scope: typeof scope?.description === "string" ? scope.description : "詳しい提供範囲は運営に確認してください",
    ready: isTermsReadyForSales({ ...t, active: true }),
  };
}

// ---------- 企業詳細 ----------

export interface Observation {
  fact: string;
  url: string | null;
  evidence: string | null;
}

export interface FindingView {
  itemCode: string;
  category: string;
  status: string;
  score: number | null;
  reason: string | null;
  observations: Observation[];
  improvementHint: string | null;
  /** true なら推測（観測事実ではない） */
  inference: boolean;
  critical: boolean;
}

export interface CompanyDetail {
  company: {
    id: string;
    name: string;
    prefecture: string | null;
    city: string | null;
    address: string | null;
    industry: string | null;
    representativePhone: string | null;
    suppression: string;
    recontactAfter: Date | null;
  };
  sites: { url: string; domain: string; isPrimary: boolean }[];
  assignment: SharedAssignmentState;
  myAssignmentId: string | null;
  /** 確保ボタンを出すか（表示用。確保できるかの判定は claimAssignment が行う） */
  showClaim: boolean;
  salesOfferId: string | null;
  audit: {
    id: string;
    status: string;
    targetUrl: string;
    finalUrl: string | null;
    totalScore: string | null;
    scoreConfirmed: boolean | null;
    evaluatedAt: Date | null;
    unevaluableReason: string | null;
    findings: FindingView[];
  } | null;
  proposal: {
    versionId: string;
    version: number;
    /** 改善デモの成果物があるか。企業に見せるURLは共有リンク（lib/sales/share.ts）で発行する */
    hasDemo: boolean;
    hasDesignPdf: boolean;
    isMock: boolean;
    proposalText: ProposalText | null;
    callScript: CallScript | null;
  } | null;
  terms: TermsView[];
}

function toObservations(raw: unknown): Observation[] {
  if (!Array.isArray(raw)) return [];
  const out: Observation[] = [];
  for (const o of raw) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    if (typeof r.fact !== "string" || r.fact.length === 0) continue;
    out.push({
      fact: r.fact,
      url: typeof r.url === "string" ? r.url : null,
      evidence: typeof r.evidence === "string" ? r.evidence : null,
    });
  }
  return out;
}

/**
 * 提案版の content から、検証に通るものだけを取り出す。
 * content のキー名は生成パイプライン（T11）で確定するため、camelCase と snake_case の両方を受け付ける。
 */
function pickContent<T>(
  content: unknown,
  keys: string[],
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): T | null {
  if (!content || typeof content !== "object") return null;
  const c = content as Record<string, unknown>;
  for (const k of keys) {
    if (k in c) {
      const r = schema.safeParse(c[k]);
      return r.success ? r.data : null;
    }
  }
  return null;
}

/**
 * 企業詳細と同じ条件（can の company.read：営業可能な企業か自分の担当企業）で企業を読む。
 * 見られない企業・形式違いのIDは not_found（存在も明かさない）、未ログインは forbidden。
 * 改良資料・改善後サイト（lib/sales/improvement.ts）も同じ判定を使う。
 */
export async function findReadableCompany(db: DbOrTx, actor: Actor | null, companyId: string) {
  const user = requireUser(actor);
  if (!user.ok) return user;
  if (!UUID_RE.test(companyId)) return err("not_found");
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) return err("not_found");
  const active = (await activeAssignmentsByCompany(db, [company.id])).get(company.id);
  const resource = {
    type: "company" as const,
    companyId: company.id,
    sellable: company.pipelineStatus === "sellable",
    assignedUserId: active?.userId ?? null,
  };
  // 見られない企業は存在も明かさない
  if (!can(user.value, "read", resource)) return err("not_found");
  return ok({ user: user.value, company, active, resource });
}

/** 企業詳細。営業可能な企業か自分の担当企業だけ（can の company.read） */
export async function getCompanyDetail(
  db: DbOrTx,
  actor: Actor | null,
  companyId: string,
): Promise<Result<CompanyDetail, QueryError>> {
  const found = await findReadableCompany(db, actor, companyId);
  if (!found.ok) return found;
  const { user: viewer, company, active, resource } = found.value;
  const shared = sharedState(viewer.userId, active);

  const sites = await db
    .select({ url: websites.url, domain: websites.domain, isPrimary: websites.isPrimary })
    .from(websites)
    .where(and(eq(websites.companyId, company.id), eq(websites.kind, "current")))
    .orderBy(desc(websites.isPrimary), asc(websites.createdAt));

  const [audit] = await db
    .select()
    .from(siteAudits)
    .where(and(eq(siteAudits.companyId, company.id), inArray(siteAudits.status, ["evaluated", "unevaluable"])))
    .orderBy(desc(siteAudits.createdAt))
    .limit(1);
  const findingRows = audit
    ? await db.select().from(findings).where(eq(findings.auditId, audit.id)).orderBy(asc(findings.itemCode))
    : [];

  const mine = active?.userId === viewer.userId ? active : null;
  const bound = await getSalesOffer(db, company.id, mine?.salesOfferId);
  const pv = bound?.proposal ?? null;
  const terms = bound ? [offerTerms(bound)] : [];

  return ok({
    company: {
      id: company.id,
      name: company.name,
      prefecture: company.prefecture,
      city: company.city,
      address: company.address,
      industry: company.industry,
      representativePhone: company.representativePhone,
      suppression: company.suppression,
      recontactAfter: company.recontactAfter,
    },
    sites,
    salesOfferId: bound?.offer.id ?? null,
    ...shared,
    showClaim:
      viewer.kind === "sales" &&
      shared.assignment === "none" &&
      !!bound &&
      isTermsReadyForSales(bound.terms) &&
      bound.proposal.status === "approved" &&
      company.suppression === "none" &&
      can(viewer, "claim", resource),
    audit: audit
      ? {
          id: audit.id,
          status: audit.status,
          targetUrl: audit.targetUrl,
          finalUrl: audit.finalUrl,
          totalScore: audit.totalScore,
          scoreConfirmed: audit.scoreConfirmed,
          evaluatedAt: audit.evaluatedAt,
          unevaluableReason: audit.unevaluableReason,
          findings: findingRows.map((f) => ({
            itemCode: f.itemCode,
            category: f.category,
            status: f.status,
            score: f.score,
            reason: f.reason,
            observations: toObservations(f.observations),
            improvementHint: f.improvementHint,
            inference: f.inference,
            critical: f.critical,
          })),
        }
      : null,
    proposal: pv
      ? {
          versionId: pv.id,
          version: pv.version,
          hasDemo: pv.demoArtifactDir !== null,
          isMock: (pv.content as { generator?: string } | null)?.generator === "mock",
          hasDesignPdf: typeof (pv.content as { designVersionId?: unknown } | null)?.designVersionId === "string",
          proposalText: pickContent(pv.content, ["proposalText"], proposalTextSchema),
          callScript: pickContent(pv.content, ["callScript"], callScriptSchema),
        }
      : null,
    terms,
  });
}

// ---------- 担当案件 ----------

export interface MyAssignmentItem {
  id: string;
  companyId: string;
  companyName: string;
  prefecture: string | null;
  city: string | null;
  status: string;
  claimedAt: Date;
  expiresAt: Date | null;
  nextActionAt: Date | null;
  lastActivityAt: Date | null;
  contractStatus: string | null;
}

/** 自分の担当の一覧。既定は有効な担当だけ。includeEnded で終了した担当も含める */
export async function listMyAssignments(
  db: DbOrTx,
  actor: Actor | null,
  opts: { includeEnded?: boolean } = {},
): Promise<Result<MyAssignmentItem[], "forbidden">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const listed = await listAssignments(db, user.value, {
    userId: user.value.userId,
    ...(opts.includeEnded ? { statuses: [...ACTIVE_ASSIGNMENT_STATUSES, "completed", "released", "lost"] } : {}),
  });
  if (!listed.ok) return listed;
  const rows = listed.value;
  if (rows.length === 0) return ok([]);
  const companyIds = [...new Set(rows.map((r) => r.companyId))];
  const companyRows = await db
    .select({ id: companies.id, name: companies.name, prefecture: companies.prefecture, city: companies.city })
    .from(companies)
    .where(inArray(companies.id, companyIds));
  const companyMap = new Map(companyRows.map((c) => [c.id, c]));
  const contractRows = await db
    .select({ assignmentId: contracts.assignmentId, status: contracts.status })
    .from(contracts)
    .where(
      and(
        inArray(
          contracts.assignmentId,
          rows.map((r) => r.id),
        ),
        eq(contracts.salesUserId, user.value.userId),
      ),
    )
    .orderBy(asc(contracts.reportedAt));
  const contractMap = new Map(contractRows.map((c) => [c.assignmentId, c.status]));
  return ok(
    rows.map((a) => {
      const c = companyMap.get(a.companyId);
      return {
        id: a.id,
        companyId: a.companyId,
        companyName: c?.name ?? "",
        prefecture: c?.prefecture ?? null,
        city: c?.city ?? null,
        status: a.status,
        claimedAt: a.claimedAt,
        expiresAt: a.expiresAt,
        nextActionAt: a.nextActionAt,
        lastActivityAt: a.lastActivityAt,
        contractStatus: contractMap.get(a.id) ?? null,
      };
    }),
  );
}

export interface AssignmentDetail {
  assignment: {
    id: string;
    status: string;
    active: boolean;
    claimedAt: Date;
    expiresAt: Date | null;
    nextActionAt: Date | null;
    lastActivityAt: Date | null;
    releaseReason: string | null;
  };
  company: {
    id: string;
    name: string;
    prefecture: string | null;
    city: string | null;
    representativePhone: string | null;
    suppression: string;
    recontactAfter: Date | null;
  };
  sites: { url: string; domain: string }[];
  activities: {
    id: string;
    kind: string;
    occurredAt: Date;
    note: string | null;
    nextActionAt: Date | null;
    consultOps: boolean;
    nextActionMode: string;
  }[];
  domainPreference: {
    currentUrl: string | null;
    currentDomain: string | null;
    intent: string;
    newDomainCandidates: string[];
    currentManager: string;
    usesEmail: string;
    customerWish: string | null;
    needsOpsReview: boolean;
    confirmedAt: Date | null;
    updatedAt: Date;
  } | null;
  contracts: {
    id: string;
    status: string;
    reportedAt: Date;
    documentRef: string | null;
    reportNote: string | null;
    closeReason: string | null;
    completedAt: Date | null;
  }[];
  /** 成約報告フォームを出すか（表示用。報告できるかの判定は reportContract が行う） */
  showReport: boolean;
  terms: TermsView[];
  salesOfferId: string | null;
  proposalVersionId: string | null;
  /** 承認済みの最新の提案版に改善デモがあるか（共有リンクを発行できるか） */
  proposalHasDemo: boolean;
}

const REPORT_FORM_STATUSES = ["claimed", "working", "negotiating", "awaiting_ops"];
const OPEN_CONTRACT = ["reported", "under_review", "completed"];

/** 自分の担当の詳細。他人の担当は存在も明かさない */
export async function getMyAssignmentDetail(
  db: DbOrTx,
  actor: Actor | null,
  assignmentId: string,
): Promise<Result<AssignmentDetail, QueryError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  if (!UUID_RE.test(assignmentId)) return err("not_found");
  const [a] = await db.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!a) return err("not_found");
  if (!can(user.value, "read", { type: "assignment", ownerUserId: a.userId })) return err("not_found");

  const activities = await listActivities(db, user.value, a.id);
  if (!activities.ok) return err("not_found");

  const [company] = await db.select().from(companies).where(eq(companies.id, a.companyId));
  if (!company) return err("not_found");
  const sites = await db
    .select({ url: websites.url, domain: websites.domain })
    .from(websites)
    .where(and(eq(websites.companyId, company.id), eq(websites.kind, "current")))
    .orderBy(desc(websites.isPrimary), asc(websites.createdAt));

  const canReadPref = can(user.value, "read", { type: "domainPreference", ownerUserId: a.userId });
  const [pref] = canReadPref
    ? await db.select().from(domainPreferences).where(eq(domainPreferences.assignmentId, a.id))
    : [];

  const canReadContract = can(user.value, "read", { type: "contract", ownerUserId: a.userId });
  const contractRows = canReadContract
    ? await db
        .select()
        .from(contracts)
        .where(and(eq(contracts.assignmentId, a.id), eq(contracts.salesUserId, a.userId)))
        .orderBy(desc(contracts.reportedAt))
    : [];

  const bound = await getSalesOffer(db, company.id, a.salesOfferId);
  const pv = bound?.proposal ?? null;
  const terms = bound ? [offerTerms(bound)] : [];

  return ok({
    assignment: {
      id: a.id,
      status: a.status,
      active: isActiveStatus(a.status),
      claimedAt: a.claimedAt,
      expiresAt: a.expiresAt,
      nextActionAt: a.nextActionAt,
      lastActivityAt: a.lastActivityAt,
      releaseReason: a.releaseReason,
    },
    company: {
      id: company.id,
      name: company.name,
      prefecture: company.prefecture,
      city: company.city,
      representativePhone: company.representativePhone,
      suppression: company.suppression,
      recontactAfter: company.recontactAfter,
    },
    sites,
    activities: activities.value.map((x) => ({
      id: x.id,
      kind: x.kind,
      occurredAt: x.occurredAt,
      note: x.note,
      nextActionAt: x.nextActionAt,
      consultOps: x.consultOps,
      nextActionMode: x.nextActionMode,
    })),
    domainPreference: pref
      ? {
          currentUrl: pref.currentUrl,
          currentDomain: pref.currentDomain,
          intent: pref.intent,
          newDomainCandidates: pref.newDomainCandidates,
          currentManager: pref.currentManager,
          usesEmail: pref.usesEmail,
          customerWish: pref.customerWish,
          needsOpsReview: pref.needsOpsReview,
          confirmedAt: pref.confirmedAt,
          updatedAt: pref.updatedAt,
        }
      : null,
    contracts: contractRows.map((c) => ({
      id: c.id,
      status: c.status,
      reportedAt: c.reportedAt,
      documentRef: c.documentRef,
      reportNote: c.reportNote,
      closeReason: c.closeReason,
      completedAt: c.completedAt,
    })),
    showReport:
      user.value.kind === "sales" &&
      REPORT_FORM_STATUSES.includes(a.status) &&
      !contractRows.some((c) => OPEN_CONTRACT.includes(c.status)),
    terms,
    salesOfferId: bound?.offer.id ?? null,
    proposalVersionId: pv?.id ?? null,
    proposalHasDemo: pv ? pv.demoArtifactDir !== null : false,
  });
}

// ---------- 実績・報酬 ----------

export interface EarningsView {
  contracts: {
    id: string;
    companyName: string;
    status: string;
    reportedAt: Date;
    completedAt: Date | null;
  }[];
  rewards: {
    id: string;
    contractId: string;
    companyName: string;
    status: string;
    /** 発生時の額 + 調整の合計 */
    currentAmount: number;
    accruedAt: Date;
    scheduledFor: Date | null;
    paidAt: Date | null;
    adjusted: boolean;
  }[];
  totals: {
    completedContracts: number;
    /** 発生報酬（取り消しを除く） */
    accrued: number;
    /** 支払予定 */
    scheduled: number;
    /** 支払済み */
    paid: number;
  };
}

/** 自分の実績と報酬。他人の契約・報酬は含めない */
export async function getMyEarnings(db: DbOrTx, actor: Actor | null): Promise<Result<EarningsView, "forbidden">> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const userId = user.value.userId;
  if (!can(user.value, "read", { type: "contract", ownerUserId: userId })) return err("forbidden");
  if (!can(user.value, "read", { type: "reward", ownerUserId: userId })) return err("forbidden");

  const contractRows = await db
    .select({
      id: contracts.id,
      companyName: companies.name,
      status: contracts.status,
      reportedAt: contracts.reportedAt,
      completedAt: contracts.completedAt,
    })
    .from(contracts)
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .where(eq(contracts.salesUserId, userId))
    .orderBy(desc(contracts.reportedAt));

  const rewardRows = await db
    .select({
      id: rewards.id,
      contractId: rewards.contractId,
      companyName: companies.name,
      status: rewards.status,
      amount: rewards.amount,
      accruedAt: rewards.accruedAt,
      scheduledFor: rewards.scheduledFor,
      paidAt: rewards.paidAt,
    })
    .from(rewards)
    .innerJoin(contracts, eq(contracts.id, rewards.contractId))
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .where(eq(rewards.userId, userId))
    .orderBy(desc(rewards.accruedAt));

  const adjustments =
    rewardRows.length === 0
      ? []
      : await db
          .select({ rewardId: rewardAdjustments.rewardId, delta: rewardAdjustments.delta })
          .from(rewardAdjustments)
          .where(
            inArray(
              rewardAdjustments.rewardId,
              rewardRows.map((r) => r.id),
            ),
          );
  const delta = new Map<string, number>();
  for (const adj of adjustments) delta.set(adj.rewardId, (delta.get(adj.rewardId) ?? 0) + adj.delta);

  const rewardViews = rewardRows.map((r) => ({
    id: r.id,
    contractId: r.contractId,
    companyName: r.companyName,
    status: r.status,
    currentAmount: r.amount + (delta.get(r.id) ?? 0),
    accruedAt: r.accruedAt,
    scheduledFor: r.scheduledFor,
    paidAt: r.paidAt,
    adjusted: delta.has(r.id),
  }));
  const sum = (pred: (s: string) => boolean) =>
    rewardViews.filter((r) => pred(r.status)).reduce((s, r) => s + r.currentAmount, 0);

  return ok({
    contracts: contractRows,
    rewards: rewardViews,
    totals: {
      completedContracts: contractRows.filter((c) => c.status === "completed").length,
      accrued: sum((s) => s !== "cancelled"),
      scheduled: sum((s) => s === "scheduled"),
      paid: sum((s) => s === "paid"),
    },
  });
}
