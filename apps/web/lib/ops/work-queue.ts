import { type Actor, ok } from "@siteoffer/core";
import {
  assignments,
  companies,
  contracts,
  type DbOrTx,
  deliveries,
  designVersions,
  discoveryJobs,
  proposals,
  proposalVersions,
  siteAudits,
} from "@siteoffer/db";
import { discoveryCriteriaSchema } from "@siteoffer/discovery";
import { and, asc, eq, gt, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireOps } from "./guard";

export const WORK_GROUPS = {
  discovery: { label: "収集の復旧", href: "/ops/discovery" },
  design: { label: "デザイン", href: "/ops/designs" },
  proposal: { label: "提案レビュー", href: "/ops/review" },
  assignment: { label: "担当の調整", href: "/ops/assignments" },
  contract: { label: "契約確認", href: "/ops/contracts" },
  delivery: { label: "制作・公開", href: "/ops/delivery" },
  website: { label: "公式サイト確認", href: "/ops/discovery?pipeline=collected" },
  preparation: { label: "デザインの準備", href: "/ops/designs" },
} as const;
export type WorkGroup = keyof typeof WORK_GROUPS;
export interface WorkItem {
  id: string;
  group: WorkGroup;
  title: string;
  reason: string;
  action: string;
  href: string;
  since: string;
  priority: number;
}
const PER_GROUP = 20;
const total = sql<number>`count(*) over ()`.mapWith(Number);

