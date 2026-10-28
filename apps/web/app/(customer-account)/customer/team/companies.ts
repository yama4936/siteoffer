import { type Actor, ContentError, customerContentRole, listCustomerContentCompanies } from "@siteoffer/core";
import { getDb } from "@/lib/db";

/** 自分が管理者になっている会社（担当者の管理を使える会社）。役割の判定は core に任せる */
export async function listTeamAdminCompanies(actor: Actor) {
  const db = getDb();
  try {
    const companies = await listCustomerContentCompanies(db, actor);
    const roles = await Promise.all(
      companies.map((c) =>
        customerContentRole(db, actor, c.id).catch((e) => (e instanceof ContentError ? null : Promise.reject(e))),
      ),
    );
    return { companies, admin: companies.filter((_, i) => roles[i] === "admin") };
  } catch (e) {
    if (e instanceof ContentError) return { companies: [], admin: [] };
    throw e;
  }
}
