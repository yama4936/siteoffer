import {
  approvals,
  companies,
  contracts,
  type DbOrTx,
  deliveries,
  deliveryBuilds,
  deliveryVersions,
  deployments,
  generationJobs,
} from "@siteoffer/db";
import { and, asc, desc, eq, inArray, isNotNull, max } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok, type Result } from "../common/result.ts";
import { authorize } from "../permissions/policy.ts";
import { type IssuedShareLink, type IssueShareLinkError, issueShareLink } from "../share-link/share-link.ts";
import type { ShareTokenRecovery } from "../share-link/token.ts";
import type { DeliveryBuildClaim } from "./build.ts";
import { beginDeliveryBuild } from "./build-state.ts";

/**
 * 納品（15・18章）。
 * 状態：情報確認 → 制作 → 運営確認 → 顧客確認 → 公開準備 → 公開 → 納品。
 * - 契約が完了（completed）した契約ごとに1件（deliveries.contract_id の一意制約）。
 * - 制作版は追加するだけで書き換えない。再生成は新しい版。
 * - 顧客が承認した版を deliveries.locked_version_id に固定し、以後は変えない（AC-18）。
 * - 公開・納品の実処理（AWS）は作らない。状態と記録（deployments）だけを持つ。
 * 運営（と system）だけが操作する。営業ユーザーは操作できない（5.2・AC-18）。
 * 顧客の承認・修正依頼は customer.ts（共有リンクの検証）で扱う。
 */

export type DeliveryStatus = (typeof deliveries.$inferSelect)["status"];
export type DeliveryRow = typeof deliveries.$inferSelect;
export type DeliveryVersionRow = typeof deliveryVersions.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "info_gathering",
  "building",
  "ops_review",
  "customer_review",
  "ready",
  "published",
  "delivered",
];

/**
 * 許可する遷移。戻りは「運営確認・顧客確認から制作へ」だけ。
 * 公開準備（ready）以降は戻らないため、固定した版は変わらない。
 */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  info_gathering: ["building"],
  building: ["ops_review"],
  ops_review: ["building", "customer_review"],
  customer_review: ["ready", "building"],
  ready: ["published"],
  published: ["delivered"],
  delivered: [],
};

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 運営・system の操作主体。営業・顧客・未ログインは forbidden */
type StaffActor = Extract<Actor, { kind: "ops" | "system" }>;
type OpsActor = Extract<Actor, { kind: "ops" }>;

function requireStaff(actor: Actor | null, action: "read" | "manage"): Result<StaffActor, "forbidden"> {
  const auth = authorize(actor, action, { type: "delivery" });
  if (!auth.ok || !actor || (actor.kind !== "ops" && actor.kind !== "system")) {
    return err("forbidden", "納品は運営だけが扱えます");
  }
  return ok(actor);
}

function requireOps(actor: Actor | null): Result<OpsActor, "forbidden"> {
  const staff = requireStaff(actor, "manage");
  if (!staff.ok) return staff;
  if (staff.value.kind !== "ops") return err("forbidden", "この操作は運営ユーザーだけが行えます");
  return ok(staff.value);
}

async function lockDelivery(tx: DbOrTx, deliveryId: string): Promise<DeliveryRow | null> {
  if (!UUID_PATTERN.test(deliveryId)) return null;
  const [row] = await tx.select().from(deliveries).where(eq(deliveries.id, deliveryId)).for("update");
  return row ?? null;
}

const snapshot = (d: DeliveryRow) => ({
  status: d.status,
  lockedVersionId: d.lockedVersionId,
  reviewVersionId: d.reviewVersionId,
  currentBuildId: d.currentBuildId,
});

// ---------------------------------------------------------------------------
// 納品の作成

export type CreateDeliveryError = "forbidden" | "contract_not_found" | "contract_not_completed";

/**
 * 完了した契約に納品を1件作る（情報確認から始める）。既にあれば既存を返す（created: false）。
 * 同時に呼ばれても contract_id の一意制約で1件に保つ。
 */
