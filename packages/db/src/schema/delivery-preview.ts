import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { deliveryVersions } from "./delivery.ts";
import { sessions } from "./users.ts";

/** 運営の短時間プレビュー。顧客共有・顧客確認・承認とは独立し、ログアウトで失効する。 */
export const deliveryPreviews = pgTable(
  "delivery_previews",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => deliveryVersions.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("delivery_previews_expiry").on(t.expiresAt)],
);
