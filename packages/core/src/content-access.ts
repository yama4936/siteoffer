import {
  companies,
  contentAccess,
  contentEntries,
  contentRevisions,
  contracts,
  type DbOrTx,
  users,
} from "@siteoffer/db";
import { and, desc, eq } from "drizzle-orm";
import { generateToken, hashPassword, hashToken, verifyPassword } from "./auth/crypto.ts";
import {
  isUniqueViolation,
  normalizeEmail,
  validateDisplayName,
  validateEmail,
  validatePassword,
} from "./auth/validation.ts";
import { recordEvent } from "./common/events.ts";
import type { Actor, Clock } from "./common/index.ts";
import { activeContentOperator, authorizeContentEditor, ContentError, lockContentCompany } from "./content-auth.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validToken(token: string) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}
function accessView(row: typeof contentAccess.$inferSelect, accountStatus: "active" | "suspended" | null = null) {
  return {
    accountStatus,
    id: row.id,
    email: row.email,
    status: row.status,
    revision: row.revision,
    contractId: row.contractId,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
  };
}
async function completedContract(db: DbOrTx, companyId: string, contractId: string) {
  const [contract] = await db
    .select({ id: contracts.id })
    .from(contracts)
    .where(and(eq(contracts.id, contractId), eq(contracts.companyId, companyId), eq(contracts.status, "completed")))
    .for("share");
  if (!contract) throw new ContentError("記事更新の対象となる完了契約を確認してください");
}
export async function loadContentAccess(db: DbOrTx, actor: Actor | null, companyId: string) {
  return db.transaction(async (tx) => {
    if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
    const company = await lockContentCompany(tx, companyId);
    await activeContentOperator(tx, actor);
    const rows = await tx
      .select({ access: contentAccess, accountStatus: users.status })
      .from(contentAccess)
      .leftJoin(users, eq(users.id, contentAccess.userId))
      .where(eq(contentAccess.companyId, companyId))
      .orderBy(desc(contentAccess.updatedAt));
    const available = await tx
      .select({ id: contracts.id, completedAt: contracts.completedAt })
      .from(contracts)
      .where(and(eq(contracts.companyId, companyId), eq(contracts.status, "completed")))
      .orderBy(desc(contracts.completedAt));
    return {
      company,
      access: rows.map((r) => accessView(r.access, r.accountStatus)),
      contracts: available.map((c) => ({ id: c.id, completedAt: c.completedAt?.toISOString() ?? null })),
    };
  });
}
export type ContentAccessInput = {
  companyId: string;
  contractId: string;
  email: string;
  expectedRevision: number;
  requestId: string;
  confirmed: boolean;
};
export async function inviteContentEditor(db: DbOrTx, clock: Clock, actor: Actor | null, input: ContentAccessInput) {
  if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
  if (
    !input ||
    !uuid.test(input.contractId) ||
    !uuid.test(input.requestId) ||
    typeof input.email !== "string" ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.confirmed !== true
  )
    throw new ContentError("契約・招待先・確認チェックを入力してください");
  const email = normalizeEmail(input.email);
  if (!validateEmail(email)) throw new ContentError("メールアドレスを確認してください");
  return db.transaction(async (tx) => {
    await lockContentCompany(tx, input.companyId);
    await activeContentOperator(tx, actor);
    const [receipt] = await tx.select().from(contentAccess).where(eq(contentAccess.requestId, input.requestId));
    if (receipt) {
      if (
        receipt.companyId !== input.companyId ||
        receipt.createdBy !== actor.userId ||
        receipt.email !== email ||
        receipt.contractId !== input.contractId
      )
        throw new ContentError("受付番号の内容が異なります");
      return { access: accessView(receipt), token: null, replayed: true };
    }
    await completedContract(tx, input.companyId, input.contractId);
    const [existingUser] = await tx
      .select({ role: users.role, status: users.status })
      .from(users)
      .where(eq(users.email, email))
      .for("share");
    if (existingUser && (existingUser.role !== "customer" || existingUser.status !== "active"))
      throw new ContentError("このメールアドレスは顧客用の記事更新に招待できません");
    const [before] = await tx
      .select()
      .from(contentAccess)
      .where(and(eq(contentAccess.companyId, input.companyId), eq(contentAccess.email, email)))
      .for("update");
    if ((before?.revision ?? 0) !== input.expectedRevision)
      throw new ContentError("利用権限が変更されています。最新の一覧を確認してください");
    if (before?.status === "active")
      throw new ContentError("この方は利用開始済みです。停止するときは一覧の操作を使ってください");
    const token = generateToken(),
      now = clock.now(),
      expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const values = {
      companyId: input.companyId,
      contractId: input.contractId,
      email,
      userId: null,
      status: "invited" as const,
      revision: (before?.revision ?? 0) + 1,
      tokenHash: hashToken(token),
      expiresAt,
      requestId: input.requestId,
      createdBy: actor.userId,
      acceptedAt: null,
      revokedAt: null,
      updatedAt: now,
    };
    const [row] = before
      ? await tx.update(contentAccess).set(values).where(eq(contentAccess.id, before.id)).returning()
      : await tx
          .insert(contentAccess)
          .values({ ...values, createdAt: now })
          .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "content_access.invite",
      targetType: "content_access",
      targetId: row!.id,
      after: {
        companyId: input.companyId,
        contractId: input.contractId,
        revision: row!.revision,
        expiresAt: expiresAt.toISOString(),
        scopeConfirmed: true,
      },
    });
    return { access: accessView(row!), token, replayed: false };
  });
}
export async function revokeContentEditor(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: { companyId: string; accessId: string; revision: number },
) {
  if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
  if (!input || !uuid.test(input.accessId) || !Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new ContentError("利用権限を確認してください");
  return db.transaction(async (tx) => {
    await lockContentCompany(tx, input.companyId);
    await activeContentOperator(tx, actor);
    const [before] = await tx
      .select()
      .from(contentAccess)
      .where(and(eq(contentAccess.id, input.accessId), eq(contentAccess.companyId, input.companyId)))
      .for("update");
    if (!before) throw new ContentError("利用権限がありません");
    if (before.status === "revoked" && before.revision === input.revision + 1) return accessView(before);
    if (before.revision !== input.revision)
      throw new ContentError("利用権限が変更されています。最新の一覧を確認してください");
    if (before.status === "revoked") return accessView(before);
    const [row] = await tx
      .update(contentAccess)
      .set({ status: "revoked", revision: before.revision + 1, revokedAt: clock.now(), updatedAt: clock.now() })
      .where(eq(contentAccess.id, before.id))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "content_access.revoke",
      targetType: "content_access",
      targetId: before.id,
      before: { status: before.status },
      after: { companyId: before.companyId, revision: row!.revision },
    });
    return accessView(row!);
  });
}
export async function inspectContentInvitation(db: DbOrTx, clock: Clock, token: string) {
  if (!validToken(token)) return null;
  const [row] = await db
    .select({ access: contentAccess, company: companies.name })
    .from(contentAccess)
    .innerJoin(companies, eq(companies.id, contentAccess.companyId))
    .innerJoin(
      contracts,
      and(
        eq(contracts.id, contentAccess.contractId),
        eq(contracts.companyId, contentAccess.companyId),
        eq(contracts.status, "completed"),
      ),
    )
    .where(eq(contentAccess.tokenHash, hashToken(token)));
  if (!row || row.access.status === "revoked" || row.access.expiresAt <= clock.now()) return null;
  const [user] = await db
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.email, row.access.email));
  if (user && (user.role !== "customer" || user.status !== "active")) return null;
  return {
    companyName: row.company,
    email: row.access.email,
    existingAccount: !!user,
    accepted: row.access.status === "active",
    expiresAt: row.access.expiresAt.toISOString(),
  };
}
export async function acceptContentInvitation(
  db: DbOrTx,
  clock: Clock,
  input: { token: string; displayName: string; password: string; confirmed: boolean },
) {
  if (
    !input ||
    !validToken(input.token) ||
    typeof input.password !== "string" ||
    input.password.length > 200 ||
    typeof input.displayName !== "string" ||
    input.confirmed !== true
  )
    throw new ContentError("招待内容と入力を確認してください");
  const tokenHash = hashToken(input.token);
  const [hint] = await db
    .select({ companyId: contentAccess.companyId })
    .from(contentAccess)
    .where(eq(contentAccess.tokenHash, tokenHash));
  if (!hint) throw new ContentError("この招待は利用できません。運営に再発行を依頼してください");
  try {
    return await db.transaction(async (tx) => {
      await lockContentCompany(tx, hint.companyId);
      const [access] = await tx
        .select()
        .from(contentAccess)
        .where(eq(contentAccess.tokenHash, tokenHash))
        .for("update");
      if (!access || access.status === "revoked" || access.expiresAt <= clock.now())
        throw new ContentError("この招待は期限切れ、または取り消されています");
      await completedContract(tx, access.companyId, access.contractId);
      let [user] = await tx.select().from(users).where(eq(users.email, access.email)).for("update");
      if (user) {
        if (
          user.role !== "customer" ||
          user.status !== "active" ||
          !(await verifyPassword(input.password, user.passwordHash))
        )
          throw new ContentError("登録済み顧客アカウントのパスワードを確認してください");
      } else {
        if (access.status !== "invited") throw new ContentError("この招待は利用できません");
        const pw = validatePassword(input.password);
        if (pw) throw new ContentError(pw);
        if (!validateDisplayName(input.displayName.trim()))
          throw new ContentError("お名前は1〜100文字で入力してください");
        [user] = await tx
          .insert(users)
          .values({
            email: access.email,
            displayName: input.displayName.trim(),
            passwordHash: await hashPassword(input.password),
            role: "customer",
            createdAt: clock.now(),
            updatedAt: clock.now(),
          })
          .returning();
        await recordEvent(tx, clock, {
          actor: { kind: "customer_user", userId: user!.id },
          action: "user.customer_registered",
          targetType: "user",
          targetId: user!.id,
          after: { role: "customer", status: "active" },
        });
      }
      if (access.status === "active") {
        if (access.userId !== user!.id) throw new ContentError("この招待は利用できません");
        return { userId: user!.id, email: access.email, companyId: access.companyId, replayed: true };
      }
      await tx
        .update(contentAccess)
        .set({
          status: "active",
          userId: user!.id,
          revision: access.revision + 1,
          acceptedAt: clock.now(),
          updatedAt: clock.now(),
        })
        .where(eq(contentAccess.id, access.id));
      await recordEvent(tx, clock, {
        actor: { kind: "customer_user", userId: user!.id },
        action: "content_access.accept",
        targetType: "content_access",
        targetId: access.id,
        after: { companyId: access.companyId, contractId: access.contractId, revision: access.revision + 1 },
      });
      return { userId: user!.id, email: access.email, companyId: access.companyId, replayed: false };
    });
  } catch (e) {
    if (isUniqueViolation(e))
      throw new ContentError("同じメールアドレスの登録が完了しました。設定したパスワードでもう一度お試しください");
    throw e;
  }
}
export async function listCustomerContentCompanies(db: DbOrTx, actor: Actor | null) {
  if (actor?.kind !== "customer_user") throw new ContentError("顧客アカウントでログインしてください");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "customer"), eq(users.status, "active")));
  if (!user) throw new ContentError("有効な顧客アカウントが必要です");
  return db
    .select({ id: companies.id, name: companies.name })
    .from(contentAccess)
    .innerJoin(companies, eq(companies.id, contentAccess.companyId))
    .innerJoin(
      contracts,
      and(
        eq(contracts.id, contentAccess.contractId),
        eq(contracts.companyId, contentAccess.companyId),
        eq(contracts.status, "completed"),
      ),
    )
    .where(and(eq(contentAccess.userId, user.id), eq(contentAccess.status, "active")))
    .orderBy(companies.name);
}
export async function loadCustomerArticles(db: DbOrTx, actor: Actor | null, companyId: string) {
  return db.transaction(async (tx) => {
    await authorizeContentEditor(tx, actor, companyId);
    return tx
      .select({
        id: contentEntries.id,
        slug: contentEntries.slug,
        title: contentRevisions.title,
        currentRevision: contentEntries.currentRevision,
        publishedRevision: contentEntries.publishedRevision,
      })
      .from(contentEntries)
      .innerJoin(
        contentRevisions,
        and(
          eq(contentRevisions.entryId, contentEntries.id),
          eq(contentRevisions.revision, contentEntries.currentRevision),
        ),
      )
      .where(eq(contentEntries.companyId, companyId))
      .orderBy(desc(contentEntries.updatedAt));
  });
}
