import { createHash } from "node:crypto";
import { type Actor, type Clock, err, ok, recordEvent } from "@siteoffer/core";
import { auditEvents, companies, type DbOrTx, discoverySources, users, websites } from "@siteoffer/db";
import { isThirdPartyDomain, normalizeUrl } from "@siteoffer/discovery";
import { and, desc, eq, sql } from "drizzle-orm";
import { detectSecretLike } from "../../../../packages/core/src/domain-preference/secrets.ts";
import { currentAuditSite } from "../../../worker/src/audit-request.ts";
import { checkPublicHttpUrl } from "../../../worker/src/url.ts";
import { isUuid } from "./form.ts";

type Company = typeof companies.$inferSelect;
type Site = Pick<typeof websites.$inferSelect, "id" | "url" | "kind" | "isPrimary">;
export function websiteReviewFingerprint(
  company: Pick<Company, "id" | "updatedAt" | "officialSiteStatus">,
  site?: Site,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        company.id,
        company.updatedAt.toISOString(),
        company.officialSiteStatus,
        site ? [site.id, site.url, site.kind, site.isPrimary] : null,
      ]),
    )
    .digest("hex");
}
const control = (value: string) =>
  Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
export function safeWebsiteCandidateUrl(input: unknown) {
  if (typeof input !== "string" || input.length > 2048 || control(input)) return null;
  const raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw),
      decoded = decodeURIComponent(raw);
    if (
      url.hash ||
      !checkPublicHttpUrl(raw).ok ||
      detectSecretLike(decoded) ||
      /(?:sk-(?:proj-)?[a-z0-9_-]{20,}|ghp_[a-z0-9]{30,})/i.test(decoded)
    )
      return null;
    for (const key of url.searchParams.keys())
      if (
        /^(?:token|access_?token|refresh_?token|id_token|password|secret|api_?key|auth|authorization|session|sessionid|sid|signature|sig|key)$/i.test(
          key,
        )
      )
        return null;
    const normalized = normalizeUrl(raw);
    return normalized.ok ? { url: url.href, ...normalized.value } : null;
  } catch {
    return null;
  }
}
class SiteReviewError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
async function run<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>) {
  try {
    return ok(await db.transaction(fn));
  } catch (error) {
    if (error instanceof SiteReviewError) return err(error.code, error.message);
    throw error;
  }
}
async function activeOperator(tx: DbOrTx, actor: Actor | null) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId))
    throw new SiteReviewError("forbidden", "有効な運営権限が必要です");
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")))
    .for("share");
  if (!user) throw new SiteReviewError("forbidden", "有効な運営権限が必要です");
  return actor;
}
export async function saveWebsiteCandidate(
  { db, clock }: { db: DbOrTx; clock: Clock },
  actor: Actor | null,
  input: {
    companyId: string;
    requestId: string;
    expected: string;
    url: string;
    sourceUrl: string;
    note: string;
    confirmed: boolean;
  },
) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden", "有効な運営権限が必要です");
  const candidate = safeWebsiteCandidateUrl(input.url),
    source = safeWebsiteCandidateUrl(input.sourceUrl);
  if (
    !isUuid(input.companyId) ||
    !isUuid(input.requestId) ||
    !/^[a-f0-9]{64}$/.test(input.expected) ||
    !candidate ||
    !source ||
    input.confirmed !== true ||
    typeof input.note !== "string" ||
    input.note.trim().length < 5 ||
    input.note.length > 2000 ||
    control(input.note) ||
    detectSecretLike(input.note)
  )
    return err(
      "invalid_input",
      "公開URL、出典URL、5〜2000文字の確認根拠と確認欄を確認してください。認証情報を含むURLは保存できません。",
    );
  const note = input.note.trim(),
    digest = createHash("sha256")
      .update(JSON.stringify([input.companyId, candidate.url, source.url, note]))
      .digest("hex");
  return run(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:website-candidate:${input.requestId}`}))`);
    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("update");
    const ops = await activeOperator(tx, actor);
    if (!company) throw new SiteReviewError("not_found", "企業を確認できません");
    const [receipt] = await tx
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "website.candidate_received"),
          eq(auditEvents.targetType, "website_candidate_operation"),
          eq(auditEvents.targetId, input.requestId),
        ),
      )
      .limit(1);
    if (receipt) {
      const saved = receipt.after as { digest?: string; websiteId?: string };
      if (saved.digest !== digest) throw new SiteReviewError("operation_reused", "この操作IDは別の入力で使用済みです");
      return { websiteId: saved.websiteId!, created: false, alreadySaved: true };
    }
    if (websiteReviewFingerprint(company) !== input.expected)
      throw new SiteReviewError("stale", "確認後に企業情報が変わりました。画面を更新して選び直してください。");
    const previousTarget = company.officialSiteStatus === "confirmed" ? await currentAuditSite(tx, company.id) : null;
    // The unique normalized URL remains the final arbiter across companies and collection processes.
    const inserted = await tx
      .insert(websites)
      .values({
        companyId: company.id,
        url: candidate.url,
        normalizedUrl: candidate.normalizedUrl,
        domain: candidate.domain,
        kind: "current",
        isPrimary: false,
        createdAt: clock.now(),
      })
      .onConflictDoNothing({ target: websites.normalizedUrl })
      .returning();
    const [site] = inserted.length
      ? inserted
      : await tx.select().from(websites).where(eq(websites.normalizedUrl, candidate.normalizedUrl));
    if (!site || site.companyId !== company.id || site.kind !== "current")
      throw new SiteReviewError(
        "url_conflict",
        "このURLは別の企業または提案サイトに登録されています。既存の紐づきを確認してください。",
      );
    if (safeWebsiteCandidateUrl(site.url)?.normalizedUrl !== candidate.normalizedUrl)
      throw new SiteReviewError(
        "invalid_existing_site",
        "既存のURL情報と一致しません。企業のサイト記録を確認してください。",
      );
    if (inserted.length) {
      const preserveConfirmed = !!previousTarget && !!safeWebsiteCandidateUrl(previousTarget.url);
      if (preserveConfirmed && !previousTarget!.isPrimary)
        await tx.update(websites).set({ isPrimary: true }).where(eq(websites.id, previousTarget!.id));
      await tx
        .update(companies)
        .set({
          officialSiteStatus:
            company.officialSiteStatus === "not_found" ||
            (company.officialSiteStatus === "confirmed" && !preserveConfirmed)
              ? "needs_review"
              : company.officialSiteStatus,
          updatedAt: clock.now(),
        })
        .where(eq(companies.id, company.id));
    }
    await recordEvent(tx, clock, {
      actor: ops,
      action: "company.website_candidate_saved",
      targetType: "company",
      targetId: company.id,
      after: {
        websiteId: site.id,
        url: site.url,
        sourceUrl: source.url,
        note,
        created: !!inserted.length,
        preservedPrimaryWebsiteId:
          previousTarget && safeWebsiteCandidateUrl(previousTarget.url) ? previousTarget.id : null,
      },
    });
    await recordEvent(tx, clock, {
      actor: ops,
      action: "website.candidate_received",
      targetType: "website_candidate_operation",
      targetId: input.requestId,
      after: { companyId: company.id, websiteId: site.id, digest },
    });
    return { websiteId: site.id, created: !!inserted.length, alreadySaved: false };
  });
}
export async function reviewOfficialWebsite(
  { db, clock }: { db: DbOrTx; clock: Clock },
  actor: Actor | null,
  input: {
    companyId: string;
    status: Company["officialSiteStatus"];
    websiteId?: string | null;
    note?: string;
    expected?: string;
  },
) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden", "有効な運営権限が必要です");
  if (
    !isUuid(input.companyId) ||
    !["confirmed", "candidate", "needs_review", "not_found"].includes(input.status) ||
    (input.websiteId && !isUuid(input.websiteId)) ||
    (input.note?.length ?? 0) > 2000 ||
    detectSecretLike(input.note)
  )
    return err("invalid_input", "企業、公式サイトの確度、確認メモを確認してください");
  return run(db, async (tx) => {
    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).for("update");
    const ops = await activeOperator(tx, actor);
    if (!company) throw new SiteReviewError("not_found", "企業を確認できません");
    const [selected] = input.websiteId
      ? await tx
          .select()
          .from(websites)
          .where(
            and(eq(websites.id, input.websiteId), eq(websites.companyId, company.id), eq(websites.kind, "current")),
          )
      : [];
    if (input.websiteId && !selected)
      throw new SiteReviewError("website_not_found", "この企業の現サイトを選んでください");
    if (input.expected && websiteReviewFingerprint(company, selected) !== input.expected)
      throw new SiteReviewError("stale", "確認後に企業やサイトが変わりました。画面を更新して選び直してください。");
    const site =
      selected ??
      (input.status === "confirmed" && !input.expected ? await currentAuditSite(tx, company.id) : undefined);
    if (input.status === "confirmed" && (!site || !safeWebsiteCandidateUrl(site.url)))
      throw new SiteReviewError("website_required", "確認した公開URLの現サイトを明示的に選んでください");
    const changePrimary = input.status === "confirmed" && !!site && !site.isPrimary;
    if (company.officialSiteStatus === input.status && !changePrimary) return company;
    if (input.status === "confirmed" && site) {
      await tx
        .update(websites)
        .set({ isPrimary: false })
        .where(and(eq(websites.companyId, company.id), eq(websites.kind, "current")));
      await tx.update(websites).set({ isPrimary: true }).where(eq(websites.id, site.id));
    }
    const [after] = await tx
      .update(companies)
      .set({ officialSiteStatus: input.status, updatedAt: clock.now() })
      .where(eq(companies.id, company.id))
      .returning();
    await recordEvent(tx, clock, {
      actor: ops,
      action: "company.official_site_status",
      targetType: "company",
      targetId: company.id,
      before: { officialSiteStatus: company.officialSiteStatus },
      after: {
        officialSiteStatus: input.status,
        primaryWebsiteId: input.status === "confirmed" ? site!.id : null,
        note: input.note?.trim() || null,
      },
    });
    return after!;
  });
}
export async function listWebsiteCandidateEvidence(db: DbOrTx, actor: Actor | null, companyId: string) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId) || !isUuid(companyId)) return err("forbidden");
  return run(db, async (tx) => {
    await activeOperator(tx, actor);
    return tx
      .select({ id: auditEvents.id, at: auditEvents.createdAt, by: users.displayName, data: auditEvents.after })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorId))
      .where(
        and(
          eq(auditEvents.targetType, "company"),
          eq(auditEvents.targetId, companyId),
          eq(auditEvents.action, "company.website_candidate_saved"),
        ),
      )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(20);
  });
}