export async function createDeliveryForContract(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  contractId: string,
): Promise<Result<{ delivery: DeliveryRow; created: boolean }, CreateDeliveryError>> {
  const staff = requireStaff(actor, "manage");
  if (!staff.ok) return staff;
  if (!UUID_PATTERN.test(contractId)) return err("contract_not_found");
  return db.transaction(
    async (tx): Promise<Result<{ delivery: DeliveryRow; created: boolean }, CreateDeliveryError>> => {
      const [contract] = await tx.select().from(contracts).where(eq(contracts.id, contractId));
      if (!contract) return err("contract_not_found");
      if (contract.status !== "completed") {
        return err("contract_not_completed", "契約確認が完了した契約だけ納品を始められます");
      }
      const now = clock.now();
      const [inserted] = await tx
        .insert(deliveries)
        .values({ contractId, status: "info_gathering", createdAt: now, updatedAt: now })
        .onConflictDoNothing({ target: deliveries.contractId })
        .returning();
      if (!inserted) {
        const [existing] = await tx.select().from(deliveries).where(eq(deliveries.contractId, contractId));
        return ok({ delivery: existing!, created: false });
      }
      await recordEvent(tx, clock, {
        actor: staff.value,
        action: "delivery.create",
        targetType: "delivery",
        targetId: inserted.id,
        after: { contractId, ...snapshot(inserted) },
      });
      return ok({ delivery: inserted, created: true });
    },
  );
}

// ---------------------------------------------------------------------------
// 制作版

export interface AddDeliveryVersionInput {
  /** 成果物ディレクトリ（生成・ビルド済みの静的ファイル）。ビルド・検査はここでは行わない */
  artifactDir: string;
  /** 生成ジョブ（generation_jobs.id）。手作業の版などで無ければ省略 */
  generationJobId?: string | null;
  /** ワーカーの完了処理だけが渡す実行権限 */
  buildClaim?: DeliveryBuildClaim;
}

export type AddDeliveryVersionError =
  | "forbidden"
  | "not_found"
  | "invalid_state"
  | "invalid_input"
  | "generation_job_not_found"
  | "stale_build";

/**
 * 制作版を追加する。版番号は納品ごとに1から連番。既存の版は書き換えない（再生成は新しい版）。
 * 納品済み（delivered）には追加できない。追加しても固定済みの版（locked_version_id）は変わらない。
 */
export async function addDeliveryVersion(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  deliveryId: string,
  input: AddDeliveryVersionInput,
): Promise<Result<DeliveryVersionRow, AddDeliveryVersionError>> {
  const staff = requireStaff(actor, "manage");
  if (!staff.ok) return staff;
  const artifactDir = typeof input.artifactDir === "string" ? input.artifactDir.trim() : "";
  if (!artifactDir || artifactDir.length > 1024 || artifactDir.includes("\0")) {
    return err("invalid_input", "成果物ディレクトリを指定してください");
  }
  const jobId = input.generationJobId ?? null;
  if (jobId !== null && !UUID_PATTERN.test(jobId)) return err("generation_job_not_found");

  return db.transaction(async (tx): Promise<Result<DeliveryVersionRow, AddDeliveryVersionError>> => {
    const delivery = await lockDelivery(tx, deliveryId);
    if (!delivery) return err("not_found");
    if (delivery.status === "delivered") return err("invalid_state", "納品済みの案件には版を追加できません");
    const [build] = delivery.currentBuildId
      ? await tx
          .select()
          .from(deliveryBuilds)
          .where(and(eq(deliveryBuilds.id, delivery.currentBuildId), eq(deliveryBuilds.deliveryId, delivery.id)))
          .for("update")
      : [];
    if (input.buildClaim) {
      const claim = input.buildClaim;
      if (
        staff.value.kind !== "system" ||
        delivery.status !== "building" ||
        delivery.lockedVersionId ||
        delivery.currentBuildId !== claim.buildId ||
        claim.deliveryId !== delivery.id ||
        !build ||
        build.status !== "running" ||
        build.ownerId !== claim.ownerId ||
        !build.leaseUntil ||
        build.leaseUntil <= clock.now()
      )
        return err("stale_build");
    } else if (build?.status === "running") return err("invalid_state", "制作処理の実行中は別の版を追加できません");
    if (jobId !== null) {
      const [job] = await tx
        .select({ companyId: generationJobs.companyId, purpose: generationJobs.purpose, status: generationJobs.status })
        .from(generationJobs)
        .where(eq(generationJobs.id, jobId));
      if (!job || (input.buildClaim && (job.purpose !== "delivery_site" || job.status !== "succeeded")))
        return err("generation_job_not_found");
      // 別企業の生成ジョブを紐づけない
      const [contract] = await tx
        .select({ companyId: contracts.companyId })
        .from(contracts)
        .where(eq(contracts.id, delivery.contractId));
      if (
        (input.buildClaim && job.companyId !== contract?.companyId) ||
        (job.companyId !== null && job.companyId !== contract?.companyId)
      ) {
        return err("generation_job_not_found", "この企業の生成ジョブではありません");
      }
    }
    const [agg] = await tx
      .select({ v: max(deliveryVersions.version) })
      .from(deliveryVersions)
      .where(eq(deliveryVersions.deliveryId, delivery.id));
    const version = (agg?.v ?? 0) + 1;
    const [row] = await tx
      .insert(deliveryVersions)
      .values({
        deliveryId: delivery.id,
        version,
        artifactDir,
        generationJobId: jobId,
        buildId: delivery.currentBuildId,
        createdAt: clock.now(),
      })
      .returning();
    await recordEvent(tx, clock, {
      actor: staff.value,
      action: "delivery.version_add",
      targetType: "delivery",
      targetId: delivery.id,
      after: { versionId: row!.id, version, artifactDir, generationJobId: jobId, buildId: delivery.currentBuildId },
    });
    return ok(row!);
  });
}

