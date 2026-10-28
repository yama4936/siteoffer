import { integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./common.ts";
import { companies } from "./companies.ts";
import { contracts } from "./contract.ts";
import { users } from "./users.ts";
/** 顧客の編集アカウントの役割。admin は編集に加えて自社の編集者（editor）を招待・解除できる（T23） */
export type ContentAccessRole = "admin" | "editor";
export const CONTENT_ACCESS_ROLES = ["admin", "editor"] as const satisfies readonly ContentAccessRole[];
export const contentAccess = pgTable(
  "content_access",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id),
    email: text("email").notNull(),
    userId: uuid("user_id").references(() => users.id),
    status: text("status").$type<"invited" | "active" | "revoked">().notNull(),
    // 既存行は migration で admin にする。新規の既定は editor（最初の管理者は運営が明示して付与する）
    role: text("role").$type<ContentAccessRole>().notNull().default("editor"),
    revision: integer("revision").notNull().default(1),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    requestId: uuid("request_id").notNull().unique(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    acceptedAt: ts("accepted_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("content_access_company_email").on(t.companyId, t.email)],
);
