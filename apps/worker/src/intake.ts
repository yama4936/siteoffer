import { randomUUID } from "node:crypto";
import path from "node:path";
import { siteGenerationToSiteInput } from "@siteoffer/astro-site";
import {
  type Actor,
  assertCompanyProfileCurrent,
  CompanyProfileError,
  claimDeliveryBuild,
  completeDeliveryBuild,
  type DeliveryBuildClaim,
  failDeliveryBuild,
  INTERRUPTED_BUILD_MESSAGE,
  loadDeliveryInputSource,
  renewDeliveryBuild,
} from "@siteoffer/core";
import type { IntakeLane, IntakePhase } from "@siteoffer/db";
import { contentEntries, deliveries, deliveryBuilds, discoveryJobs, skillRuns } from "@siteoffer/db";
import { AGENT_WEB_PROVIDER } from "@siteoffer/discovery";
import { type GenerationDeps, runGenerationJob } from "@siteoffer/generation";
import type { SiteGenerationOutput } from "@siteoffer/schemas";
import { and, asc, eq, getTableColumns, isNull, lte, ne, or } from "drizzle-orm";
import { withDeliveryChange } from "./delivery-change.ts";
import { applyDeliveryMaterials, prepareDeliveryMaterials } from "./delivery-materials.ts";
import { withDeliveryRevision } from "./delivery-revision.ts";
import type { WorkerDeps } from "./deps.ts";
import { contentSiteUrl, intakeDesignBuilds, processDesignJobs, withDesignReference } from "./design.ts";
import { siteGenerationInputIssue } from "./input.ts";
import { readStepState } from "./ledger.ts";
import { stopDiscoveryJob } from "./pipeline/discovery.ts";
import { type DiscoveryPayload, QUEUES, type SkillPayload, stepKeys } from "./queues.ts";

/**
 * DBを定期的に見てジョブを受け付ける処理（webからワーカーへの経路）。
 * - 収集：status=queued の discovery_jobs を収集キューへ送る。
 * - スキル：status=queued の skill_runs をスキルのキューへ送る。
 * - 納品：制作（building）中で、その回の制作版がない納品について、納品サイトを生成・ビルドして版を追加し、運営確認へ回す。
 * webはDBに行を作るだけで、キューには触れない。
 */

export const INTAKE_ACTOR: Actor = { kind: "system", job: "worker-intake" };

/** 1回の受付で拾う上限 */
const BATCH = 20;

export interface IntakeState {
  /** このプロセスで送った収集ジョブ（同じ行を何度も送らない。プロセスをまたぐ二重投入はキューの singletonKey と実行台帳で防ぐ） */
  sentDiscovery: Set<string>;
  /** このプロセスで送ったスキル実行（実行の二重開始は skill_runs の状態の更新で防ぐ） */
  sentSkills: Set<string>;
}

export function createIntakeState(): IntakeState {
  return { sentDiscovery: new Set(), sentSkills: new Set() };
}

