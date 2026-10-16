import { createHash } from "node:crypto";
import {
  companies,
  contentEntries,
  contentOperations,
  contentRevisions,
  contentWorkingCopies,
  type DbOrTx,
  users,
} from "@siteoffer/db";
import { and, desc, eq } from "drizzle-orm";
import type { Actor, Clock } from "./common/index.ts";
import { ContentError, publishArticle, saveArticle } from "./content.ts";
import { findSecretInFields } from "./domain-preference/secrets.ts";

export type ArticleScope = { companyId: string; entryId: string | null };
export type ArticleValues = { slug: string; title: string; body: string; category: string; baseRevision: string };
export type ArticleWorkingCopy = { revision: number; values: ArticleValues | null; updatedAt: string | null };
export type ArticleWorkspace = {
  scope: ArticleScope;
  current: ArticleValues;
  publishedRevision: number | null;
  publicationRevision: number;
  history: { revision: number; title: string; body: string; category: string }[];
  copy: ArticleWorkingCopy;
};
export type ArticleOperation =
  | { kind: "save"; requestId: string; copyRevision: number }
  | {
      kind: "publish";
      requestId: string;
      expectedRevision: number;
      expectedPublicationRevision: number;
      revision: number | null;
      confirmed: boolean;
    };
export type ArticleWorkspaceResult =
  | { status: "ok"; workspace: ArticleWorkspace; savedRevision: number; replayed: boolean }
  | { status: "conflict"; workspace: ArticleWorkspace; message: string }
  | { status: "error"; message: string };
