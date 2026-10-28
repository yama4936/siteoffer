import {
  ACTIVE_ASSIGNMENT_STATUSES,
  assignments,
  CONTENT_ACCESS_ROLES,
  type ContentAccessRole,
  companies,
  contentAccess,
  contentEntries,
  contentRevisions,
  contracts,
  type DbOrTx,
  users,
} from "@siteoffer/db";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { authAttemptKey, claimAuthAttempt, clearAuthAttempts } from "./auth/attempts.ts";
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
import {
  activeContentOperator,
  authorizeContentEditor,
  authorizeContentReader,
  ContentError,
  customerContentAccess,
  lockContentCompany,
} from "./content-auth.ts";
import { can } from "./permissions/policy.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validToken(token: string) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}
function accessView(row: typeof contentAccess.$inferSelect, accountStatus: "active" | "suspended" | null = null) {
  return {
    accountStatus,
    id: row.id,
    email: row.email,
    role: row.role,
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
  return db.transaction(
    async (tx) => {
      if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
      await authorizeContentReader(tx, actor, companyId);
      const [company] = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (!company) throw new ContentError("この企業の記事管理は利用できません");
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
    },
    { isolationLevel: "repeatable read" },
  );
}
export type ContentAccessInput = {
  companyId: string;
  contractId: string;
  email: string;
  /** 省略時は admin（最初の管理者は運営が付与する。T23） */
  role?: ContentAccessRole;
  expectedRevision: number;
  requestId: string;
  confirmed: boolean;
};
const isRole = (role: unknown): role is ContentAccessRole =>
  typeof role === "string" && (CONTENT_ACCESS_ROLES as readonly string[]).includes(role);
function validInvitation(input: { email: unknown; expectedRevision: unknown; requestId: unknown; confirmed: unknown }) {
  return (
    typeof input.requestId === "string" &&
    uuid.test(input.requestId) &&
    typeof input.email === "string" &&
    Number.isSafeInteger(input.expectedRevision) &&
    (input.expectedRevision as number) >= 0 &&
    input.confirmed === true
  );
}
type InvitationWrite = {
  companyId: string;
  contractId: string;
  email: string;
  role: ContentAccessRole;
  expectedRevision: number;
  requestId: string;
  createdBy: string;
};
/**
 * 招待の発行（会社のロックと操作者の確認の後に呼ぶ）。受付番号の再送は同じ結果を返す。
 * guard は上書きする既存行の確認（顧客の管理者は管理者の行を上書きできない等）。
 */
async function writeInvitation(
  tx: DbOrTx,
  clock: Clock,
  actor: Extract<Actor, { kind: "ops" | "customer_user" }>,
  w: InvitationWrite,
  guard: (before: typeof contentAccess.$inferSelect | undefined) => void = () => {},
) {
  const [receipt] = await tx.select().from(contentAccess).where(eq(contentAccess.requestId, w.requestId));
  if (receipt) {
    if (
      receipt.companyId !== w.companyId ||
      receipt.createdBy !== w.createdBy ||
      receipt.email !== w.email ||
      receipt.contractId !== w.contractId ||
      receipt.role !== w.role
    )
      throw new ContentError("受付番号の内容が異なります");
    return { access: accessView(receipt), token: null, replayed: true };
  }
  await completedContract(tx, w.companyId, w.contractId);
  const [existingUser] = await tx
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.email, w.email))
    .for("share");
  if (existingUser && (existingUser.role !== "customer" || existingUser.status !== "active"))
    throw new ContentError("このメールアドレスは顧客用の記事更新に招待できません");
  const [before] = await tx
    .select()
    .from(contentAccess)
    .where(and(eq(contentAccess.companyId, w.companyId), eq(contentAccess.email, w.email)))
    .for("update");
  guard(before);
  if ((before?.revision ?? 0) !== w.expectedRevision)
    throw new ContentError("利用権限が変更されています。最新の一覧を確認してください");
  if (before?.status === "active")
    throw new ContentError("この方は利用開始済みです。停止するときは一覧の操作を使ってください");
  const token = generateToken(),
    now = clock.now(),
    expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  const values = {
    companyId: w.companyId,
    contractId: w.contractId,
    email: w.email,
    userId: null,
    status: "invited" as const,
    role: w.role,
    revision: (before?.revision ?? 0) + 1,
    tokenHash: hashToken(token),
    expiresAt,
    requestId: w.requestId,
    createdBy: w.createdBy,
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
      companyId: w.companyId,
      contractId: w.contractId,
      role: w.role,
      revision: row!.revision,
      expiresAt: expiresAt.toISOString(),
      scopeConfirmed: true,
    },
  });
  return { access: accessView(row!), token, replayed: false };
}
export async function inviteContentEditor(db: DbOrTx, clock: Clock, actor: Actor | null, input: ContentAccessInput) {
  if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
  if (!input || !uuid.test(input.contractId) || !validInvitation(input))
    throw new ContentError("契約・招待先・確認チェックを入力してください");
  const role = input.role ?? "admin";
  if (!isRole(role)) throw new ContentError("役割を確認してください");
  const email = normalizeEmail(input.email);
  if (!validateEmail(email)) throw new ContentError("メールアドレスを確認してください");
  return db.transaction(async (tx) => {
    await lockContentCompany(tx, input.companyId);
    await activeContentOperator(tx, actor);
    return writeInvitation(tx, clock, actor, {
      companyId: input.companyId,
      contractId: input.contractId,
      email,
      role,
      expectedRevision: input.expectedRevision,
      requestId: input.requestId,
      createdBy: actor.userId,
    });
  });
}
export type CompanyEditorInviteInput = {
  companyId: string;
  email: string;
  expectedRevision: number;
  requestId: string;
  confirmed: boolean;
};
/** 顧客の管理者が自社の編集者（editor 固定）を招待する。契約は管理者自身の利用権限の契約を使う（T23） */
export async function inviteCompanyEditor(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: CompanyEditorInviteInput,
) {
  if (actor?.kind !== "customer_user") throw new ContentError("顧客アカウントでログインしてください");
  if (!input || !validInvitation(input)) throw new ContentError("招待先・確認チェックを入力してください");
  const email = normalizeEmail(input.email);
  if (!validateEmail(email)) throw new ContentError("メールアドレスを確認してください");
  return db.transaction(async (tx) => {
    await lockContentCompany(tx, input.companyId);
    const { access: admin } = await customerContentAccess(tx, actor, input.companyId, true);
    if (admin.role !== "admin") throw new ContentError("担当者の招待は自社の管理者だけが行えます");
    return writeInvitation(
      tx,
      clock,
      actor,
      {
        companyId: input.companyId,
        contractId: admin.contractId,
        email,
        role: "editor",
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        createdBy: actor.userId,
      },
      (before) => {
        if (before?.role === "admin") throw new ContentError("管理者の利用権限は運営にご依頼ください");
      },
    );
  });
}
type AccessTarget = { companyId: string; accessId: string; revision: number };
const validTarget = (input: AccessTarget) =>
  !!input && uuid.test(input.accessId) && Number.isSafeInteger(input.revision) && input.revision >= 1;
