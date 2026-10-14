import path from "node:path";
import { siteGenerationToSiteInput } from "@siteoffer/astro-site";
import { type Actor, addDeliveryVersion, canTransition, transitionDelivery } from "@siteoffer/core";
import {
  companies,
  contracts,
  deliveries,
  deliveryVersions,
  discoveryJobs,
  proposalVersions,
  siteAudits,
} from "@siteoffer/db";
import { type GenerationDeps, runGenerationJob } from "@siteoffer/generation";
import type { SiteGenerationOutput } from "@siteoffer/schemas";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { WorkerDeps } from "./deps.ts";
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
  /** このプロセスで制作版の作成をあきらめた回（同じ失敗を繰り返さない）。キーは deliveryRoundKey */
  failedDeliveryRounds: Set<string>;
}

export function createIntakeState(): IntakeState {
  return { sentDiscovery: new Set(), failedDeliveryRounds: new Set() };
}

/** status=queued の収集ジョブを収集キューへ送る。送ったジョブIDを返す */
export async function intakeDiscoveryJobs(deps: WorkerDeps, state: IntakeState): Promise<string[]> {
  const rows = await deps.db
    .select({ id: discoveryJobs.id })
    .from(discoveryJobs)
    .where(eq(discoveryJobs.status, "queued"))
    .orderBy(asc(discoveryJobs.createdAt))
    .limit(BATCH);
  const sent: string[] = [];
  for (const r of rows) {
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

/**
 * 制作の「回」のキー。制作（building）に入った時刻（deliveries.updated_at。状態の変更でだけ更新される）で区別する。
 * 運営確認・顧客確認から制作へ戻すと新しい回になり、新しい版を作る。
 */
export function deliveryRoundKey(d: Pick<DeliveryRow, "id" | "updatedAt">): string {
  return `delivery:${d.id}:${d.updatedAt.getTime()}`;
}

export type DeliveryIntakeResult =
  | { deliveryId: string; status: "version_added"; versionId: string; version: number; movedToOpsReview: boolean }
  | { deliveryId: string; status: "moved_to_ops_review"; movedToOpsReview: true }
  | { deliveryId: string; status: "failed"; reason: string }
  | { deliveryId: string; status: "skipped"; reason: string };

/**
 * 制作中（building）で、その回の制作版がない納品に版を作る。
 * 生成（delivery_site）→ Astroで納品サイトをビルド・検査 → addDeliveryVersion（system）→ 遷移規則に従って運営確認（ops_review）へ。
 * その回の版がすでにあり、まだ制作中のもの（前回の運営確認への移動が失敗した等）は、移動だけを行う。
 */
export async function intakeDeliveries(deps: WorkerDeps, state: IntakeState): Promise<DeliveryIntakeResult[]> {
  const rows = await deps.db
    .select()
    .from(deliveries)
    .where(eq(deliveries.status, "building"))
    .orderBy(asc(deliveries.updatedAt))
    .limit(BATCH);
  const results: DeliveryIntakeResult[] = [];
  for (const d of rows) {
    const round = deliveryRoundKey(d);
    if (state.failedDeliveryRounds.has(round)) continue;
    const r = await processDelivery(deps, d, round);
    if (r.status === "failed") {
      state.failedDeliveryRounds.add(round);
      deps.logger.error("納品の制作版を作れなかった", { deliveryId: d.id, reason: r.reason });
    } else if (r.status !== "skipped") {
      deps.logger.info("納品の制作版を処理した", { ...r });
    }
    results.push(r);
  }
  return results;
}

async function processDelivery(deps: WorkerDeps, d: DeliveryRow, round: string): Promise<DeliveryIntakeResult> {
  const { db, clock } = deps;
  const [existing] = await db
    .select({ id: deliveryVersions.id })
    .from(deliveryVersions)
    .where(and(eq(deliveryVersions.deliveryId, d.id), gte(deliveryVersions.createdAt, d.updatedAt)))
    .limit(1);
  if (existing) {
    const moved = await moveToOpsReview(deps, d.id);
    return moved
      ? { deliveryId: d.id, status: "moved_to_ops_review", movedToOpsReview: true }
      : { deliveryId: d.id, status: "skipped", reason: "その回の制作版はあるが、運営確認へ進めない" };
  }

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
  const input = await deps.buildGenerationInput(db, { company, audit });
  const gen = await runGenerationJob(genDeps, {
    idempotencyKey: `${round}:delivery_site`,
    companyId: company.id,
    purpose: "delivery_site",
    input,
  });
  if (!gen.ok) return { deliveryId: d.id, status: "failed", reason: `生成に失敗した：${gen.message ?? gen.error}` };
  if (gen.value.output === null) {
    return { deliveryId: d.id, status: "failed", reason: `生成ジョブが ${gen.value.job.status}（出力なし）` };
  }
  const output = gen.value.output as SiteGenerationOutput;

  const workDir = path.join(deps.deliveryArtifactRoot, d.id, String(d.updatedAt.getTime()));
  const built = await deps.siteBuilder.buildDelivery({
    siteInput: siteGenerationToSiteInput(output, { mode: "delivery" }),
    workDir,
  });
  if (!built.ok) {
    return {
      deliveryId: d.id,
      status: "failed",
      reason: `納品サイトのビルド・検査に失敗した（${built.reason}）：${built.message}`,
    };
  }

  const added = await addDeliveryVersion(db, clock, INTAKE_ACTOR, d.id, {
    artifactDir: built.distDir,
    generationJobId: gen.value.job.id,
  });
  if (!added.ok) {
    return { deliveryId: d.id, status: "failed", reason: `制作版を追加できなかった：${added.message ?? added.error}` };
  }
  const moved = await moveToOpsReview(deps, d.id);
  return {
    deliveryId: d.id,
    status: "version_added",
    versionId: added.value.id,
    version: added.value.version,
    movedToOpsReview: moved,
  };
}

/** 遷移規則（DELIVERY_TRANSITIONS）で許される場合だけ運営確認へ進める */
async function moveToOpsReview(deps: WorkerDeps, deliveryId: string): Promise<boolean> {
  const [d] = await deps.db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  if (!d || !canTransition(d.status, "ops_review")) return false;
  const r = await transitionDelivery(
    deps.db,
    deps.clock,
    INTAKE_ACTOR,
    deliveryId,
    "ops_review",
    "ワーカーが制作版を作成したため運営確認へ",
  );
  if (!r.ok) deps.logger.warn("運営確認へ進められなかった", { deliveryId, error: r.error, message: r.message });
  return r.ok;
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
export async function runIntakeOnce(deps: WorkerDeps, state: IntakeState) {
  const discovery = await intakeDiscoveryJobs(deps, state);
  const deliveriesResult = await intakeDeliveries(deps, state);
  return { discovery, deliveries: deliveriesResult };
}

export interface IntakeLoop {
  stop(): Promise<void>;
}

/**
 * 受付処理を一定間隔で動かす。前の回が終わってから次の回を予約する（重ならない）。
 * 例外はログに出して次の回へ進む。
 */
export function startIntakeLoop(deps: WorkerDeps, intervalMs: number, state = createIntakeState()): IntakeLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;
  const tick = () => {
    timer = null;
    if (stopped) return;
    current = runIntakeOnce(deps, state)
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
