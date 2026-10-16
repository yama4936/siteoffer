import { type Actor, type Clock, err, ok, systemClock } from "@siteoffer/core";
import {
  assignments,
  companies,
  consultationCases,
  contracts,
  type DbOrTx,
  deliveries,
  deliveryBuilds,
  designVersions,
  discoveryJobs,
  domainPreferences,
  proposalHandoffs,
  proposals,
  proposalVersions,
  salesActivities,
  siteAudits,
  users,
} from "@siteoffer/db";
import { discoveryCriteriaSchema } from "@siteoffer/discovery";
import { getAuditRecoveryCandidates } from "@siteoffer/worker/audit-recovery";
import { and, asc, eq, gt, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { currentDeliveryBuild, deliveryNeedsAttention } from "./delivery-processing";
import { isUuid } from "./form";
import { requireOps } from "./guard";

export const WORK_GROUPS = {
  discovery: { label: "収集の復旧", href: "/ops/discovery" },
  audit_recovery: { label: "診断の再開", href: "/ops/processing#audit-recovery" },
  design: { label: "デザイン", href: "/ops/designs" },
  proposal: { label: "提案レビュー", href: "/ops/review" },
  consultation: { label: "営業からの相談", href: "/ops/consultations" },
  assignment: { label: "担当の調整", href: "/ops/assignments" },
  contract: { label: "契約確認", href: "/ops/contracts" },
  delivery_start: { label: "制作の着手", href: "/ops/delivery#delivery-start" },
  domain: { label: "ドメイン確認", href: "/ops/delivery#domain-preferences" },
  delivery_recovery: { label: "制作の復旧", href: "/ops/processing?deliveryState=stopped#processing-deliveries" },
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
export async function getOpsWorkQueue(db: DbOrTx, actor: Actor | null, clock: Clock = systemClock) {
  const auth = requireOps(actor);
  if (!auth.ok) return auth;
  if (!isUuid(auth.value.userId)) return err("forbidden");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, auth.value.userId), eq(users.role, "ops"), eq(users.status, "active")));
  if (!user) return err("forbidden");
  const now = clock.now();
  const newerDesign = alias(designVersions, "newer_design");
  const newerProposal = alias(proposalVersions, "newer_proposal");
  const retried = alias(discoveryJobs, "retried");
  const activeCompany = eq(companies.suppression, "none");
  const [
    failed,
    design,
    proposal,
    assignment,
    contract,
    delivery,
    website,
    preparation,
    deliveryStart,
    domain,
    consultation,
    deliveryRecovery,
    auditRecovery,
  ] = await Promise.all([
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
        and(
          eq(contracts.status, "completed"),
          inArray(deliveries.status, ["info_gathering", "ops_review", "ready", "published"]),
        ),
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
          sql`exists (select 1 from ${siteAudits} where ${siteAudits.companyId} = ${companies.id}
            and ${siteAudits.status} = 'evaluated' and ${siteAudits.decision} = 'create'
            and ${siteAudits.id} = (select latest.id from site_audits latest where latest.company_id = ${companies.id}
              order by latest.created_at desc, latest.id desc limit 1)
            and not exists (select 1 from ${proposalHandoffs} where ${proposalHandoffs.auditId} = ${siteAudits.id}))`,
          notExists(
            db.select({ id: designVersions.id }).from(designVersions).where(eq(designVersions.companyId, companies.id)),
          ),
        ),
      )
      .orderBy(asc(companies.updatedAt), asc(companies.id))
      .limit(PER_GROUP),
    db
      .select({
        id: contracts.id,
        name: companies.name,
        since: sql<Date>`coalesce(${contracts.completedAt}, ${contracts.reportedAt})`.mapWith(contracts.reportedAt),
        total,
      })
      .from(contracts)
      .innerJoin(companies, eq(companies.id, contracts.companyId))
      .where(
        and(
          eq(contracts.status, "completed"),
          notExists(db.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.contractId, contracts.id))),
        ),
      )
      .orderBy(asc(contracts.completedAt), asc(contracts.reportedAt), asc(contracts.id))
      .limit(PER_GROUP),
    db
      .select({ id: domainPreferences.id, name: companies.name, since: domainPreferences.updatedAt, total })
      .from(domainPreferences)
      .innerJoin(companies, eq(companies.id, domainPreferences.companyId))
      // 契約後の聞き取りも対象。営業抑止や担当終了は、運営確認済みを意味しない。
      .where(isNull(domainPreferences.confirmedAt))
      .orderBy(asc(domainPreferences.updatedAt), asc(domainPreferences.id))
      .limit(PER_GROUP),
    db
      .select({
        id: salesActivities.id,
        name: companies.name,
        since: sql<Date>`coalesce(${consultationCases.updatedAt}, ${salesActivities.createdAt})`.mapWith(
          salesActivities.createdAt,
        ),
        total,
      })
      .from(salesActivities)
      .innerJoin(companies, eq(companies.id, salesActivities.companyId))
      .leftJoin(consultationCases, eq(consultationCases.activityId, salesActivities.id))
      .where(
        and(eq(salesActivities.consultOps, true), sql`coalesce(${consultationCases.status}, 'open') <> 'resolved'`),
      )
      .orderBy(
        asc(sql`coalesce(${consultationCases.updatedAt}, ${salesActivities.createdAt})`),
        asc(salesActivities.id),
      )
      .limit(PER_GROUP),
    db
      .select({
        id: deliveries.id,
        name: companies.name,
        status: deliveryBuilds.status,
        since:
          sql<Date>`case when ${deliveryBuilds.status} = 'failed' then coalesce(${deliveryBuilds.finishedAt}, ${deliveryBuilds.createdAt}) else coalesce(${deliveryBuilds.leaseUntil}, ${deliveryBuilds.startedAt}, ${deliveryBuilds.createdAt}) end`.mapWith(
            deliveryBuilds.createdAt,
          ),
        total,
      })
      .from(deliveries)
      .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
      .innerJoin(companies, eq(companies.id, contracts.companyId))
      .innerJoin(deliveryBuilds, currentDeliveryBuild)
      .where(
        and(
          eq(contracts.status, "completed"),
          eq(deliveries.status, "building"),
          isNull(deliveries.lockedVersionId),
          deliveryNeedsAttention(now),
        ),
      )
      .orderBy(
        asc(
          sql`case when ${deliveryBuilds.status} = 'failed' then coalesce(${deliveryBuilds.finishedAt}, ${deliveryBuilds.createdAt}) else coalesce(${deliveryBuilds.leaseUntil}, ${deliveryBuilds.startedAt}, ${deliveryBuilds.createdAt}) end`,
        ),
        asc(deliveries.id),
      )
      .limit(PER_GROUP),
    getAuditRecoveryCandidates(db, actor),
  ]);
  if (!auditRecovery.ok) return auditRecovery;
  const items: WorkItem[] = [
    ...auditRecovery.value.items.map((r) => ({
      id: r.auditId,
      group: "audit_recovery" as const,
      title: r.companyName,
      reason: r.blockedReason ?? "診断は保存済みです。採点を繰り返さず、停止した判定の反映から再開できます。",
      action: r.blockedReason ? "企業情報を確認" : "保存済み結果で再開",
      href: r.blockedReason ? `/ops/companies/${r.companyId}` : `/ops/processing?company=${r.companyId}#audit-recovery`,
      since: r.createdAt,
      priority: 0,
    })),
    ...deliveryRecovery.map((r) => ({
      id: r.id,
      group: "delivery_recovery" as const,
      title: r.name,
      reason:
        r.status === "failed"
          ? "納品サイトの制作が停止しています。停止理由を確認して再試行できます。"
          : "納品サイトの制作処理との接続が途切れました。ワーカーの状態を確認して再試行できます。",
      action: "停止理由・再試行を確認",
      href: `/ops/delivery?focus=${r.id}#delivery-${r.id}`,
      since: r.since.toISOString(),
      priority: 0,
    })),
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
    ...consultation.map((r) => ({
      id: r.id,
      group: "consultation" as const,
      title: r.name,
      reason: "営業からの相談が未完了です。経緯と対応状況を確認し、次に行うことを回答してください。",
      action: "相談を確認・回答",
      href: `/ops/consultations?focus=${r.id}`,
      since: r.since.toISOString(),
      priority: 1,
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
        r.status === "published"
          ? "公開の記録があります。実際の公開状況と引き渡しを確認し、納品完了を記録してください。"
          : r.status === "ready"
            ? "顧客確認が済みました。公開に必要な情報と手続きを確認してください。"
            : r.status === "ops_review"
              ? "納品サイトが運営の確認を待っています。"
              : "制作に必要な情報を揃える段階です。",
      action: "制作・公開を確認",
      href: `/ops/delivery?focus=${r.id}#delivery-${r.id}`,
      since: r.since.toISOString(),
      priority: r.status === "info_gathering" ? 3 : 2,
    })),
    ...deliveryStart.map((r) => ({
      id: r.id,
      group: "delivery_start" as const,
      title: r.name,
      reason: "契約確認が完了しました。制作に必要な情報を確認するため、納品の管理を開始してください。",
      action: "制作の準備を始める",
      href: `/ops/delivery?contract=${r.id}#contract-start-${r.id}`,
      since: r.since.toISOString(),
      priority: 2,
    })),
    ...domain.map((r) => ({
      id: r.id,
      group: "domain" as const,
      title: r.name,
      reason: "ドメインの聞き取り内容が未確認です。希望・管理者・メール利用への影響を確認してください。",
      action: "聞き取り内容を確認",
      href: `/ops/delivery?domain=${r.id}#domain-${r.id}`,
      since: r.since.toISOString(),
      priority: 2,
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
    audit_recovery: [{ total: auditRecovery.value.total }],
    design,
    proposal,
    assignment,
    consultation,
    contract,
    delivery_recovery: deliveryRecovery,
    delivery_start: deliveryStart,
    domain,
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