/**
 * 利用権限の停止（会社のロックと操作者の確認の後に呼ぶ）。同じ画面からの再送は停止後の状態を返す。
 * guard は停止前の行の確認（顧客の管理者は自分自身・管理者を停止できない等）。
 */
async function writeRevocation(
  tx: DbOrTx,
  clock: Clock,
  actor: Extract<Actor, { kind: "ops" | "customer_user" }>,
  input: AccessTarget,
  guard: (before: typeof contentAccess.$inferSelect) => void = () => {},
) {
  const [before] = await tx
    .select()
    .from(contentAccess)
    .where(and(eq(contentAccess.id, input.accessId), eq(contentAccess.companyId, input.companyId)))
    .for("update");
  if (!before) throw new ContentError("利用権限がありません");
  guard(before);
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
    before: { status: before.status, role: before.role },
    after: { companyId: before.companyId, revision: row!.revision },
  });
  return accessView(row!);
}
/** 運営による停止。最後の管理者でも停止できる（緊急停止・解約のため。T23） */
export async function revokeContentEditor(db: DbOrTx, clock: Clock, actor: Actor | null, input: AccessTarget) {
  if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
  if (!validTarget(input)) throw new ContentError("利用権限を確認してください");
  return db.transaction(async (tx) => {
    await lockContentCompany(tx, input.companyId);
    await activeContentOperator(tx, actor);
    return writeRevocation(tx, clock, actor, input);
  });
}
/** 顧客の管理者による自社の編集者の解除。対象は editor だけで、自分自身と管理者は解除できない（T23） */
export async function revokeCompanyEditor(db: DbOrTx, clock: Clock, actor: Actor | null, input: AccessTarget) {
  if (actor?.kind !== "customer_user") throw new ContentError("顧客アカウントでログインしてください");
  if (!validTarget(input)) throw new ContentError("利用権限を確認してください");
  return db.transaction(async (tx) => {
    await lockContentCompany(tx, input.companyId);
    const { access: admin } = await customerContentAccess(tx, actor, input.companyId, true);
    if (admin.role !== "admin") throw new ContentError("担当者の解除は自社の管理者だけが行えます");
    return writeRevocation(tx, clock, actor, input, (before) => {
      if (before.id === admin.id || before.userId === actor.userId)
        throw new ContentError("ご自身の利用権限は解除できません");
      if (before.role === "admin") throw new ContentError("管理者の利用権限は運営にご依頼ください");
    });
  });
}
/**
 * 運営による役割の変更（T23）。停止済みの利用権限は変更できない。
 * 有効な管理者（利用開始済み・アカウント有効）が0人になる降格は拒否する。
 */
