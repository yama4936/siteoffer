import { companies, contentAccess, contracts, type DbOrTx, users } from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import type { Actor } from "./common/actor.ts";
export class ContentError extends Error {}
export type ContentEditorActor = Extract<Actor, { kind: "ops" | "customer_user" }>;
async function contentCompany(db: DbOrTx, companyId: string, lock: boolean) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId))
    throw new ContentError("企業を確認してください");
  const query = db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId));
  const [company] = await (lock ? query.for("update") : query);
  if (!company) throw new ContentError("この企業の記事管理は利用できません");
  return company;
}
export async function lockContentCompany(db: DbOrTx, companyId: string) {
  return contentCompany(db, companyId, true);
}
export async function activeContentOperator(db: DbOrTx, actor: Actor | null, lock = true) {
  if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
  const query = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  const [user] = await (lock ? query.for("share") : query);
  if (!user) throw new ContentError("有効な運営権限が必要です");
  return actor;
}
async function authorizeContent(
  db: DbOrTx,
  actor: Actor | null,
  companyId: string,
  lock: boolean,
): Promise<ContentEditorActor> {
  if (actor?.kind !== "ops" && actor?.kind !== "customer_user")
    throw new ContentError("運営権限または顧客の記事更新権限が必要です");
  await contentCompany(db, companyId, lock);
  if (actor.kind === "ops") return activeContentOperator(db, actor, lock);
  const userQuery = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "customer"), eq(users.status, "active")));
  const [user] = await (lock ? userQuery.for("share") : userQuery);
  if (!user) throw new ContentError("有効な顧客アカウントが必要です");
  const accessQuery = db
    .select({ id: contentAccess.id, contractId: contentAccess.contractId })
    .from(contentAccess)
    .where(
      and(
        eq(contentAccess.companyId, companyId),
        eq(contentAccess.userId, user.id),
        eq(contentAccess.status, "active"),
      ),
    );
  const [access] = await (lock ? accessQuery.for("share") : accessQuery);
  if (!access) throw new ContentError("この企業の記事管理は利用できません。運営に利用権限をご確認ください");
  const contractQuery = db
    .select({ id: contracts.id })
    .from(contracts)
    .where(
      and(eq(contracts.id, access.contractId), eq(contracts.companyId, companyId), eq(contracts.status, "completed")),
    );
  const [contract] = await (lock ? contractQuery.for("share") : contractQuery);
  if (!contract) throw new ContentError("記事更新の利用契約を運営にご確認ください");
  return actor;
}
/** Call inside a transaction. Revocation and all editor writes share the company lock. */
export async function authorizeContentEditor(db: DbOrTx, actor: Actor | null, companyId: string) {
  return authorizeContent(db, actor, companyId, true);
}
/** Call inside a repeatable-read transaction; indexes do not block editor writes. */
export async function authorizeContentReader(db: DbOrTx, actor: Actor | null, companyId: string) {
  return authorizeContent(db, actor, companyId, false);
}
