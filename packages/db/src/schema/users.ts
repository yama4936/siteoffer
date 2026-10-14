import { pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./common.ts";

export const userRole = pgEnum("user_role", ["sales", "ops"]);
export const userStatus = pgEnum("user_status", ["active", "suspended"]);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: userRole("role").notNull(),
  status: userStatus("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 利用条件。文面は版で管理し、同意はどの版に対してかを記録する */
export const termsVersions = pgTable("terms_versions", {
  id: id(),
  version: text("version").notNull().unique(),
  body: text("body").notNull(),
  publishedAt: ts("published_at").notNull().defaultNow(),
});

export const termsAcceptances = pgTable(
  "terms_acceptances",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    termsVersionId: uuid("terms_version_id")
      .notNull()
      .references(() => termsVersions.id),
    acceptedAt: ts("accepted_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("terms_acceptances_user_version").on(t.userId, t.termsVersionId)],
);

export const sessions = pgTable("sessions", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});
