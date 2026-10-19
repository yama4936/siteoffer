import { type Actor, type Clock, err, ok, type Result, recordEvent } from "@siteoffer/core";
import { companies, type DbOrTx, discoveryJobs, discoverySources, websites } from "@siteoffer/db";
import { and, eq, inArray } from "drizzle-orm";
import { type JudgedSite, judgeOfficialSite, mergeOfficialSiteStatus, type OfficialSiteJudgement } from "./judge.ts";
import type { DiscoveryProvider, SearchProvider } from "./providers/types.ts";
import {
  type CompanyCandidate,
  type DiscoveryCriteria,
  type DiscoveryFailure,
  discoveryCriteriaSchema,
  type OfficialSiteStatusValue,
} from "./schemas.ts";

export interface DiscoveryProviders {
  /** 企業候補の取得元（法人番号API・フィクスチャ等） */
  companies: DiscoveryProvider;
  /** 公式サイト候補の取得元（検索系API）。なければ公式サイトは not_found のまま */
  search?: SearchProvider;
  searchLimit?: number;
  signal?: AbortSignal;
  /** Guard short DB writes with the worker's current execution ownership. Never run external calls inside it. */
  withOwnership?: DiscoveryWrite;
  /** 第三者サイトとして扱う追加ドメイン */
  thirdPartyDomains?: readonly string[];
}

export interface DiscoveryRunSummary {
  jobId: string;
  status: "succeeded" | "failed";
  found: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  limit: number;
  failures: DiscoveryFailure[];
}

export type RunDiscoveryError = "job_not_found" | "job_already_running" | "provider_mismatch" | "job_superseded";

type DiscoveryWrite = <T>(write: (tx: DbOrTx) => Promise<T>) => Promise<T>;
class DiscoverySuperseded extends Error {}

/** 再収集で営業可能へ戻さない営業抑止（8.1） */
export const PROTECTED_SUPPRESSIONS = ["do_not_contact", "excluded", "existing_customer"] as const;

const SYSTEM_ACTOR = { kind: "system", job: "discovery" } as const;

type CompanyRow = typeof companies.$inferSelect;
type Outcome = "created" | "updated" | "skipped";

/**
 * 収集を実行する（8.1・24.6）。
 * 1. 取得元から企業候補を得る（法人番号など）
 * 2. 候補ごとに、検索系APIで公式サイト候補を探して確度を判定する
 * 3. 法人番号・取得元の外部ID・正規化URLで既存企業と突き合わせ、作成または更新する
 * 候補ごとに別トランザクションで処理し、1件の失敗で他の候補を巻き戻さない。
 * 想定外の例外（DB障害など）は候補単位で捕まえて失敗理由に残す。
 */
export async function runDiscovery(
  db: DbOrTx,
  clock: Clock,
  jobId: string,
  providers: DiscoveryProviders,
): Promise<Result<DiscoveryRunSummary, RunDiscoveryError>> {
  try {
    return await runDiscoveryAttempt(db, clock, jobId, providers);
  } catch (error) {
    if (error instanceof DiscoverySuperseded)
      return err("job_superseded", "収集の実行状態が変更されたため、古い試行の反映を止めました");
    throw error;
  }
}

