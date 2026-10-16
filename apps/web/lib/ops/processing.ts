import { type Actor, type Clock, err, ok } from "@siteoffer/core";
import {
  companies,
  contracts,
  type DbOrTx,
  deliveries,
  deliveryBuilds,
  designVersions,
  discoveryJobs,
  proposalVersions,
  users,
  workerRuntimes,
} from "@siteoffer/db";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { currentDeliveryBuild, deliveryNeedsAttention, deliveryProcessingState } from "./delivery-processing";
import { isUuid } from "./form";

export const PROCESSING_LIMIT = 20;
export const WORKER_FRESH_MS = 45_000;
export const PHASE_LABELS = {
  starting: "受付を起動中",
  designs: "サイト制作の依頼を受付中",
  images: "画像生成を処理中",
  discovery: "収集の依頼を受付中",
  deliveries: "納品サイトを制作中",
  idle: "次の受付を待機中",
  error: "受付処理でエラー",
} as const;
type Runtime = typeof workerRuntimes.$inferSelect;
export function assessWorkers(rows: Runtime[], now: Date) {
  const workers = rows.map((w) => {
    const age = now.getTime() - w.heartbeatAt.getTime();
    // A future heartbeat cannot establish liveness when machine clocks disagree.
    const live = age >= -5000 && age <= WORKER_FRESH_MS;
    const c = w.capabilities;
    const known =
      c?.version === 1 &&
      typeof c.discoveryOnly === "boolean" &&
      typeof c.imageConfigured === "boolean" &&
      Number.isFinite(c.intakeIntervalMs) &&
      c.intakeIntervalMs > 0;
    const p = w.progress;
    const phase = p && Object.hasOwn(PHASE_LABELS, p.phase) ? p.phase : null;
    const since = p?.since ? new Date(p.since) : null;
    return {
      id: w.id,
      live,
      heartbeatAt: w.heartbeatAt.toISOString(),
      image: !!known && !c!.discoveryOnly && c!.imageConfigured,
      site: !!known && !c!.discoveryOnly,
      known,
      generator: known && ["mock", "codex"].includes(c!.generator) ? c!.generator : "unknown",
      phase,
      since: since && Number.isFinite(since.getTime()) ? since.toISOString() : null,
      intakeOverdue:
        live &&
        !!known &&
        (phase === "idle" || phase === "starting") &&
        !!since &&
        Number.isFinite(since.getTime()) &&
        now.getTime() - since.getTime() > Math.max(60_000, c!.intakeIntervalMs * 3),
      completedAt: p?.completedAt && Number.isFinite(Date.parse(p.completedAt)) ? p.completedAt : null,
      mode: w.mode === "demo" ? "demo" : "standard",
    };
  });
  const live = workers.filter((w) => w.live);
  function capability(kind: "image" | "site") {
    const capable = live.filter((w) => w[kind]);
    if (!live.length)
      return {
        status: "unavailable",
        label: "稼働を確認できません",
        detail:
          "45秒以内の通知がありません。ワーカーの起動・DB接続を確認してください。依頼済みの処理を重ねて登録する必要はありません。",
      };
    if (!capable.length)
      return live.some((w) => !w.known)
        ? {
            status: "unknown",
            label: "対応状況が未確認",
            detail: "旧ワーカーからの稼働通知があります。更新したワーカーで起動し直すと、対応する処理を確認できます。",
          }
        : {
            status: "unavailable",
            label: "対応するワーカーがありません",
            detail:
              kind === "image"
                ? "画像生成の設定がある制作ワーカーが必要です。用意した画像の取り込みは利用できます。"
                : "収集専用のワーカーではサイトを制作できません。制作を有効にしたワーカーが必要です。",
          };
    if (capable.every((w) => w.phase === "error" || w.intakeOverdue))
      return {
        status: "attention",
        label: "受付処理を確認してください",
        detail:
          "対応するワーカーで受付エラー、または受付待機の更新遅れが見つかりました。処理履歴とワーカーのログを確認してください。",
      };
    if (kind === "site" && new Set(capable.map((w) => w.generator)).size > 1)
      return {
        status: "attention",
        label: "生成方式が混在しています",
        detail:
          "実生成と動作確認用など、制作ワーカーの設定が揃っていません。依頼を処理する方式を管理者が確認してください。",
      };
    const mock = kind === "site" && capable.every((w) => w.generator === "mock");
    return {
      status: "ready",
      label: mock ? "動作確認用の制作が稼働中" : "対応するワーカーが稼働中",
      detail: mock
        ? "架空データを使うモック制作です。実AIによる制作ではありません。"
        : "稼働通知と対応設定を確認しました。個別のAPI接続・処理の成功は実行結果で確認します。",
    };
  }
  return { workers, image: capability("image"), site: capability("site") };
}
export async function getProcessingOverview(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  companyId?: string,
  requestedPages: Partial<Record<"discovery" | "images" | "sites" | "deliveries", number>> = {},
  deliveryState: "all" | "stopped" = "all",
) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  if (!u) return err("forbidden");
  if (companyId && !isUuid(companyId)) return err("invalid_input");
  const now = clock.now();
  const total = sql<number>`count(*) over ()`.mapWith(Number);
  const proposalState = sql<
    string | null
  >`(select ${proposalVersions.status} from ${proposalVersions} where ${proposalVersions.content}->>'designVersionId' = ${designVersions.id}::text order by ${proposalVersions.version} desc limit 1)`;
  const discoveryWhere = inArray(discoveryJobs.status, ["queued", "running"]);
  const imageWhere = and(
    inArray(designVersions.status, ["queued", "generating"]),
    companyId ? eq(companies.id, companyId) : undefined,
  );
  const siteWhere = and(
    eq(designVersions.status, "approved"),
    isNotNull(designVersions.buildRequestedAt),
    sql`(${proposalState} is null or ${proposalState} = 'generating')`,
    companyId ? eq(companies.id, companyId) : undefined,
  );
  const deliveryWhere = and(
    eq(deliveries.status, "building"),
    eq(contracts.status, "completed"),
    isNull(deliveries.lockedVersionId),
    companyId ? eq(companies.id, companyId) : undefined,
    deliveryState === "stopped" ? deliveryNeedsAttention(now) : undefined,
  );
  const [dc, ic, sc, bc] = await Promise.all([
    companyId
      ? Promise.resolve([{ total: 0 }])
      : db.select({ total: count() }).from(discoveryJobs).where(discoveryWhere),
    db
      .select({ total: count() })
      .from(designVersions)
      .innerJoin(companies, eq(companies.id, designVersions.companyId))
      .where(imageWhere),
    db
      .select({ total: count() })
      .from(designVersions)
      .innerJoin(companies, eq(companies.id, designVersions.companyId))
      .where(siteWhere),
    db
      .select({ total: count() })
      .from(deliveries)
      .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
      .innerJoin(companies, eq(companies.id, contracts.companyId))
      .leftJoin(deliveryBuilds, currentDeliveryBuild)
      .where(deliveryWhere),
  ]);
  const pagination = (total: number, requested: number | undefined) => {
    const pages = Math.max(1, Math.ceil(total / PROCESSING_LIMIT));
    return { total, pages, page: Math.min(pages, Math.max(1, Number.isSafeInteger(requested) ? requested! : 1)) };
  };
  const paging = {
    discovery: pagination(dc[0]?.total ?? 0, requestedPages.discovery),
    images: pagination(ic[0]?.total ?? 0, requestedPages.images),
    sites: pagination(sc[0]?.total ?? 0, requestedPages.sites),
    deliveries: pagination(bc[0]?.total ?? 0, requestedPages.deliveries),
  };
  const [runtime, discovery, images, sites, deliveryRows, company] = await Promise.all([
    db.select().from(workerRuntimes).orderBy(desc(workerRuntimes.heartbeatAt)),
    companyId
      ? Promise.resolve([])
      : db
          .select({
            id: discoveryJobs.id,
            provider: discoveryJobs.provider,
            status: discoveryJobs.status,
            createdAt: discoveryJobs.createdAt,
            startedAt: discoveryJobs.startedAt,
            total,
          })
          .from(discoveryJobs)
          .where(discoveryWhere)
          .orderBy(asc(discoveryJobs.createdAt), asc(discoveryJobs.id))
          .limit(PROCESSING_LIMIT)
          .offset((paging.discovery.page - 1) * PROCESSING_LIMIT),
    db
      .select({
        id: designVersions.id,
        companyId: companies.id,
        companyName: companies.name,
        version: designVersions.version,
        status: designVersions.status,
        since: sql<Date>`coalesce(${designVersions.startedAt}, ${designVersions.createdAt})`.mapWith(
          designVersions.createdAt,
        ),
        total,
      })
      .from(designVersions)
      .innerJoin(companies, eq(companies.id, designVersions.companyId))
      .where(imageWhere)
      .orderBy(asc(designVersions.createdAt), asc(designVersions.id))
      .limit(PROCESSING_LIMIT)
      .offset((paging.images.page - 1) * PROCESSING_LIMIT),
    db
      .select({
        id: designVersions.id,
        companyId: companies.id,
        companyName: companies.name,
        version: designVersions.version,
        status: proposalState,
        since: designVersions.buildRequestedAt,
        total,
      })
      .from(designVersions)
      .innerJoin(companies, eq(companies.id, designVersions.companyId))
      .where(siteWhere)
      .orderBy(asc(designVersions.buildRequestedAt), asc(designVersions.id))
      .limit(PROCESSING_LIMIT)
      .offset((paging.sites.page - 1) * PROCESSING_LIMIT),
    db
      .select({
        id: deliveries.id,
        companyId: companies.id,
        companyName: companies.name,
        status: deliveryBuilds.status,
        leaseUntil: deliveryBuilds.leaseUntil,
        since:
          sql<Date>`case when ${deliveryBuilds.status} = 'running' and (${deliveryNeedsAttention(now)}) then coalesce(${deliveryBuilds.leaseUntil}, ${deliveryBuilds.startedAt}, ${deliveryBuilds.createdAt}, ${deliveries.updatedAt}) else coalesce(${deliveryBuilds.finishedAt}, ${deliveryBuilds.startedAt}, ${deliveryBuilds.createdAt}, ${deliveries.updatedAt}) end`.mapWith(
            deliveries.updatedAt,
          ),
        total,
      })
      .from(deliveries)
      .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
      .innerJoin(companies, eq(companies.id, contracts.companyId))
      .leftJoin(deliveryBuilds, currentDeliveryBuild)
      .where(deliveryWhere)
      .orderBy(asc(deliveries.updatedAt), asc(deliveries.id))
      .limit(PROCESSING_LIMIT)
      .offset((paging.deliveries.page - 1) * PROCESSING_LIMIT),
    companyId
      ? db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId))
      : Promise.resolve([]),
  ]);
  if (companyId && !company.length) return err("not_found");
  return ok({
    ...assessWorkers(runtime, now),
    discovery,
    images,
    sites,
    deliveries: deliveryRows.map(({ status, leaseUntil, ...row }) => ({
      ...row,
      state: deliveryProcessingState(status, leaseUntil, now),
    })),
    paging,
    companyName: company[0]?.name ?? null,
    updatedAt: now.toISOString(),
  });
}