// ---------------------------------------------------------------------------
// 状態の変更（専用の操作が要らないもの）

/**
 * transitionDelivery で変えられる行き先。
 * - building：情報確認の完了、運営確認での差し戻し、顧客確認の取り下げ（運営）
 * - ops_review：制作版を運営確認に回す
 * - delivered：公開後の納品完了の記録
 * 顧客確認（customer_review）は sendToCustomerReview、公開準備（ready）は顧客の承認、
 * 公開（published）は recordPublication でだけ変える。
 */
export type SimpleTransitionTarget = "building" | "ops_review" | "delivered";

export type TransitionError = "forbidden" | "not_found" | "invalid_transition" | "no_version";

export async function transitionDelivery(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  deliveryId: string,
  to: SimpleTransitionTarget,
  note?: string,
): Promise<Result<DeliveryRow, TransitionError>> {
  const staff = requireStaff(actor, "manage");
  if (!staff.ok) return staff;
  if (to !== "building" && to !== "ops_review" && to !== "delivered") {
    return err("invalid_transition", "この状態へは専用の操作で変更してください");
  }
  return db.transaction(async (tx): Promise<Result<DeliveryRow, TransitionError>> => {
    const delivery = await lockDelivery(tx, deliveryId);
    if (!delivery) return err("not_found");
    if (!canTransition(delivery.status, to)) {
      return err("invalid_transition", `${delivery.status} から ${to} へは変更できません`);
    }
    if (to === "ops_review") {
      const [build] = delivery.currentBuildId
        ? await tx
            .select()
            .from(deliveryBuilds)
            .where(and(eq(deliveryBuilds.id, delivery.currentBuildId), eq(deliveryBuilds.deliveryId, delivery.id)))
            .for("update")
        : [];
      if (build?.status === "running") return err("invalid_transition", "制作処理が実行中です。完了までお待ちください");
      const [v] = await tx
        .select({ id: deliveryVersions.id })
        .from(deliveryVersions)
        .where(
          and(
            eq(deliveryVersions.deliveryId, delivery.id),
            isNotNull(deliveryVersions.artifactDir),
            delivery.currentBuildId ? eq(deliveryVersions.buildId, delivery.currentBuildId) : undefined,
          ),
        )
        .limit(1);
      if (!v) return err("no_version", "今回の制作に対応する版がありません。制作の完了をお待ちください");
      if (build && build.status !== "succeeded")
        await tx
          .update(deliveryBuilds)
          .set({ status: "succeeded", leaseUntil: null, finishedAt: clock.now() })
          .where(eq(deliveryBuilds.id, build.id));
    }
    const build = to === "building" ? await beginDeliveryBuild(tx, clock, delivery) : null;
    const [row] = await tx
      .update(deliveries)
      .set({
        status: to,
        reviewVersionId: null,
        currentBuildId: build?.id ?? delivery.currentBuildId,
        updatedAt: clock.now(),
      })
      .where(and(eq(deliveries.id, delivery.id), eq(deliveries.status, delivery.status)))
      .returning();
    await recordEvent(tx, clock, {
      actor: staff.value,
      action: "delivery.transition",
      targetType: "delivery",
      targetId: delivery.id,
      before: snapshot(delivery),
      after: { ...snapshot(row!), note: note?.slice(0, 500) ?? null },
    });
    return ok(row!);
  });
}

// ---------------------------------------------------------------------------
// 顧客確認に回す（運営）