async function runDiscoveryAttempt(
  db: DbOrTx,
  clock: Clock,
  jobId: string,
  providers: DiscoveryProviders,
): Promise<Result<DiscoveryRunSummary, RunDiscoveryError>> {
  const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId));
  if (!job) return err("job_not_found", `収集ジョブがない：${jobId}`);
  if (job.status === "running") return err("job_already_running", "このジョブは実行中");
  if (job.provider !== providers.companies.name) {
    return err(
      "provider_mismatch",
      `ジョブの取得元（${job.provider}）と渡された取得元（${providers.companies.name}）が違う`,
    );
  }

  const startedAt = clock.now();
  const transact: DiscoveryWrite = providers.withOwnership ?? ((write) => db.transaction(write));
  const attempt = job.attempts + 1;
  const claimed = await transact(async (tx) => {
    const [row] = await tx
      .update(discoveryJobs)
      .set({ status: "running", startedAt, finishedAt: null, attempts: attempt, error: null })
      .where(
        and(
          eq(discoveryJobs.id, jobId),
          eq(discoveryJobs.status, job.status),
          eq(discoveryJobs.attempts, job.attempts),
        ),
      )
      .returning({ id: discoveryJobs.id });
    if (!row) return false;
    await recordEvent(tx, clock, {
      actor: SYSTEM_ACTOR,
      action: "discovery.job_started",
      targetType: "discovery_job",
      targetId: jobId,
      before: { status: job.status },
      after: { status: "running", attempt },
    });
    return true;
  });
  if (!claimed) return err("job_already_running", "他の実行が先に収集の状態を変更しました");
  const write: DiscoveryWrite = (change) =>
    transact(async (tx) => {
      const [current] = await tx
        .select({ status: discoveryJobs.status, attempts: discoveryJobs.attempts })
        .from(discoveryJobs)
        .where(eq(discoveryJobs.id, jobId))
        .for("update");
      if (current?.status !== "running" || current.attempts !== attempt) throw new DiscoverySuperseded();
      return change(tx);
    });

  const failures: DiscoveryFailure[] = [];
  let searched = 0;
  let blockedSearch: Awaited<ReturnType<SearchProvider["findOfficialSite"]>> | undefined;
  if (
    providers.searchLimit !== undefined &&
    (!Number.isSafeInteger(providers.searchLimit) || providers.searchLimit < 1 || providers.searchLimit > 1000)
  )
    return finish(
      write,
      clock,
      jobId,
      "failed",
      { found: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
      null,
      failures,
      "検索回数の上限が不正です",
    );
  const limited: DiscoveryProviders = {
    ...providers,
    ...(providers.search
      ? {
          search: {
            name: providers.search.name,
            findOfficialSite: async (query, context) => {
              if (providers.signal?.aborted)
                return Promise.resolve(err("search_failed" as const, "検索が中断されました"));
              await write(async () => {});
              if (blockedSearch) return blockedSearch;
              if (searched >= (providers.searchLimit ?? 1000))
                return Promise.resolve(err("search_rate_limited" as const, "この試行の検索回数の上限に達しました"));
              searched++;
              const result = await providers.search!.findOfficialSite(query, { ...context, signal: providers.signal });
              if (!result.ok && ["search_unavailable", "search_rate_limited"].includes(result.error))
                blockedSearch = result;
              return result;
            },
          },
        }
      : {}),
  };
  const counts = { found: 0, created: 0, updated: 0, skipped: 0, failed: 0 };

  const parsed = discoveryCriteriaSchema.safeParse(job.criteria);
  if (!parsed.success) {
    return finish(write, clock, jobId, "failed", counts, null, failures, `収集条件が不正：${parsed.error.message}`);
  }
  const criteria = parsed.data;

  let provided: Awaited<ReturnType<DiscoveryProvider["discover"]>>;
  await write(async () => {});
  try {
    provided = await providers.companies.discover(criteria, { clock, signal: providers.signal });
  } catch (e) {
    if (e instanceof DiscoverySuperseded) throw e;
    const reason = `取得元で例外：${(e as Error).message.slice(0, 500)}`;
    failures.push({ externalId: null, stage: "provider", reason });
    return finish(write, clock, jobId, "failed", counts, criteria.limit, failures, reason);
  }
  if (!provided.ok) {
    failures.push({
      externalId: null,
      stage: "provider",
      reason: `${provided.error}: ${provided.message ?? ""}`.trim(),
    });
    return finish(write, clock, jobId, "failed", counts, criteria.limit, failures, provided.message ?? provided.error);
  }

  const candidates = provided.value.slice(0, criteria.limit);
  counts.found = candidates.length;

  for (const cand of candidates) {
    if (providers.signal?.aborted)
      return finish(write, clock, jobId, "failed", counts, criteria.limit, failures, "収集が中断されました");
    const area = checkArea(criteria, cand);
    if (area) {
      counts.skipped++;
      failures.push({ externalId: cand.externalId, stage: "candidate", reason: area });
      continue;
    }
    await write(async () => {});
    try {
      const outcome = await processCandidate(db, write, clock, jobId, cand, limited, failures);
      counts[outcome]++;
    } catch (e) {
      if (e instanceof DiscoverySuperseded) throw e;
      counts.failed++;
      failures.push({ externalId: cand.externalId, stage: "save", reason: (e as Error).message.slice(0, 500) });
    }
  }

  if (providers.signal?.aborted)
    return finish(write, clock, jobId, "failed", counts, criteria.limit, failures, "収集が中断されました");
  const status = counts.found > 0 && counts.failed === counts.found ? "failed" : "succeeded";
  return finish(
    write,
    clock,
    jobId,
    status,
    counts,
    criteria.limit,
    failures,
    status === "failed" ? "すべての候補の保存に失敗" : null,
  );
}