export async function changeContentAccessRole(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: AccessTarget & { role: ContentAccessRole },
) {
  if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
  if (!validTarget(input) || !isRole(input.role)) throw new ContentError("利用権限と役割を確認してください");
  return db.transaction(async (tx) => {
    await lockContentCompany(tx, input.companyId);
    await activeContentOperator(tx, actor);
    const [before] = await tx
      .select()
      .from(contentAccess)
      .where(and(eq(contentAccess.id, input.accessId), eq(contentAccess.companyId, input.companyId)))
      .for("update");
    if (!before) throw new ContentError("利用権限がありません");
    if (before.role === input.role && before.revision === input.revision + 1) return accessView(before);
    if (before.revision !== input.revision)
      throw new ContentError("利用権限が変更されています。最新の一覧を確認してください");
    if (before.status === "revoked") throw new ContentError("停止済みの利用権限は役割を変更できません");
    if (before.role === input.role) return accessView(before);
    if (before.role === "admin" && before.status === "active") {
      const others = await tx
        .select({ id: contentAccess.id })
        .from(contentAccess)
        .innerJoin(users, eq(users.id, contentAccess.userId))
        .where(
          and(
            eq(contentAccess.companyId, input.companyId),
            eq(contentAccess.role, "admin"),
            eq(contentAccess.status, "active"),
            eq(users.status, "active"),
            ne(contentAccess.id, before.id),
          ),
        );
      if (others.length === 0)
        throw new ContentError("有効な管理者がいなくなるため変更できません。先に別の方を管理者にしてください");
    }
    const [row] = await tx
      .update(contentAccess)
      .set({ role: input.role, revision: before.revision + 1, updatedAt: clock.now() })
      .where(eq(contentAccess.id, before.id))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "content_access.role_change",
      targetType: "content_access",
      targetId: before.id,
      before: { role: before.role },
      after: { companyId: before.companyId, role: row!.role, revision: row!.revision },
    });
    return accessView(row!);
  });
}
/** 顧客画面用：その企業での自分の役割（admin / editor）。利用権限がなければ ContentError */
export async function customerContentRole(
  db: DbOrTx,
  actor: Actor | null,
  companyId: string,
): Promise<ContentAccessRole> {
  return db.transaction(async (tx) => (await customerContentAccess(tx, actor, companyId, false)).access.role, {
    isolationLevel: "repeatable read",
  });
}
/** 顧客の管理者用：自社のアカウントと役割の一覧。契約・トークンは返さない */
export async function loadCompanyContentAccess(db: DbOrTx, actor: Actor | null, companyId: string) {
  return db.transaction(
    async (tx) => {
      const { access: self } = await customerContentAccess(tx, actor, companyId, false);
      if (self.role !== "admin") throw new ContentError("担当者の一覧は自社の管理者だけが確認できます");
      const [company] = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId));
      const rows = await tx
        .select({ access: contentAccess, accountStatus: users.status })
        .from(contentAccess)
        .leftJoin(users, eq(users.id, contentAccess.userId))
        .where(eq(contentAccess.companyId, companyId))
        .orderBy(desc(contentAccess.updatedAt));
      return {
        company: company!,
        selfAccessId: self.id,
        access: rows.map((r) => {
          const { contractId: _contractId, ...view } = accessView(r.access, r.accountStatus);
          return view;
        }),
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
/**
 * 営業用：担当企業の顧客アカウントと役割を見るだけ（T23）。見られるのは、有効な担当を持つ企業か、
 * その企業の完了契約の担当営業（contracts.sales_user_id）が本人の企業。トークン・ハッシュ・契約は返さない。
 */
export async function loadSalesContentAccess(db: DbOrTx, actor: Actor | null, companyId: string) {
  if (actor?.kind !== "sales" && actor?.kind !== "ops") throw new ContentError("営業または運営の権限が必要です");
  if (!uuid.test(companyId)) throw new ContentError("企業を確認してください");
  return db.transaction(
    async (tx) => {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, actor.userId), eq(users.role, actor.kind), eq(users.status, "active")));
      if (!user) throw new ContentError("有効なアカウントが必要です");
      const [company] = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (!company) throw new ContentError("この企業の顧客アカウントは表示できません");
      const assigned = await tx
        .select({ userId: assignments.userId })
        .from(assignments)
        .where(and(eq(assignments.companyId, companyId), inArray(assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES])));
      const contracted = await tx
        .select({ userId: contracts.salesUserId })
        .from(contracts)
        .where(and(eq(contracts.companyId, companyId), eq(contracts.status, "completed")));
      const salesUserIds = [...new Set([...assigned, ...contracted].map((r) => r.userId))];
      if (!can(actor, "read", { type: "contentAccess", companyId, salesUserIds }))
        throw new ContentError("この企業の顧客アカウントは表示できません");
      const rows = await tx
        .select({
          id: contentAccess.id,
          email: contentAccess.email,
          role: contentAccess.role,
          status: contentAccess.status,
          expiresAt: contentAccess.expiresAt,
          acceptedAt: contentAccess.acceptedAt,
          revokedAt: contentAccess.revokedAt,
          accountStatus: users.status,
        })
        .from(contentAccess)
        .leftJoin(users, eq(users.id, contentAccess.userId))
        .where(eq(contentAccess.companyId, companyId))
        .orderBy(desc(contentAccess.updatedAt));
      return {
        company,
        access: rows.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          status: r.status,
          accountStatus: r.accountStatus,
          expiresAt: r.expiresAt.toISOString(),
          acceptedAt: r.acceptedAt?.toISOString() ?? null,
          revokedAt: r.revokedAt?.toISOString() ?? null,
        })),
      };
    },
    { isolationLevel: "repeatable read" },
  );
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
    .select({ companyId: contentAccess.companyId, email: contentAccess.email })
    .from(contentAccess)
    .where(eq(contentAccess.tokenHash, tokenHash));
  if (!hint) throw new ContentError("この招待は利用できません。運営に再発行を依頼してください");
  const attemptKey = authAttemptKey("credential", hint.email);
  if (!(await claimAuthAttempt(db, clock, attemptKey)))
    throw new ContentError("試行回数の上限に達しました。15分ほど待ってからお試しください");
  try {
    const accepted = await db.transaction(async (tx) => {
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
    await clearAuthAttempts(db, attemptKey);
    return accepted;
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
