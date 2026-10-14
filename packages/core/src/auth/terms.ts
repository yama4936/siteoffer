import { type DbOrTx, termsVersions } from "@siteoffer/db";
import { desc, eq } from "drizzle-orm";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";

/**
 * 仮の文面。正式な利用条件は未決（REQUIREMENTS.md 未決事項「登録方法・利用条件・本人確認」）。
 * 法的な確認を経た文面ではないため、実運用に使わない。
 */
export const PLACEHOLDER_TERMS = {
  version: "draft-0",
  body: [
    "【仮の文面】この利用条件は開発用の仮置きです。正式な文面は未決です。",
    "1. 営業パートナーは、運営が提示した販売条件・報酬条件の範囲で営業を行います。",
    "2. 価格・契約範囲・報酬額を独断で変更・約束しません。成約を保証する表現を使いません。",
    "3. 他の営業パートナーの非公開情報にアクセスしようとしません。",
    "4. 企業から営業を断られた場合は、その意思を記録し、以後の連絡を控えます。",
    "5. 不正な利用があった場合、運営はアカウントを利用停止にできます。",
  ].join("\n"),
} as const;

export type TermsVersion = typeof termsVersions.$inferSelect;

/** 最新の利用条件（公開日時が最も新しい版）。未登録なら null */
export async function getLatestTerms(db: DbOrTx): Promise<TermsVersion | null> {
  const [row] = await db
    .select()
    .from(termsVersions)
    .orderBy(desc(termsVersions.publishedAt), desc(termsVersions.version))
    .limit(1);
  return row ?? null;
}

/** 利用条件の版を登録する（同じ版があれば何もしない）。seed・運営の管理手順から使う */
export async function ensureTermsVersion(
  db: DbOrTx,
  clock: Clock,
  input: { version: string; body: string },
): Promise<TermsVersion> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(termsVersions).where(eq(termsVersions.version, input.version));
    if (existing) return existing;
    const [row] = await tx
      .insert(termsVersions)
      .values({ version: input.version, body: input.body, publishedAt: clock.now() })
      .returning();
    await recordEvent(tx, clock, {
      actor: { kind: "system", job: "terms" },
      action: "terms.published",
      targetType: "terms_version",
      targetId: row!.id,
      after: { version: input.version },
    });
    return row!;
  });
}