/** Bounded public metadata only; search snippets and page bodies are never sent to the client. */
export async function listSiteSearchCandidates(db: DbOrTx, actor: Actor | null, companyId: string) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId) || !isUuid(companyId)) return err("forbidden");
  return run(db, async (tx) => {
    await activeOperator(tx, actor);
    const rows = await tx
      .select({
        id: discoverySources.id,
        provider: sql<string>`left(${discoverySources.provider}, 100)`,
        fetchedAt: discoverySources.fetchedAt,
        sourceUrl: sql<
          string | null
        >`case when length(${discoverySources.sourceUrl}) <= 2048 then ${discoverySources.sourceUrl} else null end`,
        url: sql<
          string | null
        >`case when length(${discoverySources.payload}->>'url') <= 2048 then ${discoverySources.payload}->>'url' else null end`,
        title: sql<string | null>`left(${discoverySources.payload}->>'title', 300)`,
        verdict: sql<string | null>`left(${discoverySources.payload}->>'verdict', 40)`,
        reason: sql<string | null>`left(${discoverySources.payload}->>'reason', 500)`,
      })
      .from(discoverySources)
      .where(and(eq(discoverySources.companyId, companyId), eq(discoverySources.role, "site")))
      .orderBy(desc(discoverySources.fetchedAt), desc(discoverySources.id))
      .limit(20);
    return rows.flatMap((row) => {
      const url = safeWebsiteCandidateUrl(row.url);
      if (!url) return [];
      const source = safeWebsiteCandidateUrl(row.sourceUrl);
      return [
        {
          ...row,
          url: url.url,
          sourceUrl: source?.url ?? null,
          fetchedAt: row.fetchedAt.toISOString(),
          selectable:
            !!source &&
            !isThirdPartyDomain(url.domain) &&
            ["unrelated", "probable", "verified"].includes(row.verdict ?? ""),
        },
      ];
    });
  });
}