export type CreateJobError = "invalid_criteria";

/** 収集ジョブを作る。条件はZodで検証し、上限件数も保存する */
export async function createDiscoveryJob(
  db: DbOrTx,
  clock: Clock,
  input: { provider: string; criteria: unknown; createdBy?: string | null; actor?: Actor },
): Promise<Result<{ jobId: string; criteria: DiscoveryCriteria }, CreateJobError>> {
  const parsed = discoveryCriteriaSchema.safeParse(input.criteria);
  if (!parsed.success) return err("invalid_criteria", parsed.error.message);
  const criteria = parsed.data;
  const jobId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(discoveryJobs)
      .values({
        provider: input.provider,
        criteria,
        maxResults: criteria.limit,
        createdBy: input.createdBy ?? null,
        createdAt: clock.now(),
      })
      .returning({ id: discoveryJobs.id });
    await recordEvent(tx, clock, {
      actor: input.actor ?? SYSTEM_ACTOR,
      action: "discovery.job_created",
      targetType: "discovery_job",
      targetId: row!.id,
      after: { provider: input.provider, criteria },
    });
    return row!.id;
  });
  return ok({ jobId, criteria });
}

/**
 * 収集条件の地域と、出典のある所在地を照合する。外れていれば理由を返す。
 * 所在地が不明な候補は外さない（不明のまま保存し、地域を断定しない）。
 */
function checkArea(criteria: DiscoveryCriteria, cand: CompanyCandidate): string | null {
  if (criteria.prefecture && cand.prefecture && cand.prefecture !== criteria.prefecture) {
    return `area_mismatch: 所在地（出典あり）が${cand.prefecture}で、条件の${criteria.prefecture}と異なる`;
  }
  if (criteria.city && cand.city && !cand.city.startsWith(criteria.city)) {
    return `area_mismatch: 所在地（出典あり）が${cand.city}で、条件の${criteria.city}と異なる`;
  }
  return null;
}

async function findExistingCompany(db: DbOrTx, cand: CompanyCandidate): Promise<CompanyRow | null> {
  const [src] = await db
    .select({ companyId: discoverySources.companyId })
    .from(discoverySources)
    .where(and(eq(discoverySources.provider, cand.provider), eq(discoverySources.externalId, cand.externalId)));
  if (src?.companyId) {
    const [row] = await db.select().from(companies).where(eq(companies.id, src.companyId));
    if (row) return row;
  }
  if (cand.corporateNumber) {
    const [row] = await db.select().from(companies).where(eq(companies.corporateNumber, cand.corporateNumber));
    if (row) return row;
  }
  return null;
}

/** 正規化URLで既存企業を探す。法人番号が食い違う企業には寄せない（同名の別企業を混ぜない） */
async function findCompanyBySites(db: DbOrTx, cand: CompanyCandidate, sites: JudgedSite[]): Promise<CompanyRow | null> {
  const urls = sites.map((s) => s.normalizedUrl).filter((u): u is string => !!u);
  if (urls.length === 0) return null;
  const owned = await db
    .select({ company: companies })
    .from(websites)
    .innerJoin(companies, eq(websites.companyId, companies.id))
    .where(inArray(websites.normalizedUrl, urls));
  for (const { company } of owned) {
    if (!company.corporateNumber || !cand.corporateNumber || company.corporateNumber === cand.corporateNumber) {
      return company;
    }
  }
  return null;
}