export class ArticleWorkspaceConflict extends ContentError {
  readonly workspace: ArticleWorkspace;
  constructor(workspace: ArticleWorkspace, message: string) {
    super(message);
    this.workspace = workspace;
  }
}
export class ArticleCopyConflict extends ContentError {
  readonly snapshot: ArticleWorkingCopy;
  constructor(snapshot: ArticleWorkingCopy) {
    super("別の画面で作業コピーが更新されています");
    this.snapshot = snapshot;
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopeKey = (scope: ArticleScope) => scope.entryId?.toLowerCase() ?? "new";
async function access(db: DbOrTx, actor: Actor | null, scope: ArticleScope) {
  if (!scope || !uuid.test(scope.companyId) || (scope.entryId !== null && !uuid.test(scope.entryId)))
    throw new ContentError("企業・記事を確認してください");
  if (actor?.kind !== "ops") throw new ContentError("運営権限が必要です");
  // The company lock serializes editor operations, manual saves and imports in the same order.
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, scope.companyId))
    .for("update");
  if (!company) throw new ContentError("企業がありません");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")))
    .for("share");
  if (!user) throw new ContentError("有効な運営権限が必要です");
  if (scope.entryId) {
    const [entry] = await db
      .select({ id: contentEntries.id })
      .from(contentEntries)
      .where(and(eq(contentEntries.id, scope.entryId), eq(contentEntries.companyId, scope.companyId)));
    if (!entry) throw new ContentError("記事がありません");
  }
  return actor;
}
async function readCopy(db: DbOrTx, userId: string, scope: ArticleScope): Promise<ArticleWorkingCopy> {
  const [copy] = await db
    .select()
    .from(contentWorkingCopies)
    .where(
      and(
        eq(contentWorkingCopies.userId, userId),
        eq(contentWorkingCopies.companyId, scope.companyId),
        eq(contentWorkingCopies.scope, scopeKey(scope)),
      ),
    );
  return copy
    ? { revision: copy.revision, values: copy.values, updatedAt: copy.updatedAt.toISOString() }
    : { revision: 0, values: null, updatedAt: null };
}
async function readWorkspace(db: DbOrTx, userId: string, scope: ArticleScope): Promise<ArticleWorkspace> {
  const copy = await readCopy(db, userId, scope);
  if (!scope.entryId)
    return {
      scope,
      copy,
      current: { slug: "", title: "", body: "", category: "news", baseRevision: "0" },
      publishedRevision: null,
      publicationRevision: 0,
      history: [],
    };
  const [entry] = await db
    .select()
    .from(contentEntries)
    .where(and(eq(contentEntries.id, scope.entryId), eq(contentEntries.companyId, scope.companyId)));
  if (!entry) throw new ContentError("記事がありません");
  const history = await db
    .select({
      revision: contentRevisions.revision,
      title: contentRevisions.title,
      body: contentRevisions.body,
      category: contentRevisions.category,
    })
    .from(contentRevisions)
    .where(eq(contentRevisions.entryId, entry.id))
    .orderBy(desc(contentRevisions.revision));
  const current = history.find((r) => r.revision === entry.currentRevision);
  if (!current) throw new ContentError("記事の版がありません");
  return {
    scope,
    copy,
    current: {
      slug: entry.slug,
      title: current.title,
      body: current.body,
      category: current.category,
      baseRevision: String(entry.currentRevision),
    },
    history,
    publishedRevision: entry.publishedRevision,
    publicationRevision: entry.publicationRevision,
  };
}
export async function loadArticleWorkspace(db: DbOrTx, actor: Actor | null, scope: ArticleScope) {
  return db.transaction(async (tx) => {
    const user = await access(tx, actor, scope);
    return readWorkspace(tx, user.userId, scope);
  });
}
function validateValues(raw: unknown): ArticleValues | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 5)
    throw new ContentError("作業コピーの形式を確認してください");
  const v = raw as Record<string, unknown>;
  for (const [key, max] of [
    ["slug", 80],
    ["title", 160],
    ["body", 30000],
    ["category", 4],
    ["baseRevision", 10],
  ] as const) {
    if (typeof v[key] !== "string" || v[key].length > max || v[key].includes("\0"))
      throw new ContentError("入力の文字数・形式を確認してください");
  }
  if (!["news", "blog"].includes(v.category as string) || !/^(0|[1-9]\d{0,9})$/.test(v.baseRevision as string))
    throw new ContentError("記事の種類・版を確認してください");
  if (findSecretInFields({ title: v.title as string, body: v.body as string }))
    throw new ContentError("秘密情報らしき値があるため保存していません。パスワードや鍵を取り除いてください");
  return {
    slug: v.slug as string,
    title: v.title as string,
    body: v.body as string,
    category: v.category as string,
    baseRevision: v.baseRevision as string,
  };
}
async function writeCopy(
  db: DbOrTx,
  clock: Clock,
  userId: string,
  scope: ArticleScope,
  revision: number,
  values: ArticleValues | null,
): Promise<ArticleWorkingCopy> {
  const patch = { revision: revision + 1, values, updatedAt: clock.now() };
  await db
    .insert(contentWorkingCopies)
    .values({ userId, companyId: scope.companyId, scope: scopeKey(scope), ...patch })
    .onConflictDoUpdate({
      target: [contentWorkingCopies.userId, contentWorkingCopies.companyId, contentWorkingCopies.scope],
      set: patch,
    });
  return { ...patch, updatedAt: patch.updatedAt.toISOString() };
}
export async function saveArticleWorkingCopy(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  scope: ArticleScope,
  revision: number,
  raw: unknown,
) {
  const values = validateValues(raw);
  return db.transaction(async (tx) => {
    const user = await access(tx, actor, scope);
    const copy = await readCopy(tx, user.userId, scope);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ContentError("作業コピーの版を確認してください");
    if (revision !== copy.revision) throw new ArticleCopyConflict(copy);
    const [entry] = scope.entryId
      ? await tx
          .select({ slug: contentEntries.slug, revision: contentEntries.currentRevision })
          .from(contentEntries)
          .where(eq(contentEntries.id, scope.entryId))
      : [];
    if (values && (Number(values.baseRevision) > (entry?.revision ?? 0) || (entry && values.slug !== entry.slug)))
      throw new ContentError("記事のURL名・版を確認してください");
    return writeCopy(tx, clock, user.userId, scope, revision, values);
  });
}
export async function submitArticleOperation(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  scope: ArticleScope,
  input: ArticleOperation,
) {
  if (!input || !uuid.test(input.requestId) || !["save", "publish"].includes(input.kind))
    throw new ContentError("操作内容を確認してください");
  if (
    input.kind === "save" &&
    (Object.keys(input).length !== 3 || !Number.isSafeInteger(input.copyRevision) || input.copyRevision < 1)
  )
    throw new ContentError("先に作業コピーを保存してください");
  if (
    input.kind === "publish" &&
    (Object.keys(input).length !== 6 ||
      input.confirmed !== true ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !Number.isSafeInteger(input.expectedPublicationRevision) ||
      input.expectedPublicationRevision < 0 ||
      (input.revision !== null && (!Number.isSafeInteger(input.revision) || input.revision < 1)))
  )
    throw new ContentError("掲載する内容・版を確認してください");
  return db.transaction(async (tx) => {
    const user = await access(tx, actor, scope);
    const key = hash([user.userId, input.requestId.toLowerCase()]);
    const payloadHash = hash([
      scope.companyId.toLowerCase(),
      scopeKey(scope),
      input.kind,
      input.kind === "save"
        ? input.copyRevision
        : [input.expectedRevision, input.expectedPublicationRevision, input.revision, input.confirmed],
    ]);
    const [receipt] = await tx.select().from(contentOperations).where(eq(contentOperations.key, key));
    if (receipt) {
      if (receipt.payloadHash !== payloadHash) throw new ContentError("同じ受付番号では内容を変更できません");
      return {
        workspace: await readWorkspace(tx, user.userId, { ...scope, entryId: receipt.entryId }),
        savedRevision: receipt.revision,
        replayed: true,
      };
    }
    const workspace = await readWorkspace(tx, user.userId, scope);
    let entryId: string, savedRevision: number;
    if (input.kind === "save") {
      if (workspace.copy.revision !== input.copyRevision)
        throw new ArticleWorkspaceConflict(
          workspace,
          "別の画面で作業コピーが変更されています。比較して選び直してください",
        );
      const values = workspace.copy.values;
      if (!values) throw new ContentError("保存する作業コピーがありません");
      if (values.baseRevision !== workspace.current.baseRevision)
        throw new ArticleWorkspaceConflict(
          workspace,
          "別の担当者が記事を更新しました。入力は残っています。最新の下書きと比較してください",
        );
      const entry = await saveArticle(tx, clock, user, {
        companyId: scope.companyId,
        ...(scope.entryId ? { entryId: scope.entryId, expectedRevision: Number(values.baseRevision) } : {}),
        ...values,
      });
      entryId = entry.id;
      savedRevision = entry.currentRevision;
      await writeCopy(tx, clock, user.userId, scope, workspace.copy.revision, null);
    } else {
      if (!scope.entryId) throw new ContentError("先に記事を保存してください");
      if (
        Number(workspace.current.baseRevision) !== input.expectedRevision ||
        workspace.publicationRevision !== input.expectedPublicationRevision
      )
        throw new ArticleWorkspaceConflict(
          workspace,
          "記事または掲載設定が変更されています。最新の内容を確認して操作し直してください",
        );
      const entry = await publishArticle(tx, clock, user, {
        companyId: scope.companyId,
        entryId: scope.entryId,
        expectedRevision: input.expectedRevision,
        expectedPublicationRevision: input.expectedPublicationRevision,
        revision: input.revision,
      });
      entryId = entry.id;
      savedRevision = entry.currentRevision;
    }
    await tx.insert(contentOperations).values({
      key,
      payloadHash,
      companyId: scope.companyId,
      entryId,
      revision: savedRevision,
      createdAt: clock.now(),
    });
    return { workspace: await readWorkspace(tx, user.userId, { ...scope, entryId }), savedRevision, replayed: false };
  });
}
