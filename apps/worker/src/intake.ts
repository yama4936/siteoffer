import { randomUUID } from "node:crypto";
import path from "node:path";
import { siteGenerationToSiteInput } from "@siteoffer/astro-site";
import {
  type Actor,
  claimDeliveryBuild,
  completeDeliveryBuild,
  type DeliveryBuildClaim,
  failDeliveryBuild,
  INTERRUPTED_BUILD_MESSAGE,
  renewDeliveryBuild,
} from "@siteoffer/core";
import type { IntakePhase } from "@siteoffer/db";
import {
  companies,
  contentEntries,
  contracts,
  deliveries,
  deliveryBuilds,
  designVersions,
  discoveryJobs,
  proposalVersions,
  siteAudits,
} from "@siteoffer/db";
import { type GenerationDeps, runGenerationJob } from "@siteoffer/generation";
import type { SiteGenerationOutput } from "@siteoffer/schemas";
import { and, asc, desc, eq, getTableColumns, isNull, lte, or } from "drizzle-orm";
import { withDeliveryRevision } from "./delivery-revision.ts";
import type { WorkerDeps } from "./deps.ts";
import { contentSiteUrl, intakeDesignBuilds, processDesignJobs, withDesignReference } from "./design.ts";
import { readStepState } from "./ledger.ts";
import { stopDiscoveryJob } from "./pipeline/discovery.ts";
import { type DiscoveryPayload, QUEUES, stepKeys } from "./queues.ts";

/**
 * DBを定期的に見てジョブを受け付ける処理（webからワーカーへの経路）。
 * - 収集：status=queued の discovery_jobs を収集キューへ送る。
 * - 納品：制作（building）中で、その回の制作版がない納品について、納品サイトを生成・ビルドして版を追加し、運営確認へ回す。
 * webはDBに行を作るだけで、キューには触れない。
 */

export const INTAKE_ACTOR: Actor = { kind: "system", job: "worker-intake" };

/** 1回の受付で拾う上限 */
const BATCH = 20;

export interface IntakeState {
  /** このプロセスで送った収集ジョブ（同じ行を何度も送らない。プロセスをまたぐ二重投入はキューの singletonKey と実行台帳で防ぐ） */
  sentDiscovery: Set<string>;
}

export function createIntakeState(): IntakeState {
  return { sentDiscovery: new Set() };
}

/** status=queued の収集ジョブを収集キューへ送る。送ったジョブIDを返す */
export async function intakeDiscoveryJobs(deps: WorkerDeps, state: IntakeState): Promise<string[]> {
  const rows = await deps.db
    .select({ id: discoveryJobs.id, provider: discoveryJobs.provider })
    .from(discoveryJobs)
    .where(eq(discoveryJobs.status, "queued"))
    .orderBy(asc(discoveryJobs.createdAt))
    .limit(BATCH);
  const sent: string[] = [];
  for (const r of rows) {
    if (!deps.discovery.providers[r.provider]) {
      await stopDiscoveryJob(
        deps,
        r.id,
        `取得元「${r.provider}」はこのワーカーで有効になっていません。設定後に再試行してください`,
      );
      continue;
    }
    const ledger = await readStepState(deps.db, stepKeys.discovery({ discoveryJobId: r.id }));
    if (ledger.gaveUp) {
      await stopDiscoveryJob(deps, r.id, ledger.lastFailure ?? "前回の処理が停止しました。再試行してください");
      continue;
    }
    if (state.sentDiscovery.has(r.id)) continue;
    const payload: DiscoveryPayload = { discoveryJobId: r.id };
    await deps.queue.send(QUEUES.discovery, payload, { singletonKey: stepKeys.discovery(payload) });
    state.sentDiscovery.add(r.id);
    sent.push(r.id);
  }
  if (sent.length) deps.logger.info("収集ジョブを受け付けた", { discoveryJobIds: sent });
  return sent;
}

type DeliveryRow = typeof deliveries.$inferSelect;

/** 制作回のIDで区別する。同じ時刻のやり直しも別の依頼になる。 */
export function deliveryRoundKey(d: Pick<DeliveryRow, "id" | "currentBuildId">): string {
  if (!d.currentBuildId) throw Error("制作回が未受付です");
  return `delivery:${d.id}:${d.currentBuildId}`;
}

export type DeliveryIntakeResult =
  | { deliveryId: string; status: "version_added"; versionId: string; version: number; movedToOpsReview: boolean }
  | { deliveryId: string; status: "moved_to_ops_review"; movedToOpsReview: true }
  | { deliveryId: string; status: "failed"; reason: string }
  | { deliveryId: string; status: "skipped"; reason: string };

/**
 * 制作中（building）で、その回の制作版がない納品に版を作る。
 * DBの実行権限を保持して生成・ビルドし、版追加と運営確認への移行を一括確定する。
 * その回の版がすでにあり、まだ制作中のもの（前回の運営確認への移動が失敗した等）は、移動だけを行う。
 */
