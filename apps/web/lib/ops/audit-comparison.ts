import type { findings, siteAudits } from "@siteoffer/db";

type Audit = Pick<
  typeof siteAudits.$inferSelect,
  | "id"
  | "companyId"
  | "websiteId"
  | "targetUrl"
  | "finalUrl"
  | "status"
  | "rubricVersion"
  | "scoreConfirmed"
  | "totalScore"
  | "coverage"
  | "evaluatorModel"
>;
export type AuditFindingSummary = Pick<
  typeof findings.$inferSelect,
  "itemCode" | "category" | "status" | "score" | "reason" | "improvementHint" | "critical" | "inference"
>;
const url = (raw: string) => {
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
};
function score(raw: string | null) {
  if (raw === null || raw.length > 200 || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const value = BigInt(whole!);
  return value < 100n || (value === 100n && !/[1-9]/.test(fraction)) ? raw : null;
}
function difference(after: string, before: string) {
  const [aw, af = ""] = after.split("."),
    [bw, bf = ""] = before.split(".");
  const digits = Math.max(af.length, bf.length),
    scale = 10n ** BigInt(digits);
  const delta = BigInt(`${aw}${af.padEnd(digits, "0")}`) - BigInt(`${bw}${bf.padEnd(digits, "0")}`);
  const absolute = delta < 0n ? -delta : delta;
  const fraction = digits ? (absolute % scale).toString().padStart(digits, "0").replace(/0+$/, "") : "";
  return `${delta < 0n ? "-" : ""}${absolute / scale}${fraction ? `.${fraction}` : ""}`;
}
/** Compare saved results; never rescore, infer missing scores or call a provider. */
export function compareAudits(
  current: Audit,
  previous: Audit,
  currentItems: AuditFindingSummary[],
  previousItems: AuditFindingSummary[],
) {
  const reasons: string[] = [];
  if (
    current.companyId !== previous.companyId ||
    current.websiteId !== previous.websiteId ||
    !url(current.targetUrl) ||
    url(current.targetUrl) !== url(previous.targetUrl)
  )
    reasons.push("診断対象が異なります。");
  if (
    !url(current.finalUrl ?? current.targetUrl) ||
    url(current.finalUrl ?? current.targetUrl) !== url(previous.finalUrl ?? previous.targetUrl)
  )
    reasons.push("到達先のURLが異なります。");
  if (current.status !== "evaluated" || previous.status !== "evaluated") reasons.push("完了していない診断があります。");
  if (current.scoreConfirmed !== true || previous.scoreConfirmed !== true)
    reasons.push("総合点が未確定の診断があります。");
  if (!current.rubricVersion?.trim() || current.rubricVersion !== previous.rubricVersion)
    reasons.push("評価基準の版が異なるか、未記録です。");
  if (
    !current.evaluatorModel?.trim() ||
    ["unknown", "不明", "未記録"].includes(current.evaluatorModel.trim().toLowerCase()) ||
    current.evaluatorModel !== previous.evaluatorModel
  )
    reasons.push("採点モデルが異なるか、未記録です。");
  const before = score(previous.totalScore),
    after = score(current.totalScore);
  if (before === null || after === null) reasons.push("比較に使える総合点がありません。");
  const comparable = reasons.length === 0;
  const summarize = ({
    itemCode,
    category,
    status,
    score,
    reason,
    improvementHint,
    critical,
    inference,
  }: AuditFindingSummary): AuditFindingSummary => ({
    itemCode,
    category,
    status,
    score,
    reason,
    improvementHint,
    critical,
    inference,
  });
  const old = new Map(previousItems.map((item) => [item.itemCode, summarize(item)])),
    next = new Map(currentItems.map((item) => [item.itemCode, summarize(item)]));
  const changes = [...new Set([...old.keys(), ...next.keys()])]
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .flatMap((itemCode) => {
      const before = old.get(itemCode) ?? null,
        after = next.get(itemCode) ?? null;
      if (
        before &&
        after &&
        ["category", "status", "score", "reason", "improvementHint", "critical", "inference"].every(
          (key) => before[key as keyof AuditFindingSummary] === after[key as keyof AuditFindingSummary],
        )
      )
        return [];
      return [{ itemCode, before, after }];
    });
  return {
    comparable,
    reasons,
    before,
    after,
    scoreDelta: comparable ? difference(after!, before!) : null,
    coverageChanged: current.coverage !== previous.coverage,
    changes,
  };
}