export interface SendToCustomerReviewInput {
  /** 同じ発行の再送を識別する受付キー */
  requestKey?: string;
  /** 運営が確認した版（この納品の版） */
  versionId: string;
  /** 共有リンクの有効期間（時間）。省略時は運営設定の既定値 */
  ttlHours?: number;
}

export type SendToCustomerReviewError =
  | "forbidden"
  | "not_found"
  | "version_not_found"
  | "invalid_transition"
  | "no_artifact"
  | IssueShareLinkError
  | "version_requires_revision";

/**
 * 運営が確認した版を顧客確認に回し、納品用の共有リンク（期限付き）を発行する。
 * 運営確認（ops_review）から行う。顧客確認中の同じ版なら、リンクの再発行（期限切れ時など）として扱う。
 * トークンの平文は戻り値でだけ返す（顧客に渡すURLに使う）。
 */
export async function sendToCustomerReview(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  deliveryId: string,
  input: SendToCustomerReviewInput,
  recovery?: ShareTokenRecovery,
): Promise<Result<{ delivery: DeliveryRow; issued: IssuedShareLink }, SendToCustomerReviewError>> {
  const ops = requireOps(actor);
  if (!ops.ok) return ops;
  type R = Result<{ delivery: DeliveryRow; issued: IssuedShareLink }, SendToCustomerReviewError>;
  return db.transaction(async (tx): Promise<R> => {
    const delivery = await lockDelivery(tx, deliveryId);
    if (!delivery) return err("not_found");
    if (!UUID_PATTERN.test(input.versionId)) return err("version_not_found");
    const [version] = await tx
      .select()
      .from(deliveryVersions)
      .where(and(eq(deliveryVersions.id, input.versionId), eq(deliveryVersions.deliveryId, delivery.id)));
    if (!version) return err("version_not_found");
    if (delivery.currentBuildId && version.buildId !== delivery.currentBuildId)
      return err("version_requires_revision", "前の制作回の版は再提出できません。今回の制作版を確認してください");

    const [rejected] = await tx
      .select({ version: max(deliveryVersions.version) })
      .from(approvals)
      .innerJoin(deliveryVersions, eq(deliveryVersions.id, approvals.deliveryVersionId))
      .where(and(eq(deliveryVersions.deliveryId, delivery.id), eq(approvals.decision, "changes_requested")));
    if (rejected?.version !== null && rejected?.version !== undefined && version.version <= rejected.version)
      return err(
        "version_requires_revision",
        "修正依頼を受けた版以前の内容は再提出できません。修正版を作成し、運営で内容を確認してください",
      );
    const reissue = delivery.status === "customer_review" && delivery.reviewVersionId === version.id;
    if (!reissue && !canTransition(delivery.status, "customer_review")) {
      return err("invalid_transition", "運営確認中の納品だけを顧客確認に回せます");
    }
    if (!version.artifactDir) return err("no_artifact", "この版には成果物がありません");

    const issued = await issueShareLink(
      tx,
      clock,
      ops.value,
      {
        purpose: "delivery",
        targetId: version.id,
        ...(input.requestKey !== undefined ? { requestKey: input.requestKey } : {}),
        ...(input.ttlHours !== undefined ? { ttlHours: input.ttlHours } : {}),
      },
      recovery,
    );
    if (!issued.ok) return issued;
    if (reissue && !issued.value.created) return ok({ delivery, issued: issued.value });

    const [row] = await tx
      .update(deliveries)
      .set({ status: "customer_review", reviewVersionId: version.id, updatedAt: clock.now() })
      .where(eq(deliveries.id, delivery.id))
      .returning();
    await recordEvent(tx, clock, {
      actor: ops.value,
      action: reissue ? "delivery.customer_review_reissue" : "delivery.customer_review_start",
      targetType: "delivery",
      targetId: delivery.id,
      before: snapshot(delivery),
      after: { ...snapshot(row!), version: version.version, shareLinkId: issued.value.link.id },
    });
    return ok({ delivery: row!, issued: issued.value });
  });
}

// ---------------------------------------------------------------------------
// 公開の記録（AWSの実処理は作らない）

export interface RecordPublicationInput {
  /** 例：production / staging。実環境の構築・デプロイは行わない */
  environment: string;
  /** 公開URL（分かれば） */
  url?: string | null;
}

export type RecordPublicationError = "forbidden" | "not_found" | "invalid_transition" | "not_locked" | "invalid_input";

