import { createHash } from "node:crypto";
import { type Actor, type Clock, createDesign, type DesignBrief } from "@siteoffer/core";
import { companies, type DbOrTx, designBriefDrafts, designVersions, siteAudits, users } from "@siteoffer/db";
import { and, eq, sql } from "drizzle-orm";
import { DESIGN_BRIEF_FIELDS, type DesignDraftScope, type DesignDraftSnapshot } from "./design-draft-types";
import { isUuid } from "./form";

export class DesignDraftError extends Error {}
export class DesignDraftConflict extends DesignDraftError {
  readonly snapshot: DesignDraftSnapshot;
  constructor(snapshot: DesignDraftSnapshot) {
    super("別の画面で下書きが更新されました");
    this.snapshot = snapshot;
  }
}
function validateValues(value: unknown): DesignBrief | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 5)
    throw new DesignDraftError("制作条件を確認してください");
  const fields = value as Record<string, unknown>;
  for (const [key] of DESIGN_BRIEF_FIELDS) {
    if (typeof fields[key] !== "string" || fields[key].length > 1600)
      throw new DesignDraftError("制作条件は各項目1600文字以内で入力してください");
  }
  return Object.fromEntries(DESIGN_BRIEF_FIELDS.map(([key]) => [key, fields[key]])) as DesignBrief;
}
async function authorize(db: DbOrTx, actor: Actor | null, scope: DesignDraftScope) {
  if (actor?.kind !== "ops") throw new DesignDraftError("運営としてログインしてください");
  if (
    !scope ||
    !isUuid(scope.companyId) ||
    (scope.designId !== null && !isUuid(scope.designId)) ||
    (scope.auditId !== null && !isUuid(scope.auditId))
  )
    throw new DesignDraftError("対象の案件を確認してください");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  if (!user) throw new DesignDraftError("運営としてログインしてください");
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, scope.companyId));
  if (!company) throw new DesignDraftError("対象の案件がありません");
  if (scope.designId) {
    const [design] = await db
      .select({ id: designVersions.id })
      .from(designVersions)
      .where(and(eq(designVersions.id, scope.designId), eq(designVersions.companyId, scope.companyId)));
    if (!design) throw new DesignDraftError("対象のデザインがありません");
  }
  if (scope.auditId) {
    const [audit] = await db
      .select({ id: siteAudits.id })
      .from(siteAudits)
      .where(and(eq(siteAudits.id, scope.auditId), eq(siteAudits.companyId, scope.companyId)));
    if (!audit) throw new DesignDraftError("対象の診断がありません");
  }
  return {
    userId: actor.userId,
    companyId: scope.companyId,
    context: `${scope.designId ?? "new"}:${scope.auditId ?? "none"}`,
  };
}
type Identity = Awaited<ReturnType<typeof authorize>>;
function where(id: Identity) {
  return and(
    eq(designBriefDrafts.userId, id.userId),
    eq(designBriefDrafts.companyId, id.companyId),
    eq(designBriefDrafts.context, id.context),
  );
}
async function read(db: DbOrTx, id: Identity): Promise<DesignDraftSnapshot> {
  const [row] = await db.select().from(designBriefDrafts).where(where(id));
  return row
    ? { revision: row.revision, values: row.values as DesignBrief | null, updatedAt: row.updatedAt.toISOString() }
    : { revision: 0, values: null, updatedAt: null };
}
async function lock(db: DbOrTx, id: Identity) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`design-draft:${id.userId}:${id.companyId}:${id.context}`}))`,
  );
}
function checkRevision(expected: number, current: DesignDraftSnapshot) {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new DesignDraftError("下書きの版を確認してください");
  if (expected !== current.revision) throw new DesignDraftConflict(current);
}
async function write(
  db: DbOrTx,
  clock: Clock,
  id: Identity,
  previous: DesignDraftSnapshot,
  values: DesignBrief | null,
) {
  const now = clock.now();
  const next = { revision: previous.revision + 1, values, updatedAt: now };
  await db
    .insert(designBriefDrafts)
    .values({ ...id, ...next })
    .onConflictDoUpdate({
      target: [designBriefDrafts.userId, designBriefDrafts.companyId, designBriefDrafts.context],
      set: next,
    });
  return { ...next, updatedAt: now.toISOString() };
}
export async function loadDesignDraft(db: DbOrTx, actor: Actor | null, scope: DesignDraftScope) {
  return read(db, await authorize(db, actor, scope));
}
export async function saveDesignDraft(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  scope: DesignDraftScope,
  revision: number,
  input: unknown,
) {
  const values = validateValues(input);
  return db.transaction(async (tx) => {
    const id = await authorize(tx, actor, scope);
    await lock(tx, id);
    const current = await read(tx, id);
    checkRevision(revision, current);
    return write(tx, clock, id, current, values);
  });
}
/** The new version and draft consumption commit together. A failed creation leaves the working copy intact. */
export async function createDesignFromDraft(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  scope: DesignDraftScope,
  input: { revision: number; brief: unknown; requestKey: string; source: "openai" | "import"; model?: string },
) {
  const brief = validateValues(input.brief);
  if (!brief || !scope.auditId) throw new DesignDraftError("対象の診断と制作条件を確認してください");
  if (!isUuid(input.requestKey) || !["openai", "import"].includes(input.source))
    throw new DesignDraftError("操作を確認してください");
  return db.transaction(async (tx) => {
    const id = await authorize(tx, actor, scope);
    await lock(tx, id);
    // Stable for identical retries; edited conditions create a different request, even after a lost response.
    const requestKey = `draft:${createHash("sha256")
      .update(JSON.stringify([id, input.requestKey, brief, input.source, input.model ?? null]))
      .digest("hex")}`;
    const [existing] = await tx
      .select({ id: designVersions.id })
      .from(designVersions)
      .where(eq(designVersions.requestKey, requestKey));
    if (existing) return existing.id;
    const current = await read(tx, id);
    checkRevision(input.revision, current);
    const row = await createDesign(tx, clock, actor, {
      companyId: scope.companyId,
      auditId: scope.auditId!,
      requestKey,
      brief,
      source: input.source,
      ...(input.model ? { model: input.model } : {}),
    });
    await write(tx, clock, id, current, null);
    return row.id;
  });
}
