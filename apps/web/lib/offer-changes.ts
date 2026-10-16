import { type Actor, getOfferChangeContext, parseRewardRule } from "@siteoffer/core";
import type { DbOrTx, productTerms } from "@siteoffer/db";
import { formatYen } from "./sales/labels";
export function offerTermsView(t: typeof productTerms.$inferSelect) {
  const rule = parseRewardRule(t.rewardRule);
  const scope = t.scope as { description?: unknown };
  return {
    id: t.id,
    name: t.name,
    version: t.version,
    price: formatYen(t.price),
    monthly: t.monthlyFee === null ? "なし・未設定" : formatYen(t.monthlyFee),
    reward: !rule.ok
      ? "未設定"
      : rule.value.type === "fixed"
        ? formatYen(rule.value.amount)
        : `販売価格の${rule.value.basisPoints / 100}%`,
    scope: typeof scope?.description === "string" ? scope.description : "詳しい提供範囲は商品設定を確認してください",
  };
}
export async function getOfferChangeView(db: DbOrTx, actor: Actor | null, assignmentId: string) {
  const r = await getOfferChangeContext(db, actor, assignmentId);
  if (!r.ok) return null;
  const c = r.value;
  const view = (o: typeof c.current) =>
    o
      ? {
          id: o.offer.id,
          proposalId: o.proposal.id,
          proposalVersion: o.proposal.version,
          terms: offerTermsView(o.terms),
        }
      : null;
  return {
    assignmentId: c.assignment.id,
    companyId: c.company.id,
    companyName: c.company.name,
    blocked: c.blocked,
    current: view(c.current),
    terms: c.terms.map(offerTermsView),
    versions: c.versions,
    history: c.history.map((h) => ({
      id: h.change.id,
      status: h.change.status,
      reason: h.change.reason,
      responseNote: h.change.responseNote,
      createdAt: h.change.createdAt.toISOString(),
      decidedAt: h.change.decidedAt?.toISOString() ?? null,
      before: view(h.before),
      after: view(h.after),
    })),
  };
}
export type OfferChangeView = NonNullable<Awaited<ReturnType<typeof getOfferChangeView>>>;
export type OfferView = NonNullable<OfferChangeView["current"]>;