/** Only current, actionable versions enter the queue. Large image/PDF bodies are never selected. */
export async function getOpsWorkQueue(db: DbOrTx, actor: Actor | null) {
  const auth = requireOps(actor);
  if (!auth.ok) return auth;
  const newerDesign = alias(designVersions, "newer_design");
  const newerProposal = alias(proposalVersions, "newer_proposal");
  const retried = alias(discoveryJobs, "retried");
  const activeCompany = eq(companies.suppression, "none");
  const [failed, design, proposal, assignment, contract, delivery, website, preparation] = await Promise.all([
    db
      .select({
        id: discoveryJobs.id,
        provider: discoveryJobs.provider,
        criteria: discoveryJobs.criteria,
        since: discoveryJobs.createdAt,
        total,
      })
      .from(discoveryJobs)
      .where(
        and(
          eq(discoveryJobs.status, "failed"),
          notExists(db.select({ id: retried.id }).from(retried).where(eq(retried.retryOfJobId, discoveryJobs.id))),
        ),
      )
      .orderBy(asc(discoveryJobs.createdAt), asc(discoveryJobs.id))
      .limit(PER_GROUP),
    db
      .select({
        id: designVersions.id,
        companyId: companies.id,
        name: companies.name,
        status: designVersions.status,
        version: designVersions.version,
        since: designVersions.createdAt,
        total,
      })
      .from(designVersions)
      .innerJoin(companies, eq(companies.id, designVersions.companyId))
      .where(
        and(
          activeCompany,
          inArray(designVersions.status, ["draft", "in_review", "failed", "rejected", "approved"]),
          isNull(designVersions.buildRequestedAt),
          notExists(
            db
              .select({ id: newerDesign.id })
              .from(newerDesign)
              .where(
                and(
                  eq(newerDesign.companyId, designVersions.companyId),
                  gt(newerDesign.version, designVersions.version),
                ),
              ),
          ),
        ),
      )
      .orderBy(
        sql`case when ${designVersions.status} = 'failed' then 0 when ${designVersions.status} = 'draft' then 3 else 2 end`,
        asc(designVersions.createdAt),
        asc(designVersions.id),
      )
      .limit(PER_GROUP),
    db
      .select({
        id: proposalVersions.id,
        companyId: companies.id,
        name: companies.name,
        status: proposalVersions.status,
        version: proposalVersions.version,
        since: proposalVersions.createdAt,
        total,
      })
      .from(proposalVersions)
      .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
      .innerJoin(companies, eq(companies.id, proposals.companyId))
      .where(
        and(
          activeCompany,
          inArray(proposalVersions.status, ["in_review", "failed", "rejected"]),
          notExists(
            db
              .select({ id: newerProposal.id })
              .from(newerProposal)
              .where(
                and(
                  eq(newerProposal.proposalId, proposalVersions.proposalId),
                  gt(newerProposal.version, proposalVersions.version),
                ),
              ),
          ),
        ),
      )
      .orderBy(
        sql`case when ${proposalVersions.status} = 'failed' then 0 else 2 end`,
        asc(proposalVersions.createdAt),
        asc(proposalVersions.id),
      )
      .limit(PER_GROUP),
    db
      .select({ id: assignments.id, name: companies.name, since: assignments.createdAt, total })
      .from(assignments)
      .innerJoin(companies, eq(companies.id, assignments.companyId))
      .where(eq(assignments.status, "awaiting_ops"))
      .orderBy(asc(assignments.createdAt), asc(assignments.id))
      .limit(PER_GROUP),
    db
      .select({ id: contracts.id, name: companies.name, since: contracts.reportedAt, total })
      .from(contracts)
      .innerJoin(companies, eq(companies.id, contracts.companyId))
      .where(inArray(contracts.status, ["reported", "under_review"]))
      .orderBy(asc(contracts.reportedAt), asc(contracts.id))
      .limit(PER_GROUP),
    db
      .select({
        id: deliveries.id,
        name: companies.name,
        status: deliveries.status,
        since: deliveries.updatedAt,
        total,
      })
      .from(deliveries)
      .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
      .innerJoin(companies, eq(companies.id, contracts.companyId))
      .where(
        and(eq(contracts.status, "completed"), inArray(deliveries.status, ["info_gathering", "ops_review", "ready"])),
      )
      .orderBy(asc(deliveries.updatedAt), asc(deliveries.id))
      .limit(PER_GROUP),
    db
      .select({
        id: companies.id,
        name: companies.name,
        status: companies.officialSiteStatus,
        since: companies.createdAt,
        total,
      })
      .from(companies)
      .where(
        and(
          activeCompany,
          eq(companies.pipelineStatus, "collected"),
          inArray(companies.officialSiteStatus, ["needs_review", "candidate", "not_found"]),
        ),
      )
      .orderBy(asc(companies.createdAt), asc(companies.id))
      .limit(PER_GROUP),
    db
      .select({ id: companies.id, name: companies.name, since: companies.updatedAt, total })
      .from(companies)
      .where(
        and(
          activeCompany,
          eq(companies.pipelineStatus, "audited"),
          sql`exists (select 1 from ${siteAudits} where ${siteAudits.companyId} = ${companies.id} and ${siteAudits.status} = 'evaluated' and ${siteAudits.decision} = 'create')`,
          notExists(
            db.select({ id: designVersions.id }).from(designVersions).where(eq(designVersions.companyId, companies.id)),
          ),
        ),
      )
      .orderBy(asc(companies.updatedAt), asc(companies.id))
      .limit(PER_GROUP),
  ]);
  const items: WorkItem[] = [
    ...failed.map((r) => ({
      id: r.id,
      group: "discovery" as const,
      title: discoveryScope(r.criteria, r.provider),
      reason: "収集が停止しています。取得元の設定と停止理由を確認してください。",
      action: "原因と再試行を確認",
      href: `/ops/discovery/${r.id}`,
      since: r.since.toISOString(),
      priority: 0,
    })),
    ...design.map((r) => {
      const state = {
        draft: ["画像の取り込みが必要です。保存済みの制作条件から再開できます。", "画像を取り込む", 3],
        in_review: ["画像が完成しました。事実・素材の権利・表示を確認すると制作へ進めます。", "デザインを確認", 2],
        approved: ["デザインは承認済みです。この画像を使ってサイト制作を開始できます。", "制作へ進む", 2],
        failed: ["画像の処理が停止しています。失敗理由を確認して再開してください。", "停止理由を確認", 0],
        rejected: ["デザインの修正が必要です。前回の確認メモを引き継いで再開できます。", "修正内容を確認", 2],
      }[r.status as "draft" | "in_review" | "approved" | "failed" | "rejected"] as [string, string, number];
      return {
        id: r.id,
        group: "design" as const,
        title: r.name,
        reason: `第${r.version}版 · ${state[0]}`,
        action: state[1],
        href: `/ops/designs?company=${r.companyId}&design=${r.id}`,
        since: r.since.toISOString(),
        priority: state[2],
      };
    }),
    ...proposal.map((r) => ({
      id: r.id,
      group: "proposal" as const,
      title: r.name,
      reason: `第${r.version}版 · ${r.status === "in_review" ? "サイトと提案内容の確認待ちです。承認後に営業へ引き継げます。" : r.status === "failed" ? "サイト制作が停止しています。制作履歴を確認してください。" : "提案の修正待ちです。差し戻しの理由を確認してください。"}`,
      action: r.status === "in_review" ? "比較して確認" : "制作状況を確認",
      href:
        r.status === "in_review"
          ? `/ops/review?company=${r.companyId}&version=${r.id}`
          : `/ops/designs?company=${r.companyId}`,
      since: r.since.toISOString(),
      priority: r.status === "failed" ? 0 : 2,
    })),
    ...assignment.map((r) => ({
      id: r.id,
      group: "assignment" as const,
      title: r.name,
      reason: "営業担当の継続・引き継ぎについて運営の判断が必要です。",
      action: "担当を確認",
      href: `/ops/assignments?focus=${r.id}#assignment-${r.id}`,
      since: r.since.toISOString(),
      priority: 1,
    })),
    ...contract.map((r) => ({
      id: r.id,
      group: "contract" as const,
      title: r.name,
      reason: "成約報告の資料・契約条件を確認してください。",
      action: "契約を確認",
      href: `/ops/contracts?focus=${r.id}#contract-${r.id}`,
      since: r.since.toISOString(),
      priority: 1,
    })),
    ...delivery.map((r) => ({
      id: r.id,
      group: "delivery" as const,
      title: r.name,
      reason:
        r.status === "ready"
          ? "顧客確認が済みました。公開に必要な情報と手続きを確認してください。"
          : r.status === "ops_review"
            ? "納品サイトが運営の確認を待っています。"
            : "制作に必要な情報を揃える段階です。",
      action: "制作・公開を確認",
      href: `/ops/delivery?focus=${r.id}#delivery-${r.id}`,
      since: r.since.toISOString(),
      priority: r.status === "info_gathering" ? 3 : 2,
    })),
    ...website.map((r) => ({
      id: r.id,
      group: "website" as const,
      title: r.name,
      reason:
        r.status === "not_found"
          ? "法人情報を収集済みです。公式サイトの特定が必要です。"
          : "公式サイトの候補が見つかりました。同名企業との取り違えがないか確認してください。",
      action: "企業情報を確認",
      href: `/ops/companies/${r.id}`,
      since: r.since.toISOString(),
      priority: 3,
    })),
    ...preparation.map((r) => ({
      id: r.id,
      group: "preparation" as const,
      title: r.name,
      reason: "診断で改善提案の対象になりました。制作条件とデザイン画像の準備へ進めます。",
      action: "デザインを準備",
      href: `/ops/designs?company=${r.id}`,
      since: r.since.toISOString(),
      priority: 3,
    })),
  ];
  items.sort((a, b) => a.priority - b.priority || a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
  const groups = Object.entries({
    discovery: failed,
    design,
    proposal,
    assignment,
    contract,
    delivery,
    website,
    preparation,
  }).map(([key, rows]) => ({ key: key as WorkGroup, ...WORK_GROUPS[key as WorkGroup], count: rows[0]?.total ?? 0 }));
  return ok({ items, groups, total: groups.reduce((n, g) => n + g.count, 0), perGroup: PER_GROUP });
}

function discoveryScope(criteria: unknown, provider: string) {
  const parsed = discoveryCriteriaSchema.safeParse(criteria);
  const area = parsed.success ? [parsed.data.prefecture, parsed.data.city].filter(Boolean).join(" ") : "";
  return `${area ? `${area} · ` : ""}${provider === "fixture" ? "架空企業の収集" : "企業情報の収集"}`;
}