export async function intakeDeliveries(deps: WorkerDeps, _state: IntakeState): Promise<DeliveryIntakeResult[]> {
  const rows = await deps.db
    .select(getTableColumns(deliveries))
    .from(deliveries)
    .leftJoin(
      deliveryBuilds,
      and(eq(deliveryBuilds.id, deliveries.currentBuildId), eq(deliveryBuilds.deliveryId, deliveries.id)),
    )
    // 失敗済み・他ワーカーの実行中案件が受付枠を埋めないよう、上限を適用する前に絞る。
    .where(
      and(
        eq(deliveries.status, "building"),
        isNull(deliveries.lockedVersionId),
        or(
          isNull(deliveryBuilds.id),
          eq(deliveryBuilds.status, "queued"),
          and(
            eq(deliveryBuilds.status, "running"),
            or(isNull(deliveryBuilds.leaseUntil), lte(deliveryBuilds.leaseUntil, deps.clock.now())),
          ),
        ),
      ),
    )
    .orderBy(asc(deliveries.updatedAt))
    .limit(BATCH);
  const results: DeliveryIntakeResult[] = [];
  for (const d of rows) {
    const ownerId = randomUUID();
    const claimed = await claimDeliveryBuild(deps.db, deps.clock, INTAKE_ACTOR, d.id, ownerId);
    if (!claimed.ok) {
      if (claimed.error === "interrupted")
        results.push({ deliveryId: d.id, status: "failed", reason: INTERRUPTED_BUILD_MESSAGE });
      continue;
    }
    if (claimed.value.completed) {
      results.push({ deliveryId: d.id, status: "moved_to_ops_review", movedToOpsReview: true });
      continue;
    }
    const current = claimed.value.delivery;
    const claim = { deliveryId: d.id, buildId: current.currentBuildId!, ownerId };
    const controller = new AbortController();
    let ping: Promise<unknown> | null = null;
    const timer = setInterval(() => {
      if (!ping)
        ping = renewDeliveryBuild(deps.db, deps.clock, INTAKE_ACTOR, claim)
          .then((owned) => {
            if (!owned) controller.abort();
          })
          .catch(() => {
            controller.abort();
          })
          .finally(() => {
            ping = null;
          });
    }, 20000);
    timer.unref();
    let r: DeliveryIntakeResult;
    try {
      r = await processDelivery(deps, current, deliveryRoundKey(current), claim, controller.signal);
    } catch {
      r = {
        deliveryId: d.id,
        status: "failed",
        reason: "制作処理を完了できませんでした。ワーカーと設定を確認して再試行してください。",
      };
    } finally {
      clearInterval(timer);
      if (ping) await ping;
    }
    if (r.status === "failed") {
      await failDeliveryBuild(deps.db, deps.clock, INTAKE_ACTOR, claim, r.reason);
      deps.logger.error("納品の制作版を作れなかった", { deliveryId: d.id, reason: r.reason });
    } else if (r.status !== "skipped") deps.logger.info("納品の制作版を処理した", { ...r });
    results.push(r);
  }
  return results;
}