/**
 * 公開準備（ready）→ 公開（published）。固定した版で deployments に記録を1行残す。
 * 状態の記録だけで、AWSへの公開・DNS変更・稼働確認は行わない（15章・現時点の範囲外）。
 */
export async function recordPublication(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  deliveryId: string,
  input: RecordPublicationInput,
): Promise<Result<{ delivery: DeliveryRow; deployment: DeploymentRow }, RecordPublicationError>> {
  const ops = requireOps(actor);
  if (!ops.ok) return ops;
  const environment = typeof input.environment === "string" ? input.environment.trim() : "";
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(environment)) return err("invalid_input", "環境名を英小文字で指定してください");
  const url = input.url?.trim() || null;
  if (url !== null) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return err("invalid_input", "公開URLの形式が正しくありません");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return err("invalid_input", "公開URLは http(s) で指定してください");
    }
  }
  type R = Result<{ delivery: DeliveryRow; deployment: DeploymentRow }, RecordPublicationError>;
  return db.transaction(async (tx): Promise<R> => {
    const delivery = await lockDelivery(tx, deliveryId);
    if (!delivery) return err("not_found");
    if (!canTransition(delivery.status, "published")) {
      return err("invalid_transition", "公開準備の納品だけを公開済みにできます");
    }
    if (!delivery.lockedVersionId) return err("not_locked", "公開対象の版が固定されていません");
    const now = clock.now();
    const [deployment] = await tx
      .insert(deployments)
      .values({
        deliveryId: delivery.id,
        deliveryVersionId: delivery.lockedVersionId,
        environment,
        url,
        // 記録だけ（実デプロイなし）。将来のAWS段階で実行・検証の状態に置き換える
        status: "recorded",
        checks: null,
        createdAt: now,
      })
      .returning();
    const [row] = await tx
      .update(deliveries)
      .set({ status: "published", updatedAt: now })
      .where(eq(deliveries.id, delivery.id))
      .returning();
    await recordEvent(tx, clock, {
      actor: ops.value,
      action: "delivery.publish_record",
      targetType: "delivery",
      targetId: delivery.id,
      before: snapshot(delivery),
      after: { ...snapshot(row!), deploymentId: deployment!.id, environment, url },
    });
    return ok({ delivery: row!, deployment: deployment! });
  });
}

// ---------------------------------------------------------------------------
// 読み取り（運営）

export interface DeliveryDetail {
  build: typeof deliveryBuilds.$inferSelect | null;
  delivery: DeliveryRow;
  companyId: string;
  companyName: string;
  contractId: string;
  versions: DeliveryVersionRow[];
  approvals: ApprovalRow[];
  deployments: DeploymentRow[];
}

/** 納品の詳細（運営の画面用）。版は新しい順、承認・修正依頼は新しい順 */
export async function getDeliveryDetail(
  db: DbOrTx,
  actor: Actor | null,
  deliveryId: string,
): Promise<Result<DeliveryDetail, "forbidden" | "not_found">> {
  const staff = requireStaff(actor, "read");
  if (!staff.ok) return staff;
  if (!UUID_PATTERN.test(deliveryId)) return err("not_found");
  const [head] = await db
    .select({ delivery: deliveries, companyId: companies.id, companyName: companies.name })
    .from(deliveries)
    .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .where(eq(deliveries.id, deliveryId));
  if (!head) return err("not_found");
  const versions = await db
    .select()
    .from(deliveryVersions)
    .where(eq(deliveryVersions.deliveryId, deliveryId))
    .orderBy(desc(deliveryVersions.version));
  const [build] = head.delivery.currentBuildId
    ? await db
        .select()
        .from(deliveryBuilds)
        .where(and(eq(deliveryBuilds.id, head.delivery.currentBuildId), eq(deliveryBuilds.deliveryId, deliveryId)))
    : [];
  const versionIds = versions.map((v) => v.id);
  const approvalRows =
    versionIds.length === 0
      ? []
      : await db
          .select()
          .from(approvals)
          .where(inArray(approvals.deliveryVersionId, versionIds))
          .orderBy(desc(approvals.decidedAt));
  const deploymentRows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.deliveryId, deliveryId))
    .orderBy(asc(deployments.createdAt));
  return ok({
    delivery: head.delivery,
    build: build ?? null,
    companyId: head.companyId,
    companyName: head.companyName,
    contractId: head.delivery.contractId,
    versions,
    approvals: approvalRows,
    deployments: deploymentRows,
  });
}
