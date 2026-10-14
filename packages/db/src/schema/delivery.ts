import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { contracts } from "./contract.ts";
import { generationJobs } from "./generation.ts";
import { shareLinks } from "./share-link.ts";

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
  /** 顧客が承認し、公開対象として固定した版 */
  lockedVersionId: uuid("locked_version_id"),
  createdAt: createdAt(),
});

export const deliveryVersions = pgTable(
  "delivery_versions",
  {
    id: id(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id),
    version: integer("version").notNull(),
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
    comment: text("comment"),
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
