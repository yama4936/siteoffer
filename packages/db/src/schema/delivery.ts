import { sql } from "drizzle-orm";
import { type AnyPgColumn, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./common.ts";
import { contracts } from "./contract.ts";
import { generationJobs } from "./generation.ts";
import { proposalVersions } from "./proposal.ts";
import { shareLinks } from "./share-link.ts";
import { users } from "./users.ts";

/** 納品の状態（18章「納品」） */
export const deliveryStatus = pgEnum("delivery_status", [
  "info_gathering",
  "building",
  "ops_review",
  "customer_review",
  "ready",
  "published",
  "delivered",
]);

export const deliveries = pgTable("deliveries", {
  id: id(),
  contractId: uuid("contract_id")
    .notNull()
    .unique()
    .references(() => contracts.id),
  status: deliveryStatus("status").notNull().default("info_gathering"),
  /** 現在の公開対象。承認後の変更はdeliveryChangesに旧承認版を記録し、再承認まで未固定にする。 */
  lockedVersionId: uuid("locked_version_id"),
  /**
   * 顧客確認に回している版（customer_review の間だけ値を持つ）。
   * 顧客の承認・修正依頼はこの版のリンクでだけ受け付ける（別の版・前の回のリンクを拒否する）
   */
  reviewVersionId: uuid("review_version_id"),
  /** 時刻ではなく制作回のIDで現在の依頼を識別する */
  currentBuildId: uuid("current_build_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 旧契約の不足した制作情報。契約履歴は変更せず、確認した版を追記する。 */
export const deliveryPreparations = pgTable(
  "delivery_preparations",
  {
    id: id(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id),
    revision: integer("revision").notNull(),
    requestId: uuid("request_id").notNull().unique(),
    payloadHash: text("payload_hash").notNull(),
    proposalVersionId: uuid("proposal_version_id")
      .notNull()
      .references(() => proposalVersions.id),
    scope: jsonb("scope").notNull(),
    reason: text("reason").notNull(),
    confirmedBy: uuid("confirmed_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("delivery_preparations_revision").on(t.deliveryId, t.revision)],
);

/** 承認済みの版を変更する明示的な受付。旧承認・公開記録は保持し、新しい版の承認で完了する。 */
export const deliveryChanges = pgTable(
  "delivery_changes",
  {
    id: id(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id),
    fromVersionId: uuid("from_version_id")
      .notNull()
      .references((): AnyPgColumn => deliveryVersions.id),
    fromBuildId: uuid("from_build_id"),
    priorStatus: deliveryStatus("prior_status").notNull(),
    requestId: uuid("request_id").notNull().unique(),
    payloadHash: text("payload_hash").notNull(),
    reason: text("reason").notNull(),
    requestedChanges: text("requested_changes").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    approvedVersionId: uuid("approved_version_id").references((): AnyPgColumn => deliveryVersions.id),
    approvedAt: ts("approved_at"),
  },
  (t) => [
    index("delivery_changes_delivery").on(t.deliveryId, t.createdAt),
    uniqueIndex("delivery_changes_open").on(t.deliveryId).where(sql`${t.approvedVersionId} is null`),
  ],
);

export const deliveryBuildStatus = pgEnum("delivery_build_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const deliveryBuilds = pgTable(
  "delivery_builds",
  {
    id: id(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id),
    previousId: uuid("previous_id"),
    preparationId: uuid("preparation_id").references(() => deliveryPreparations.id),
    changeId: uuid("change_id").references(() => deliveryChanges.id),
    imageAssetSnapshot: jsonb("image_asset_snapshot"),
    status: deliveryBuildStatus("status").notNull().default("queued"),
    ownerId: uuid("owner_id"),
    leaseUntil: ts("lease_until"),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("delivery_builds_delivery").on(t.deliveryId, t.createdAt)],
);

export const deliveryVersions = pgTable(
  "delivery_versions",
  {
    id: id(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id),
    version: integer("version").notNull(),
    buildId: uuid("build_id").references(() => deliveryBuilds.id),
    artifactDir: text("artifact_dir"),
    generationJobId: uuid("generation_job_id").references(() => generationJobs.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("delivery_versions_delivery_version").on(t.deliveryId, t.version)],
);

export const approvalDecision = pgEnum("approval_decision", ["approved", "changes_requested"]);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    deliveryVersionId: uuid("delivery_version_id")
      .notNull()
      .references(() => deliveryVersions.id),
    decision: approvalDecision("decision").notNull(),
    receiptKey: text("receipt_key").unique(),
    payloadHash: text("payload_hash"),
    /** 修正依頼の内容（顧客の記入）。承認では任意 */
    comment: text("comment"),
    /** 判断に使った共有リンク（顧客の操作主体） */
    shareLinkId: uuid("share_link_id").references(() => shareLinks.id),
    decidedAt: ts("decided_at").notNull(),
  },
  (t) => [index("approvals_version").on(t.deliveryVersionId)],
);

/** 公開記録（将来のAWS段階）。現時点では状態の記録だけで、実処理は作らない */
export const deployments = pgTable("deployments", {
  id: id(),
  deliveryId: uuid("delivery_id")
    .notNull()
    .references(() => deliveries.id),
  deliveryVersionId: uuid("delivery_version_id")
    .notNull()
    .references(() => deliveryVersions.id),
  environment: text("environment").notNull(),
  url: text("url"),
  status: text("status").notNull(),
  checks: jsonb("checks"),
  createdAt: createdAt(),
});
