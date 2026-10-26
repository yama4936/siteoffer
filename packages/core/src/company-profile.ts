import { companies, companyProfiles, type DbOrTx, generationJobs, users } from "@siteoffer/db";
import { type CompanyProfileValues, companyProfileValuesSchema, saveCompanyProfileSchema } from "@siteoffer/schemas";
import { and, eq } from "drizzle-orm";
import type { Actor } from "./common/actor.ts";
import type { Clock } from "./common/clock.ts";
import { recordEvent } from "./common/events.ts";

export class CompanyProfileError extends Error {
  readonly code: "invalid" | "conflict";
  constructor(message: string, code: "invalid" | "conflict" = "invalid") {
    super(message);
    this.code = code;
  }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function operator(db: DbOrTx, actor: Actor | null, lock = false) {
  if (actor?.kind !== "ops" || !uuid.test(actor.userId))
    throw new CompanyProfileError("運営としてログインしてください");
  const query = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  const [user] = await (lock ? query.for("share") : query);
  if (!user) throw new CompanyProfileError("運営としてログインしてください");
  return actor;
}
/** Internal worker read; endpoints must authorize their caller before using this. */
export async function loadCompanyProfile(db: DbOrTx, companyId: string) {
  const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.companyId, companyId));
  return profile ? { ...profile, values: companyProfileValuesSchema.parse(profile.values) } : null;
}
export async function loadCompanyProfileForOps(db: DbOrTx, actor: Actor | null, companyId: string) {
  await operator(db, actor);
  if (!uuid.test(companyId)) throw new CompanyProfileError("企業を確認してください");
  const profile = await loadCompanyProfile(db, companyId);
  if (!profile) return null;
  const [reviewer] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, profile.confirmedBy));
  return { ...profile, confirmedByName: reviewer?.name ?? "確認担当" };
}
export async function saveCompanyProfile(db: DbOrTx, clock: Clock, actor: Actor | null, raw: unknown) {
  await operator(db, actor);
  const parsed = saveCompanyProfileSchema.safeParse(raw);
  if (!parsed.success)
    throw new CompanyProfileError(
      "入力・確認根拠・確認欄を確認してください。電話は8〜15桁、メールは有効な形式で入力します。",
    );
  const input = parsed.data;
  return db.transaction(async (tx) => {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .for("update");
    if (!company) throw new CompanyProfileError("企業が見つかりません");
    const ops = await operator(tx, actor, true);
    const before = await loadCompanyProfile(tx, input.companyId);
    if ((before?.revision ?? 0) !== input.expectedRevision)
      throw new CompanyProfileError(
        "別の担当者が会社情報を更新しました。入力内容は残しています。最新の版と照合して確認してください。",
        "conflict",
      );
    if (before && JSON.stringify(before.values) === JSON.stringify(input.values) && before.source === input.source)
      return { profile: before, unchanged: true };
    const row = {
      companyId: input.companyId,
      revision: (before?.revision ?? 0) + 1,
      values: input.values,
      source: input.source,
      confirmedBy: ops.userId,
      confirmedAt: clock.now(),
    };
    await tx.insert(companyProfiles).values(row).onConflictDoUpdate({ target: companyProfiles.companyId, set: row });
    await recordEvent(tx, clock, {
      actor: ops,
      action: "company.profile_verified",
      targetType: "company",
      targetId: input.companyId,
      before: before
        ? {
            revision: before.revision,
            fields: Object.keys(before.values).filter(
              (key) => before.values[key as keyof CompanyProfileValues] !== null,
            ),
          }
        : null,
      after: {
        revision: row.revision,
        fields: Object.keys(row.values).filter((key) => row.values[key as keyof CompanyProfileValues] !== null),
      },
    });
    return { profile: row, unchanged: false };
  });
}
/** Call inside the final save transaction. Profile edits lock the same company row. */
export async function assertCompanyProfileCurrent(db: DbOrTx, companyId: string, revision: unknown) {
  if (revision === undefined) return;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0)
    throw new CompanyProfileError("制作時の会社情報の版を確認できません");
  await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("share");
  const profile = await loadCompanyProfile(db, companyId);
  if ((profile?.revision ?? 0) !== revision)
    throw new CompanyProfileError("制作に使う会社情報が変更されました。更新後の情報で新しい版を制作してください。");
}
/** Old generations lack this reference; new generations must match the current verified profile. */
export async function generationCompanyProfileCurrent(db: DbOrTx, companyId: string, jobId: string | null) {
  if (!jobId) return true;
  const [job] = await db
    .select({ companyId: generationJobs.companyId, inputRef: generationJobs.inputRef })
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId));
  if (!job || job.companyId !== companyId) return false;
  const reference = job.inputRef as { companyProfileRevision?: unknown } | null;
  if (!reference || !Object.hasOwn(reference, "companyProfileRevision")) return true;
  if (!Number.isSafeInteger(reference.companyProfileRevision) || Number(reference.companyProfileRevision) < 0)
    return false;
  const [profile] = await db
    .select({ revision: companyProfiles.revision })
    .from(companyProfiles)
    .where(eq(companyProfiles.companyId, companyId));
  return (profile?.revision ?? 0) === reference.companyProfileRevision;
}