async function processDelivery(
  deps: WorkerDeps,
  d: DeliveryRow,
  round: string,
  claim: DeliveryBuildClaim,
  signal: AbortSignal,
): Promise<DeliveryIntakeResult> {
  const { db, clock } = deps;
  const stale = (): DeliveryIntakeResult => ({
    deliveryId: d.id,
    status: "skipped",
    reason: "制作の実行権限が更新されたため、この結果は反映しません",
  });
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, d.contractId));
  if (!contract) return { deliveryId: d.id, status: "failed", reason: "契約がない" };
  const [company] = await db.select().from(companies).where(eq(companies.id, contract.companyId));
  if (!company) return { deliveryId: d.id, status: "failed", reason: "企業がない" };
  const audit = await findAuditForContract(deps, contract);
  if (!audit) return { deliveryId: d.id, status: "failed", reason: "生成の入力にする診断がない" };

  const genDeps: GenerationDeps = {
    db,
    clock,
    generator: deps.generation.generator,
    actor: INTAKE_ACTOR,
    ...(deps.generation.limits ? { limits: deps.generation.limits } : {}),
    ...(deps.generation.limiter ? { limiter: deps.generation.limiter } : {}),
  };
  let updatesUrl: string | undefined;
  try {
    updatesUrl = contentSiteUrl(company.id, "delivery");
  } catch {
    return {
      deliveryId: d.id,
      status: "failed",
      reason: "記事配信先の設定が不正です。SITEOFFER_CONTENT_ORIGIN を確認してください",
    };
  }
  const [article] = await db
    .select({ id: contentEntries.id })
    .from(contentEntries)
    .where(eq(contentEntries.companyId, company.id))
    .limit(1);
  if (article && !updatesUrl)
    return {
      deliveryId: d.id,
      status: "failed",
      reason: "記事があるため、納品前に SITEOFFER_CONTENT_ORIGIN の設定が必要です",
    };
  let input = await deps.buildGenerationInput(db, { company, audit });
  if (contract.proposalVersionId) {
    const [selected] = await db
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.id, contract.proposalVersionId));
    const designId = (selected?.content as { designVersionId?: string } | null)?.designVersionId;
    if (designId) {
      const [design] = await db.select().from(designVersions).where(eq(designVersions.id, designId));
      if (!design || design.companyId !== company.id || design.status !== "approved")
        return { deliveryId: d.id, status: "failed", reason: "契約した提案の承認済みデザインがありません" };
      input = await withDesignReference(
        input,
        design,
        path.join(deps.deliveryArtifactRoot, d.id, claim.buildId, claim.ownerId, "reference"),
      );
    }
  }
  input = await withDeliveryRevision(db, d.id, company.id, input);
  if (!(await renewDeliveryBuild(db, clock, INTAKE_ACTOR, claim))) return stale();
  const gen = await runGenerationJob(genDeps, {
    idempotencyKey: `${round}:delivery_site`,
    companyId: company.id,
    purpose: "delivery_site",
    input,
    signal,
  });
  if (signal.aborted) return stale();
  if (!gen.ok)
    return {
      deliveryId: d.id,
      status: "failed",
      reason: "サイトの生成に失敗しました。生成履歴と設定を確認して再試行してください。",
    };
  if (gen.value.output === null) {
    return {
      deliveryId: d.id,
      status: "failed",
      reason: "生成結果を確認できませんでした。生成履歴を確認して再試行してください。",
    };
  }
  const output = gen.value.output as SiteGenerationOutput;

  if (!(await renewDeliveryBuild(db, clock, INTAKE_ACTOR, claim))) return stale();
  const workDir = path.join(deps.deliveryArtifactRoot, d.id, claim.buildId, claim.ownerId);
  const built = await deps.siteBuilder.buildDelivery({
    siteInput: {
      ...siteGenerationToSiteInput(output, { mode: "delivery" }),
      updatesUrl,
    },
    workDir,
  });
  if (!built.ok) {
    return {
      deliveryId: d.id,
      status: "failed",
      reason: "納品サイトのビルド・検査に失敗しました。生成内容と制作環境を確認して再試行してください。",
    };
  }

  const added = await completeDeliveryBuild(db, clock, INTAKE_ACTOR, claim, {
    artifactDir: built.distDir,
    generationJobId: gen.value.job.id,
  });
  if (!added.ok)
    return added.error === "stale_build"
      ? stale()
      : {
          deliveryId: d.id,
          status: "failed",
          reason: "制作版を確定できませんでした。制作の状態を確認して再試行してください。",
        };
  return {
    deliveryId: d.id,
    status: "version_added",
    versionId: added.value.id,
    version: added.value.version,
    movedToOpsReview: true,
  };
}

/** 契約で選んだ提案版の診断。なければ企業の最新の評価済み診断 */
async function findAuditForContract(deps: WorkerDeps, contract: typeof contracts.$inferSelect) {
  const { db } = deps;
  if (contract.proposalVersionId) {
    const [pv] = await db
      .select({ auditId: proposalVersions.auditId })
      .from(proposalVersions)
      .where(eq(proposalVersions.id, contract.proposalVersionId));
    if (pv?.auditId) {
      const [a] = await db.select().from(siteAudits).where(eq(siteAudits.id, pv.auditId));
      if (a) return a;
    }
  }
  const [latest] = await db
    .select()
    .from(siteAudits)
    .where(and(eq(siteAudits.companyId, contract.companyId), eq(siteAudits.status, "evaluated")))
    .orderBy(desc(siteAudits.createdAt))
    .limit(1);
  return latest ?? null;
}

/** 受付処理を1回実行する（収集 → 納品の順） */
export async function runIntakeOnce(
  deps: WorkerDeps,
  state: IntakeState,
  report?: (phase: IntakePhase) => Promise<void>,
) {
  try {
    if (!deps.discoveryOnly) {
      await report?.("designs");
      await intakeDesignBuilds(deps);
      await report?.("images");
      await processDesignJobs(deps);
    }
    await report?.("discovery");
    const discovery = await intakeDiscoveryJobs(deps, state);
    if (!deps.discoveryOnly) await report?.("deliveries");
    const deliveriesResult = deps.discoveryOnly ? [] : await intakeDeliveries(deps, state);
    await report?.("idle");
    return { discovery, deliveries: deliveriesResult };
  } catch (error) {
    await report?.("error");
    throw error;
  }
}

export interface IntakeLoop {
  stop(): Promise<void>;
}

/**
 * 受付処理を一定間隔で動かす。前の回が終わってから次の回を予約する（重ならない）。
 * 例外はログに出して次の回へ進む。
 */
export function startIntakeLoop(
  deps: WorkerDeps,
  intervalMs: number,
  state = createIntakeState(),
  report?: (phase: IntakePhase) => Promise<void>,
): IntakeLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;
  const tick = () => {
    timer = null;
    if (stopped) return;
    current = runIntakeOnce(deps, state, report)
      .then(
        () => {},
        (e: unknown) => deps.logger.error("受付処理に失敗した", { message: (e as Error).message }),
      )
      .finally(() => {
        current = null;
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  timer = setTimeout(tick, 0);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
