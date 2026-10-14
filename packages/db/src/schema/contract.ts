import { boolean, index, integer, jsonb, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { assignments } from "./assignment.ts";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";
import { proposalVersions } from "./proposal.ts";
import { users } from "./users.ts";

/**
 * 販売条件と報酬条件（14章）。版を持ち、契約時点の内容は contracts.snapshot に写す。
 * 金額の値は未決。テストではテスト内の値だけを使う。
 */
export const productTerms = pgTable("product_terms", {
  id: id(),
  version: text("version").notNull().unique(),
  name: text("name").notNull(),
  scope: jsonb("scope").notNull(),
  /** 円。未設定なら営業可能にできない */
  price: integer("price"),
  monthlyFee: integer("monthly_fee"),
  /** 報酬の算式（定額・割合など）。未設定なら営業可能にできない */
  rewardRule: jsonb("reward_rule"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

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
    productTermsId: uuid("product_terms_id").references(() => productTerms.id),
    proposalVersionId: uuid("proposal_version_id").references(() => proposalVersions.id),
    /** 価格・範囲・提案版・ドメイン対応・継続費用・担当・報酬条件の写し。完了時に固定 */
    snapshot: jsonb("snapshot"),
    documentRef: text("document_ref"),
    reportNote: text("report_note"),
    reportedAt: ts("reported_at").notNull(),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("contracts_company").on(t.companyId), index("contracts_sales_user").on(t.salesUserId)],
);

export const paymentStatus = pgEnum("payment_status", ["pending", "received", "refunded", "cancelled"]);

/** 顧客からの入金。報酬とは別に管理する */
export const payments = pgTable("payments", {
  id: id(),
  contractId: uuid("contract_id")
    .notNull()
    .references(() => contracts.id),
  amount: integer("amount").notNull(),
  status: paymentStatus("status").notNull().default("pending"),
  receivedAt: ts("received_at"),
  note: text("note"),
  createdAt: createdAt(),
});

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
  createdAt: createdAt(),
});

/** 報酬の変更・取り消し。元の記録は消さない（14章） */
export const rewardAdjustments = pgTable("reward_adjustments", {
  id: id(),
  rewardId: uuid("reward_id")
    .notNull()
    .references(() => rewards.id),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});