/** status=queued の収集ジョブを収集キューへ送る。送ったジョブIDを返す */
export async function intakeDiscoveryJobs(deps: WorkerDeps, state: IntakeState): Promise<string[]> {
  const rows = await deps.db
    .select({ id: discoveryJobs.id, provider: discoveryJobs.provider })
    .from(discoveryJobs)
    // agent-web はスキルの取り込み（skills/discovery-import.ts）が作成と同時に実行する。受付で拾うと取得元未設定として止めてしまう
    .where(and(eq(discoveryJobs.status, "queued"), ne(discoveryJobs.provider, AGENT_WEB_PROVIDER)))
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

/**
 * status=queued のスキル実行をスキルのキューへ送る。送った実行IDを返す。
 * スキル実行を設定していないワーカーは拾わない（設定したワーカーが起動するまで受付待ちのまま残す）。
 */
export async function intakeSkillRuns(deps: WorkerDeps, state: IntakeState): Promise<string[]> {
  if (!deps.skills) return [];
  const rows = await deps.db
    .select({ id: skillRuns.id })
    .from(skillRuns)
    .where(eq(skillRuns.status, "queued"))
    .orderBy(asc(skillRuns.createdAt))
    .limit(BATCH);
  const sent: string[] = [];
  for (const r of rows) {
    if (state.sentSkills.has(r.id)) continue;
    const payload: SkillPayload = { runId: r.id };
    await deps.queue.send(QUEUES.skill, payload, { singletonKey: `skill:${r.id}` });
    state.sentSkills.add(r.id);
    sent.push(r.id);
  }
  if (sent.length) deps.logger.info("スキルの実行を受け付けた", { skillRunIds: sent });
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
    } catch (error) {
      r = {
        deliveryId: d.id,
        status: "failed",
        reason:
          error instanceof CompanyProfileError
            ? error.message
            : "制作処理を完了できませんでした。ワーカーと設定を確認して再試行してください。",
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
  const source = await loadDeliveryInputSource(db, d.id, claim.buildId);
  if (!source) return { deliveryId: d.id, status: "failed", reason: "契約と企業の情報を確認できません" };
  if (source.blockers.length) return { deliveryId: d.id, status: "failed", reason: source.blockers.join(" / ") };
  const { company, contract } = source;
  const audit = source.audit!;

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
  const inputIssue = siteGenerationInputIssue(input);
  if (inputIssue) return { deliveryId: d.id, status: "failed", reason: inputIssue };
  if (source.design)
    input = await withDesignReference(
      input,
      source.design,
      path.join(deps.deliveryArtifactRoot, d.id, claim.buildId, claim.ownerId, "reference"),
    );
  // 契約書・報酬・担当者の個人情報を生成器へ渡さず、確定時の制作範囲だけを引き継ぐ。
  input = {
    ...input,
    context: {
      ...input.context,
      deliveryContract: {
        contractId: contract.id,
        preparationId: source.preparation?.id ?? null,
        proposalVersionId: source.proposal?.id ?? null,
        scope: source.scope?.scope ?? null,
        instruction:
          "契約時の制作範囲に従う。追加の機能・ページ・更新運用を契約済みと推測しない。不明な会社情報・権利・ドメインの取得状況を確定事実として補わない。",
      },
    },
  };
  const change = await withDeliveryChange(db, d.id, company.id, claim.buildId, input);
  input = await withDeliveryRevision(db, d.id, company.id, change.input, change.baseVersion);
  const workDir = path.join(deps.deliveryArtifactRoot, d.id, claim.buildId, claim.ownerId);
  const materials = await prepareDeliveryMaterials(db, d.id, claim.buildId, workDir, input);
  input = materials.input;
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
      reason:
        gen.error === "sandbox_stop_unconfirmed" || gen.error === "sandbox_stop_pending"
          ? "生成処理の停止確認を待っています。ワーカーの稼働と生成履歴を確認してください。停止確認が済むまで再試行は行いません。"
          : "サイトの生成に失敗しました。生成履歴と設定を確認して再試行してください。",
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
  const built = await deps.siteBuilder.buildDelivery({
    siteInput: {
      ...applyDeliveryMaterials(siteGenerationToSiteInput(output, { mode: "delivery" }), materials.images),
      updatesUrl,
    },
    workDir,
    signal,
  });
  if (signal.aborted) return stale();
  if (!built.ok) {
    return {
      deliveryId: d.id,
      status: "failed",
      reason: "納品サイトのビルド・検査に失敗しました。生成内容と制作環境を確認して再試行してください。",
    };
  }

  const added = await db.transaction(async (tx) => {
    await assertCompanyProfileCurrent(tx, company.id, input.context.companyProfileRevision);
    return completeDeliveryBuild(tx, clock, INTAKE_ACTOR, claim, {
      artifactDir: built.distDir,
      generationJobId: gen.value.job.id,
    });
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

type IntakeReporter = (phase: IntakePhase, lane: IntakeLane) => Promise<void>;

async function runDispatch(deps: WorkerDeps, state: IntakeState, report?: IntakeReporter) {
  let failed: { reason: unknown } | undefined;
  try {
    if (!deps.discoveryOnly) {
      await report?.("designs", "dispatch");
      await intakeDesignBuilds(deps);
    }
  } catch (reason) {
    failed = { reason };
  }
  try {
    await report?.("discovery", "dispatch");
    const discovery = await intakeDiscoveryJobs(deps, state);
    if (!deps.discoveryOnly) await intakeSkillRuns(deps, state);
    if (failed) throw failed.reason;
    await report?.("idle", "dispatch");
    return discovery;
  } catch (error) {
    await report?.("error", "dispatch");
    throw error;
  }
}

async function runImages(deps: WorkerDeps, report?: IntakeReporter) {
  try {
    await report?.("images", "images");
    await processDesignJobs(deps);
    await report?.("idle", "images");
  } catch (error) {
    await report?.("error", "images");
    throw error;
  }
}

async function runDeliveries(deps: WorkerDeps, state: IntakeState, report?: IntakeReporter) {
  try {
    await report?.("deliveries", "deliveries");
    const result = await intakeDeliveries(deps, state);
    await report?.("idle", "deliveries");
    return result;
  } catch (error) {
    await report?.("error", "deliveries");
    throw error;
  }
}

/** 全処理を一度ずつ開始し、全ての結果を待つ。他の処理を一つの失敗で止めない。 */
export async function runIntakeOnce(deps: WorkerDeps, state: IntakeState, report?: IntakeReporter) {
  const [dispatch, images, delivery] = await Promise.allSettled([
    runDispatch(deps, state, report),
    deps.discoveryOnly ? Promise.resolve() : runImages(deps, report),
    deps.discoveryOnly ? Promise.resolve([]) : runDeliveries(deps, state, report),
  ]);
  if (dispatch.status === "rejected") throw dispatch.reason;
  if (images.status === "rejected") throw images.reason;
  if (delivery.status === "rejected") throw delivery.reason;
  return { discovery: dispatch.value, deliveries: delivery.value };
}

export interface IntakeLoop {
  stop(): Promise<void>;
}

/**
 * 受付・画像生成・納品制作を独立して動かす。各処理は完了後に次回を予約し、同じ処理は重ねない。
 * 長時間の生成や一つの例外が他の受付を止めない。停止時は全ての実行中処理の完了を待つ。
 */
export function startIntakeLoop(
  deps: WorkerDeps,
  intervalMs: number,
  state = createIntakeState(),
  report?: IntakeReporter,
): IntakeLoop {
  let stopped = false;
  const tasks: {
    lane: IntakeLane;
    run: () => Promise<unknown>;
    timer: NodeJS.Timeout | null;
    current: Promise<void> | null;
  }[] = [
    { lane: "dispatch", run: () => runDispatch(deps, state, report), timer: null, current: null },
    ...(!deps.discoveryOnly
      ? [
          { lane: "images" as const, run: () => runImages(deps, report), timer: null, current: null },
          { lane: "deliveries" as const, run: () => runDeliveries(deps, state, report), timer: null, current: null },
        ]
      : []),
  ];
  for (const task of tasks) {
    const tick = () => {
      task.timer = null;
      if (stopped) return;
      task.current = task
        .run()
        .then(
          () => {},
          (e: unknown) => deps.logger.error("受付処理に失敗した", { lane: task.lane, message: (e as Error).message }),
        )
        .finally(() => {
          task.current = null;
          if (!stopped) task.timer = setTimeout(tick, intervalMs);
        });
    };
    task.timer = setTimeout(tick, 0);
  }
  return {
    async stop() {
      stopped = true;
      for (const task of tasks) if (task.timer) clearTimeout(task.timer);
      await Promise.all(tasks.map((task) => task.current));
    },
  };
}