async function processCandidate(
  db: DbOrTx,
  write: DiscoveryWrite,
  clock: Clock,
  jobId: string,
  cand: CompanyCandidate,
  providers: DiscoveryProviders,
  failures: DiscoveryFailure[],
): Promise<Outcome> {
  let existing = await findExistingCompany(db, cand);

  // 営業抑止の企業は、検索も更新もしない（状態を戻さない）。出典の記録だけ更新する
  if (existing && (PROTECTED_SUPPRESSIONS as readonly string[]).includes(existing.suppression)) {
    const company = existing;
    await write(async (tx) => {
      await upsertCompanySource(tx, clock, jobId, cand, company.id);
    });
    failures.push({ externalId: cand.externalId, stage: "candidate", reason: `suppressed: ${company.suppression}` });
    return "skipped";
  }

  let judgement: OfficialSiteJudgement | null = null;
  if (providers.search) {
    const found = await providers.search.findOfficialSite(
      {
        name: cand.name,
        corporateNumber: cand.corporateNumber,
        prefecture: cand.prefecture,
        city: cand.city,
        address: cand.address,
      },
      { clock },
    );
    if (found.ok) {
      judgement = judgeOfficialSite(cand, found.value, { thirdPartyDomains: providers.thirdPartyDomains ?? [] });
    } else {
      failures.push({ externalId: cand.externalId, stage: "search", reason: `${found.error}: ${found.message ?? ""}` });
    }
  }

  if (!existing && judgement) existing = await findCompanyBySites(db, cand, judgement.sites);

  return write(async (tx) => {
    // 確度：検索できなかったときは、新規なら確認待ち、既存なら据え置き
    const judged: OfficialSiteStatusValue = judgement?.status ?? (providers.search ? "needs_review" : "not_found");
    const now = clock.now();

    let company: CompanyRow;
    let outcome: Outcome;
    const before = existing;
    if (!existing) {
      const [row] = await tx
        .insert(companies)
        .values({
          name: cand.name,
          corporateNumber: cand.corporateNumber,
          prefecture: cand.prefecture,
          city: cand.city,
          address: cand.address,
          addressSourceUrl: cand.addressSourceUrl,
          industry: cand.industry,
          representativePhone: cand.representativePhone,
          officialSiteStatus: judged,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      company = row!;
      outcome = "created";
    } else {
      const patch = companyPatch(existing, cand);
      company = existing;
      outcome = "skipped";
      if (Object.keys(patch).length > 0) {
        const [row] = await tx
          .update(companies)
          .set({ ...patch, updatedAt: now })
          .where(eq(companies.id, existing.id))
          .returning();
        company = row!;
        outcome = "updated";
      }
    }

    // 公式サイトの保存。他社の正規化URLとぶつかるものは保存しない
    let status = judged;
    if (judgement && judgement.sites.length > 0) {
      const saved = await saveWebsites(tx, company.id, judgement.sites);
      if (saved.added > 0 && outcome === "skipped") outcome = "updated";
      for (const c of saved.conflicts) {
        failures.push({ externalId: cand.externalId, stage: "save", reason: `website_owned_by_other_company: ${c}` });
      }
      if (saved.kept === 0) status = "needs_review";
    }
    if (judgement || outcome === "created") {
      const merged = mergeOfficialSiteStatus(company.officialSiteStatus, status);
      if (merged !== company.officialSiteStatus) {
        const [row] = await tx
          .update(companies)
          .set({ officialSiteStatus: merged, updatedAt: now })
          .where(eq(companies.id, company.id))
          .returning();
        company = row!;
        if (outcome === "skipped") outcome = "updated";
      }
    }

    await upsertCompanySource(tx, clock, jobId, cand, company.id);
    if (judgement && providers.search) {
      for (const j of judgement.judged) await upsertSiteSource(tx, jobId, providers.search.name, company.id, j);
    }

    if (outcome !== "skipped") {
      await recordEvent(tx, clock, {
        actor: SYSTEM_ACTOR,
        action: outcome === "created" ? "discovery.company_created" : "discovery.company_updated",
        targetType: "company",
        targetId: company.id,
        before: before ? snapshot(before) : null,
        after: { ...snapshot(company), jobId, officialSiteReason: judgement?.reason ?? null },
      });
    }
    return outcome;
  });
}

/** 既存企業に反映する差分。所在地は出典付きのものだけで置き換え、取得元にない項目は消さない */
function companyPatch(existing: CompanyRow, cand: CompanyCandidate): Partial<typeof companies.$inferInsert> {
  const patch: Partial<typeof companies.$inferInsert> = {};
  if (cand.name !== existing.name) patch.name = cand.name;
  if (cand.corporateNumber && !existing.corporateNumber) patch.corporateNumber = cand.corporateNumber;
  if (cand.addressSourceUrl && (cand.prefecture || cand.city)) {
    if (cand.prefecture !== existing.prefecture) patch.prefecture = cand.prefecture;
    if (cand.city !== existing.city) patch.city = cand.city;
    if (cand.address !== existing.address) patch.address = cand.address;
    if (cand.addressSourceUrl !== existing.addressSourceUrl) patch.addressSourceUrl = cand.addressSourceUrl;
  }
  if (cand.industry && !existing.industry) patch.industry = cand.industry;
  if (cand.representativePhone && !existing.representativePhone) patch.representativePhone = cand.representativePhone;
  return patch;
}

async function saveWebsites(
  tx: DbOrTx,
  companyId: string,
  sites: JudgedSite[],
): Promise<{ added: number; kept: number; conflicts: string[] }> {
  const existing = await tx.select().from(websites).where(eq(websites.companyId, companyId));
  let hasPrimary = existing.some((w) => w.isPrimary);
  let added = 0;
  let kept = 0;
  const conflicts: string[] = [];
  for (const s of sites) {
    if (!s.normalizedUrl || !s.domain) continue;
    const inserted = await tx
      .insert(websites)
      .values({
        companyId,
        url: s.candidate.url,
        normalizedUrl: s.normalizedUrl,
        domain: s.domain,
        kind: "current",
        isPrimary: !hasPrimary,
      })
      .onConflictDoNothing({ target: websites.normalizedUrl })
      .returning({ id: websites.id });
    if (inserted.length > 0) {
      added++;
      kept++;
      hasPrimary = true;
      continue;
    }
    const [owner] = await tx
      .select({ companyId: websites.companyId })
      .from(websites)
      .where(eq(websites.normalizedUrl, s.normalizedUrl));
    if (owner?.companyId === companyId) kept++;
    else conflicts.push(s.normalizedUrl);
  }
  return { added, kept, conflicts };
}

async function upsertCompanySource(tx: DbOrTx, clock: Clock, jobId: string, cand: CompanyCandidate, companyId: string) {
  const values = {
    jobId,
    companyId,
    provider: cand.provider,
    role: "company",
    externalId: cand.externalId,
    sourceUrl: cand.sourceUrl,
    fetchedAt: cand.fetchedAt ?? clock.now(),
    payload: (cand.raw ?? null) as unknown,
  };
  await tx
    .insert(discoverySources)
    .values(values)
    .onConflictDoUpdate({
      target: [discoverySources.provider, discoverySources.externalId],
      // jobId は最後に見つけたジョブ。companyId は最初に結び付けた企業を保つ
      set: { jobId, sourceUrl: values.sourceUrl, fetchedAt: values.fetchedAt, payload: values.payload },
    });
}

async function upsertSiteSource(tx: DbOrTx, jobId: string, provider: string, companyId: string, j: JudgedSite) {
  const externalId = `${companyId}:${j.normalizedUrl ?? j.candidate.url}`;
  const payload = {
    url: j.candidate.url,
    normalizedUrl: j.normalizedUrl,
    title: j.candidate.title,
    verdict: j.verdict,
    reason: j.reason,
    evidence: j.candidate.evidence,
  };
  await tx
    .insert(discoverySources)
    .values({
      jobId,
      companyId,
      provider,
      role: "site",
      externalId,
      sourceUrl: j.candidate.sourceUrl,
      fetchedAt: j.candidate.fetchedAt,
      payload,
    })
    .onConflictDoUpdate({
      target: [discoverySources.provider, discoverySources.externalId],
      set: { jobId, sourceUrl: j.candidate.sourceUrl, fetchedAt: j.candidate.fetchedAt, payload },
    });
}

function snapshot(c: CompanyRow) {
  return {
    name: c.name,
    corporateNumber: c.corporateNumber,
    prefecture: c.prefecture,
    city: c.city,
    address: c.address,
    addressSourceUrl: c.addressSourceUrl,
    officialSiteStatus: c.officialSiteStatus,
    suppression: c.suppression,
  };
}

async function finish(
  write: DiscoveryWrite,
  clock: Clock,
  jobId: string,
  status: "succeeded" | "failed",
  counts: { found: number; created: number; updated: number; skipped: number; failed: number },
  limit: number | null,
  failures: DiscoveryFailure[],
  error: string | null,
): Promise<Result<DiscoveryRunSummary, RunDiscoveryError>> {
  await write(async (tx) => {
    await tx
      .update(discoveryJobs)
      .set({
        status,
        foundCount: counts.found,
        createdCount: counts.created,
        updatedCount: counts.updated,
        skippedCount: counts.skipped,
        failedCount: counts.failed,
        maxResults: limit,
        failures,
        error,
        finishedAt: clock.now(),
      })
      .where(eq(discoveryJobs.id, jobId));
    await recordEvent(tx, clock, {
      actor: SYSTEM_ACTOR,
      action: status === "succeeded" ? "discovery.job_succeeded" : "discovery.job_failed",
      targetType: "discovery_job",
      targetId: jobId,
      before: { status: "running" },
      after: { status, ...counts, limit, error },
    });
  });
  return ok({ jobId, status, ...counts, limit: limit ?? 0, failures });
}
