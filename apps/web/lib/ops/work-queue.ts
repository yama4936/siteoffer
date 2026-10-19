import { type Actor, type Clock, err, getPublicationMaterialWork, ok, type Result, systemClock } from "@siteoffer/core";
import {
  assignments,
  auditRequests,
  companies,
  consultationCases,
  contracts,
  type DbOrTx,
  deliveries,
  deliveryBuilds,
  designVersions,
  discoveryJobs,
  domainPreferences,
  imageAssets,
  imageSubmissions,
  proposalHandoffs,
  proposals,
  proposalVersions,
  runReadQueries,
  salesActivities,
  siteAudits,
  users,
} from "@siteoffer/db";
import { discoveryCriteriaSchema } from "@siteoffer/discovery";
import { listAuditPreparation } from "@siteoffer/worker/audit-preparation";
import { getAuditAttentionWork } from "@siteoffer/worker/audit-recovery";
import { and, asc, eq, gt, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { currentDeliveryBuild, deliveryNeedsAttention } from "./delivery-processing";
import { isUuid } from "./form";
import { requireOps } from "./guard";
import { getReviewInbox } from "./review-inbox";

import { WORK_GROUPS, type WorkGroup, type WorkItem } from "./work-model";

export { WORK_GROUPS, type WorkGroup, type WorkItem } from "./work-model";
export type WorkQueueData = {
  items: WorkItem[];
  groups: { key: WorkGroup; label: string; href: string; count: number }[];
  total: number;
  perGroup: number;
};
type QueueResult = Result<WorkQueueData, "forbidden" | "invalid_input">;
export type WorkReadOptions = {
  query?: string;
  limit?: number;
  offsets?: Partial<Record<WorkGroup, number>>;
  only?: WorkGroup[];
  publicationAfter?: { since: string; id: string };
};
const PER_GROUP = 20;
const total = sql<number>`count(*) over ()`.mapWith(Number);

/** Only current, actionable versions enter the queue. Large image/PDF bodies are never selected. */
export async function getOpsWorkQueue(
  db: DbOrTx,
  actor: Actor | null,
  clock: Clock = systemClock,
  input: WorkReadOptions = {},
): Promise<QueueResult> {
  const auth = requireOps(actor);
  if (!auth.ok) return auth;
  if (!isUuid(auth.value.userId)) return err("forbidden");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, auth.value.userId), eq(users.role, "ops"), eq(users.status, "active")));
  if (!user) return err("forbidden");
  if (
    (input.query?.length ?? 0) > 200 ||
    (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)) ||
    Object.values(input.offsets ?? {}).some((n) => !Number.isSafeInteger(n) || n < 0 || n > 2147483647)
  )
    return err("invalid_input");
  const query = input.query?.trim() ?? "";
  const readLimit = input.limit ?? PER_GROUP;
  if (query) return searchWorkQueue(db, actor, clock, input, query, readLimit);
  const include = (group: WorkGroup) => !input.only || input.only.includes(group);
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
    auditAttention,
    auditPreparation,
    salesReady,
    materialReview,
    publicationReview,
  ] = await runReadQueries(db, [
    () =>
      include("discovery")
        ? db
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
                notExists(
                  db.select({ id: retried.id }).from(retried).where(eq(retried.retryOfJobId, discoveryJobs.id)),
                ),
              ),
            )
            .orderBy(asc(sql`date_trunc('milliseconds', ${discoveryJobs.createdAt})`), asc(discoveryJobs.id))
            .limit(readLimit)
            .offset(input.offsets?.discovery ?? 0)
        : Promise.resolve([]),
    () =>
      include("design")
        ? db
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
              asc(sql`date_trunc('milliseconds', ${designVersions.createdAt})`),
              asc(designVersions.id),
            )
            .limit(readLimit)
            .offset(input.offsets?.design ?? 0)
        : Promise.resolve([]),
    () =>
      include("proposal")
        ? db
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
              asc(sql`date_trunc('milliseconds', ${proposalVersions.createdAt})`),
              asc(proposalVersions.id),
            )
            .limit(readLimit)
            .offset(input.offsets?.proposal ?? 0)
        : Promise.resolve([]),
    () =>
      include("assignment")
        ? db
            .select({ id: assignments.id, name: companies.name, since: assignments.createdAt, total })
            .from(assignments)
            .innerJoin(companies, eq(companies.id, assignments.companyId))
            .where(and(eq(assignments.status, "awaiting_ops")))
            .orderBy(asc(sql`date_trunc('milliseconds', ${assignments.createdAt})`), asc(assignments.id))
            .limit(readLimit)
            .offset(input.offsets?.assignment ?? 0)
        : Promise.resolve([]),
    () =>
      include("contract")
        ? db
            .select({ id: contracts.id, name: companies.name, since: contracts.reportedAt, total })
            .from(contracts)
            .innerJoin(companies, eq(companies.id, contracts.companyId))
            .where(and(inArray(contracts.status, ["reported", "under_review"])))
            .orderBy(asc(sql`date_trunc('milliseconds', ${contracts.reportedAt})`), asc(contracts.id))
            .limit(readLimit)
            .offset(input.offsets?.contract ?? 0)
        : Promise.resolve([]),
    () =>
      include("delivery")
        ? db
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
            .orderBy(
              sql`case when ${deliveries.status}='info_gathering' then 3 else 2 end`,
              asc(sql`date_trunc('milliseconds', ${deliveries.updatedAt})`),
              asc(deliveries.id),
            )
            .limit(readLimit)
            .offset(input.offsets?.delivery ?? 0)
        : Promise.resolve([]),
    () =>
      include("website")
        ? db
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
            .orderBy(asc(sql`date_trunc('milliseconds', ${companies.createdAt})`), asc(companies.id))
            .limit(readLimit)
            .offset(input.offsets?.website ?? 0)
        : Promise.resolve([]),
    () =>
      include("preparation")
        ? db
            .select({ id: companies.id, name: companies.name, since: companies.updatedAt, total })
            .from(companies)
            .where(
              and(
                activeCompany,
                eq(companies.pipelineStatus, "audited"),
                sql`not exists(select 1 from ${auditRequests} where ${auditRequests.companyId}=${companies.id} and ${auditRequests.finishedAt} is null)`,
                sql`exists (select 1 from ${siteAudits} where ${siteAudits.companyId} = ${companies.id}
            and ${siteAudits.status} = 'evaluated' and ${siteAudits.decision} = 'create'
            and ${siteAudits.id} = (select latest.id from site_audits latest where latest.company_id = ${companies.id}
              order by latest.created_at desc, latest.id desc limit 1)
            and not exists (select 1 from ${proposalHandoffs} where ${proposalHandoffs.auditId} = ${siteAudits.id}))`,
                notExists(
                  db
                    .select({ id: designVersions.id })
                    .from(designVersions)
                    .where(eq(designVersions.companyId, companies.id)),
                ),
              ),
            )
            .orderBy(asc(sql`date_trunc('milliseconds', ${companies.updatedAt})`), asc(companies.id))
            .limit(readLimit)
            .offset(input.offsets?.preparation ?? 0)
        : Promise.resolve([]),
    () =>
      include("delivery_start")
        ? db
            .select({
              id: contracts.id,
              name: companies.name,
              since: sql<Date>`coalesce(${contracts.completedAt}, ${contracts.reportedAt})`.mapWith(
                contracts.reportedAt,
              ),
              total,
            })
            .from(contracts)
            .innerJoin(companies, eq(companies.id, contracts.companyId))
            .where(
              and(
                eq(contracts.status, "completed"),
                notExists(
                  db.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.contractId, contracts.id)),
                ),
              ),
            )
            .orderBy(
              asc(sql`date_trunc('milliseconds', coalesce(${contracts.completedAt}, ${contracts.reportedAt}))`),
              asc(contracts.id),
            )
            .limit(readLimit)
            .offset(input.offsets?.delivery_start ?? 0)
        : Promise.resolve([]),
    () =>
      include("domain")
        ? db
            .select({ id: domainPreferences.id, name: companies.name, since: domainPreferences.updatedAt, total })
            .from(domainPreferences)
            .innerJoin(companies, eq(companies.id, domainPreferences.companyId))
            // 契約後の聞き取りも対象。営業抑止や担当終了は、運営確認済みを意味しない。
            .where(and(isNull(domainPreferences.confirmedAt)))
            .orderBy(asc(sql`date_trunc('milliseconds', ${domainPreferences.updatedAt})`), asc(domainPreferences.id))
            .limit(readLimit)
            .offset(input.offsets?.domain ?? 0)
        : Promise.resolve([]),
    () =>
      include("consultation")
        ? db
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
              and(
                eq(salesActivities.consultOps, true),
                sql`coalesce(${consultationCases.status}, 'open') <> 'resolved'`,
              ),
            )
            .orderBy(
              asc(
                sql`date_trunc('milliseconds', coalesce(${consultationCases.updatedAt}, ${salesActivities.createdAt}))`,
              ),
              asc(salesActivities.id),
            )
            .limit(readLimit)
            .offset(input.offsets?.consultation ?? 0)
        : Promise.resolve([]),
    () =>
      include("delivery_recovery")
        ? db
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
                sql`date_trunc('milliseconds', case when ${deliveryBuilds.status} = 'failed' then coalesce(${deliveryBuilds.finishedAt}, ${deliveryBuilds.createdAt}) else coalesce(${deliveryBuilds.leaseUntil}, ${deliveryBuilds.startedAt}, ${deliveryBuilds.createdAt}) end)`,
              ),
              asc(deliveries.id),
            )
            .limit(readLimit)
            .offset(input.offsets?.delivery_recovery ?? 0)
        : Promise.resolve([]),
    () =>
      include("audit_attention")
        ? getAuditAttentionWork(db, actor, { query, offset: input.offsets?.audit_attention ?? 0, limit: readLimit })
        : Promise.resolve(ok({ total: 0, items: [] })),
    () =>
      include("audit_preparation")
        ? listAuditPreparation(db, actor, { query, offset: input.offsets?.audit_preparation ?? 0, limit: readLimit })
        : Promise.resolve(ok({ total: 0, items: [] })),
    () =>
      include("sales_ready")
        ? getReviewInbox(db, actor, { view: "ready", query, offset: input.offsets?.sales_ready ?? 0, limit: readLimit })
        : Promise.resolve(ok({ total: 0, items: [] })),
    () =>
      include("materials")
        ? db
            .select({
              id: imageAssets.id,
              companyId: companies.id,
              name: companies.name,
              label: imageAssets.label,
              since: imageSubmissions.updatedAt,
              total,
            })
            .from(imageSubmissions)
            .innerJoin(imageAssets, eq(imageAssets.id, imageSubmissions.assetId))
            .innerJoin(companies, eq(companies.id, imageAssets.companyId))
            .where(and(eq(imageSubmissions.status, "pending")))
            .orderBy(asc(sql`date_trunc('milliseconds', ${imageSubmissions.updatedAt})`), asc(imageAssets.id))
            .limit(readLimit)
            .offset(input.offsets?.materials ?? 0)
        : Promise.resolve([]),
    () =>
      include("publication_materials")
        ? getPublicationMaterialWork(db, actor, {
            query,
            limit: readLimit,
            ...(input.publicationAfter ? { after: input.publicationAfter } : {}),
          })
        : Promise.resolve({ total: 0, items: [] }),
  ]);
  if (!auditAttention.ok) return auditAttention;
  if (!auditPreparation.ok) return auditPreparation;
  if (!salesReady.ok) return salesReady;
  const items: WorkItem[] = [
    ...materialReview.map((r) => ({
      id: r.id,
      group: "materials" as const,
      title: r.name,
      reason: `${r.label} · 顧客から届いた画像と、申告された利用許可の確認待ちです。`,
      action: "画像と利用許可を確認",
      href: `/ops/materials?company=${r.companyId}&focus=${r.id}&all=1#material-${r.id}`,
      since: r.since.toISOString(),
      priority: 2,
    })),
    ...publicationReview.items.map(publicationWorkItem),
    ...salesReady.value.items.map((r) => ({
      id: r.id,
      group: "sales_ready" as const,
      title: r.name,
      reason: `第${r.version}版は承認済みです。販売条件を確認して営業へ引き継げます。`,
      action: "販売条件を確認",
      href: `/ops/review/ready?company=${r.id}`,
      since: r.since,
      priority: 2,
    })),
    ...auditPreparation.value.items.map((r) => ({
      id: r.companyId,
      group: "audit_preparation" as const,
      title: r.companyName,
      reason: r.blockedReason ?? "公式サイトは確認済みです。対象を確認すると診断を依頼できます。",
      action: r.blockedReason ? "公式サイトを確認" : "対象を確認して診断",
      href: r.blockedReason
        ? `/ops/companies/${r.companyId}`
        : `/ops/processing?company=${r.companyId}#audit-preparation`,
      since: r.createdAt,
      priority: 3,
    })),
    ...auditAttention.value.items.map((r) => ({
      id: r.id,
      group: "audit_attention" as const,
      title: r.companyName,
      reason:
        r.blockedReason ?? r.reason ?? "診断は保存済みです。採点を繰り返さず、停止した判定の反映から再開できます。",
      action: r.kind === "request" ? "診断・企業情報を確認" : r.blockedReason ? "企業情報を確認" : "保存済み結果で再開",
      href:
        r.kind === "request"
          ? `/ops/companies/${r.companyId}#audit-request`
          : r.blockedReason
            ? `/ops/companies/${r.companyId}`
            : `/ops/processing?company=${r.companyId}#audit-recovery`,
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
    materials: materialReview,
    publication_materials: [{ total: publicationReview.total }],
    discovery: failed,
    audit_attention: [{ total: auditAttention.value.total }],
    audit_preparation: [{ total: auditPreparation.value.total }],
    design,
    proposal,
    sales_ready: [{ total: salesReady.value.total }],
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
  return ok({ items, groups, total: groups.reduce((n, g) => n + g.count, 0), perGroup: readLimit });
}

function discoveryScope(criteria: unknown, provider: string) {
  const parsed = discoveryCriteriaSchema.safeParse(criteria);
  const area = parsed.success ? [parsed.data.prefecture, parsed.data.city].filter(Boolean).join(" ") : "";
  return `${area ? `${area} · ` : ""}${provider === "fixture" ? "架空企業の収集" : "企業情報の収集"}`;
}

type PublicationWork = Awaited<ReturnType<typeof getPublicationMaterialWork>>["items"][number];
function publicationWorkItem(r: PublicationWork): WorkItem {
  return {
    id: r.id,
    group: "publication_materials" as const,
    title: r.companyName,
    reason: `第${r.version}版 · ${r.environment} · ${r.reason}。元の公開先への影響を確認してください。`,
    action: "公開先の対応を確認",
    href: `/ops/publication-checks?delivery=${r.deliveryId}&focus=${r.id}&mode=all#publication-${r.id}`,
    since: r.since,
    priority: 0,
    attentionLabel: "公開後の確認",
  };
}
function matchesWork(item: WorkItem, query: string) {
  return `${item.title} ${item.reason} ${item.action}`.toLocaleLowerCase("ja").includes(query);
}
/** Exact title/reason search, including derived policy and recovery explanations. Scan bounded metadata windows only. */
async function searchWorkQueue(
  db: DbOrTx,
  actor: Actor | null,
  clock: Clock,
  input: WorkReadOptions,
  text: string,
  limit: number,
): Promise<QueueResult> {
  const query = text.toLocaleLowerCase("ja"),
    items: WorkItem[] = [],
    groups = Object.entries(WORK_GROUPS).map(([key, value]) => ({ key: key as WorkGroup, ...value, count: 0 }));
  for (const group of groups) {
    if (input.only && !input.only.includes(group.key)) continue;
    if (group.key === "publication_materials") {
      const result = await getPublicationMaterialWork(db, actor, {
        limit,
        matches: (r) => matchesWork(publicationWorkItem(r), query),
        ...(input.publicationAfter ? { after: input.publicationAfter } : {}),
      });
      group.count = result.total;
      items.push(...result.items.map(publicationWorkItem));
      continue;
    }
    const skip = input.offsets?.[group.key] ?? 0;
    let scanned = 0,
      matched = 0;
    for (;;) {
      const result = await getOpsWorkQueue(db, actor, clock, {
        only: [group.key],
        offsets: { [group.key]: scanned },
        limit: 500,
      });
      if (!result.ok) return result;
      const count = result.value.groups.find((g) => g.key === group.key)!.count;
      for (const item of result.value.items) {
        if (!matchesWork(item, query)) continue;
        if (matched >= skip && matched < skip + limit) items.push(item);
        matched++;
      }
      scanned += result.value.items.length;
      if (!result.value.items.length || scanned >= count) break;
    }
    group.count = matched;
  }
  items.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.since.localeCompare(b.since) ||
      a.id.localeCompare(b.id) ||
      a.group.localeCompare(b.group),
  );
  return ok({ items, groups, total: groups.reduce((n, g) => n + g.count, 0), perGroup: limit });
}
