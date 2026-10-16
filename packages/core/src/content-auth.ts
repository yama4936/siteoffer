import { companies, contentAccess, contracts, type DbOrTx, users } from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import type { Actor } from "./common/actor.ts";
export class ContentError extends Error {}
export type ContentEditorActor = Extract<Actor, { kind: "ops" | "customer_user" }>;
export async function lockContentCompany(db: DbOrTx, companyId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId))
    throw new ContentError("企業を確認してください");
  const [company] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .for("update");
  if (!company) throw new ContentError("この企業の記事管理は利用できません");
  return company;
}
export async function activeContentOperator(db: DbOrTx, actor: Actor | null) {
  if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")))
    .for("share");
  if (!user) throw new ContentError("有効な運営権限が必要です");
  return actor;
}
/** Call inside a transaction. Revocation and all editor writes share the company lock. */
export async function authorizeContentEditor(
  db: DbOrTx,
  actor: Actor | null,
  companyId: string,
): Promise<ContentEditorActor> {
  if (actor?.kind !== "ops" && actor?.kind !== "customer_user")
    throw new ContentError("運営権限または顧客の記事更新権限が必要です");
  await lockContentCompany(db, companyId);
  if (actor.kind === "ops") return activeContentOperator(db, actor);
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "customer"), eq(users.status, "active")))
    .for("share");
  if (!user) throw new ContentError("有効な顧客アカウントが必要です");
  const [access] = await db
    .select({ id: contentAccess.id, contractId: contentAccess.contractId })
    .from(contentAccess)
    .where(
      and(
        eq(contentAccess.companyId, companyId),
        eq(contentAccess.userId, user.id),
        eq(contentAccess.status, "active"),
      ),
    )
    .for("share");
  if (!access) throw new ContentError("この企業の記事管理は利用できません。運営に利用権限をご確認ください");
  const [contract] = await db
    .select({ id: contracts.id })
    .from(contracts)
    .where(
      and(eq(contracts.id, access.contractId), eq(contracts.companyId, companyId), eq(contracts.status, "completed")),
    )
    .for("share");
  if (!contract) throw new ContentError("記事更新の利用契約を運営にご確認ください");
  return actor;
}
