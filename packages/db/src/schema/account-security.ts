import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { ts } from "./common.ts";
export const authAttempts = pgTable(
  "auth_attempts",
  {
    key: text("key").primaryKey(),
    attempts: integer("attempts").notNull(),
    windowStartedAt: ts("window_started_at").notNull(),
  },
  (t) => [index("auth_attempts_window").on(t.windowStartedAt)],
);
