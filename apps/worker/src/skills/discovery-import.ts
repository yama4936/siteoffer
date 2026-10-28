/**
 * company-discovery スキルが Web で調べた企業候補（candidates.json）を、収集ジョブとしてDBへ取り込む。
 * 取得元は「agent-web」（エージェントの調査による手動取り込み。自動収集の実装済みとは扱わない、8.3）。
 * scripts/import-discovery.ts と、ワーカーのスキル実行（skills/run.ts）が使う。
 *
 * - 取り込みは packages/discovery の runDiscovery を通す。法人番号・外部ID・正規化URLでの重複排除、
 *   地域条件と出典付き所在地の照合、営業抑止の維持、公式サイトの確度判定は自動収集と同じ規則になる
 * - 同じ候補ファイルを再実行しても企業は増えない
 * - 診断へは送らない（評価は site-evaluation スキルで行う）
 */
import { type Actor, type Clock, err, ok, type Result } from "@siteoffer/core";
import type { Db, DbOrTx } from "@siteoffer/db";
import {
  AGENT_WEB_PROVIDER,
  type AgentWebCandidate,
  type AgentWebOptions,
  agentWebExternalId,
  agentWebFileSchema,
  createAgentWebProviders,
  createDiscoveryJob,
  discoveryCriteriaSchema,
  normalizeUrl,
  runDiscovery,
} from "@siteoffer/discovery";

export function parseCandidatesFile(raw: unknown) {
  const parsed = agentWebFileSchema.safeParse(raw);
  if (!parsed.success) return err("invalid_candidates", `候補ファイルの形式が不正：${parsed.error.message}`);
  const list = parsed.data.candidates;
  const criteria = discoveryCriteriaSchema.safeParse({
    ...(parsed.data.criteria as object),
    limit: Math.max(1, list.length),
  });
  if (!criteria.success) return err("invalid_criteria", `収集条件が不正：${criteria.error.message}`);
  return ok({ list, criteria: criteria.data });
}

export function candidateDomain(c: AgentWebCandidate) {
  const n = c.official_site ? normalizeUrl(c.official_site.url) : null;
  return n?.ok ? n.value.domain : null;
}

/** 取り込み済みの外部ID、法人番号、公式サイトのドメインの順で既存企業を探す */
export async function findCandidateCompany(db: DbOrTx, c: AgentWebCandidate) {
  const externalId = agentWebExternalId(c);
  const src = await db.query.discoverySources.findFirst({
    where: (t, { and, eq }) => and(eq(t.provider, AGENT_WEB_PROVIDER), eq(t.externalId, externalId)),
  });
  if (src?.companyId) {
    const id = src.companyId;
    const row = await db.query.companies.findFirst({ where: (t, { eq }) => eq(t.id, id) });
    if (row) return row;
  }
  const corp = c.corporate_number;
  if (corp) {
    const row = await db.query.companies.findFirst({ where: (t, { eq }) => eq(t.corporateNumber, corp) });
    if (row) return row;
  }
  const domain = candidateDomain(c);
  if (!domain) return undefined;
  const site = await db.query.websites.findFirst({ where: (t, { eq }) => eq(t.domain, domain) });
  return site ? db.query.companies.findFirst({ where: (t, { eq }) => eq(t.id, site.companyId) }) : undefined;
}

export interface CandidateImport {
  jobId: string;
  status: string;
  found: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  failures: { stage: string; externalId?: string | null; reason: string }[];
  /** 候補ごとの取り込み後の企業（未登録は null） */
  companies: {
    name: string;
    domain: string | null;
    companyId: string | null;
    officialSiteStatus: string | null;
    pipelineStatus: string | null;
    suppression: string | null;
  }[];
}

export async function importCandidates(
  db: Db,
  clock: Clock,
  raw: unknown,
  actor: Actor,
  /** 実在確認（公式サイトの取得・国税庁API）の差し替え。省略時は実際に取得する */
  verify: AgentWebOptions = {},
): Promise<Result<CandidateImport, string>> {
  const parsed = parseCandidatesFile(raw);
  if (!parsed.ok) return parsed;
  const { list, criteria } = parsed.value;
  const job = await createDiscoveryJob(db, clock, { provider: AGENT_WEB_PROVIDER, criteria, actor });
  if (!job.ok) return err(job.error, `収集ジョブを作れない：${job.message ?? job.error}`);
  const r = await runDiscovery(db, clock, job.value.jobId, createAgentWebProviders(list, verify));
  if (!r.ok) return err(r.error, r.message ?? r.error);
  const s = r.value;
  const companies: CandidateImport["companies"] = [];
  for (const c of list) {
    const company = await findCandidateCompany(db, c);
    companies.push({
      name: c.name,
      domain: candidateDomain(c),
      companyId: company?.id ?? null,
      officialSiteStatus: company?.officialSiteStatus ?? null,
      pipelineStatus: company?.pipelineStatus ?? null,
      suppression: company?.suppression ?? null,
    });
  }
  return ok({
    jobId: s.jobId,
    status: s.status,
    found: s.found,
    created: s.created,
    updated: s.updated,
    skipped: s.skipped,
    failed: s.failed,
    failures: s.failures,
    companies,
  });
}
