import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, id } from "./common.ts";

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
