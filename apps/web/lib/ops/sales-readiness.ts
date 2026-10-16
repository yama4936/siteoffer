import { type Actor, isTermsReadyForSales, ok } from "@siteoffer/core";
import { type DbOrTx, productTerms } from "@siteoffer/db";
import { desc, eq } from "drizzle-orm";
import { rewardRuleText, yen } from "./format";
import { getReviewInbox } from "./review-inbox";

export async function getSalesReadiness(
  db: DbOrTx,
  actor: Actor | null,
  input: { query?: string; page?: number; companyId?: string } = {},
) {
  const list = await getReviewInbox(db, actor, { view: "ready", query: input.query, page: input.page });
  if (!list.ok) return list;
  const selectedId = input.companyId ?? list.value.items[0]?.id;
  const selection = selectedId ? await getReviewInbox(db, actor, { view: "all", companyId: selectedId }) : null;
  if (selection && !selection.ok) return selection;
  const rows = await db
    .select()
    .from(productTerms)
    .where(eq(productTerms.active, true))
    .orderBy(desc(productTerms.createdAt), desc(productTerms.id));
  return ok({
    ...list.value,
    selected: selection?.ok ? (selection.value.items[0] ?? null) : null,
    terms: rows.map((t) => {
      const scope = t.scope as { description?: unknown } | null;
      return {
        id: t.id,
        name: t.name,
        version: t.version,
        price: yen(t.price),
        monthlyFee: t.monthlyFee === null ? "未設定" : yen(t.monthlyFee),
        reward: rewardRuleText(t.rewardRule),
        scope: typeof scope?.description === "string" ? scope.description : "詳細は商品条件で確認してください",
        ready: isTermsReadyForSales(t),
      };
    }),
  });
}
export type SalesReadiness = Extract<Awaited<ReturnType<typeof getSalesReadiness>>, { ok: true }>["value"];
