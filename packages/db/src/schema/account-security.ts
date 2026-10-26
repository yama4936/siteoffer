import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, ts } from "./common.ts";
import { users } from "./users.ts";
export const authAttempts = pgTable(
  "auth_attempts",
  {
    key: text("key").primaryKey(),
    attempts: integer("attempts").notNull(),
    windowStartedAt: ts("window_started_at").notNull(),
  },
  (t) => [index("auth_attempts_window").on(t.windowStartedAt)],
);

export const passwordRecoveries = pgTable(
  "password_recoveries",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    credentialRevision: integer("credential_revision").notNull(),
    status: text("status")
      .$type<"requested" | "issued" | "consumed" | "cancelled" | "expired">()
      .notNull()
      .default("requested"),
    revision: integer("revision").notNull().default(1),
    requestedAt: ts("requested_at").notNull(),
    issuedAt: ts("issued_at"),
    expiresAt: ts("expires_at"),
    tokenHash: text("token_hash").unique(),
    issueRequestId: uuid("issue_request_id").unique(),
    issuedBy: uuid("issued_by").references(() => users.id),
    verificationMethod: text("verification_method").$type<"known_contact" | "in_person">(),
    consumedAt: ts("consumed_at"),
    cancelledAt: ts("cancelled_at"),
  },
  (t) => [
    index("password_recoveries_requested").on(t.requestedAt),
    uniqueIndex("password_recoveries_one_open").on(t.userId).where(sql`${t.status} in ('requested','issued')`),
  ],
);
