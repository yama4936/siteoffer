import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { updatedAt } from "./common.ts";
import { users } from "./users.ts";

/** 運営設定（担当の上限・期限など）。値の変更はauditEventsにも残す */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});
