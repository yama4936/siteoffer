import { productTerms } from "./product-terms.ts";
import { salesOffers } from "./sales-offer.ts";

export { productTerms } from "./product-terms.ts";

import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assignments } from "./assignment.ts";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";
import { proposalVersions } from "./proposal.ts";
import { users } from "./users.ts";

export const contractStatus = pgEnum("contract_status", [
  "reported",
  "under_review",
  "completed",
  "rejected",
  "cancelled",
]);

export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id),
    salesUserId: uuid("sales_user_id")
      .notNull()
      .references(() => users.id),
    status: contractStatus("status").notNull().default("reported"),
    salesOfferId: uuid("sales_offer_id").references(() => salesOffers.id),
    productTermsId: uuid("product_terms_id").references(() => productTerms.id),
    proposalVersionId: uuid("proposal_version_id").references(() => proposalVersions.id),
    /** 価格・範囲・提案版・ドメイン対応・継続費用・担当・報酬条件の写し。完了時に固定 */
    snapshot: jsonb("snapshot"),
    documentRef: text("document_ref"),
    reportNote: text("report_note"),
    reportedAt: ts("reported_at").notNull(),
    /** 差し戻し・取り消しの理由（運営） */
    closeReason: text("close_reason"),
    closedAt: ts("closed_at"),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("contracts_company").on(t.companyId),
    index("contracts_sales_user").on(t.salesUserId),
    // 1つの担当に、進行中または完了の契約は1件だけ（成約報告の重複を防ぐ）
    uniqueIndex("contracts_one_open_per_assignment")
      .on(t.assignmentId)
      .where(sql`${t.status} in ('reported', 'under_review', 'completed')`),
  ],
);

export const paymentStatus = pgEnum("payment_status", ["pending", "received", "refunded", "cancelled"]);

/** 顧客からの入金。報酬とは別に管理する */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id),
    amount: integer("amount").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    receivedAt: ts("received_at"),
    refundedAt: ts("refunded_at"),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("payments_contract").on(t.contractId)],
);

export const rewardStatus = pgEnum("reward_status", ["accrued", "scheduled", "paid", "cancelled"]);

/** 営業報酬。契約ごとに1件だけ（AC-15） */
export const rewards = pgTable("rewards", {
  id: id(),
  contractId: uuid("contract_id")
    .notNull()
    .unique()
    .references(() => contracts.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  amount: integer("amount").notNull(),
  status: rewardStatus("status").notNull().default("accrued"),
  accruedAt: ts("accrued_at").notNull(),
  scheduledFor: ts("scheduled_for"),
  paidAt: ts("paid_at"),
  cancelledAt: ts("cancelled_at"),
  createdAt: createdAt(),
});

export const rewardAdjustmentKind = pgEnum("reward_adjustment_kind", ["amount_change", "cancellation"]);

/**
 * 報酬の変更・取り消し。元の記録は消さない（14章）。
 * 現在の報酬額 = rewards.amount（発生時の額）+ delta の合計。
 */
export const rewardAdjustments = pgTable("reward_adjustments", {
  id: id(),
  rewardId: uuid("reward_id")
    .notNull()
    .references(() => rewards.id),
  kind: rewardAdjustmentKind("kind").notNull().default("amount_change"),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});
