import { parseProposalImageSnapshot, proposalRevisionFingerprint } from "@siteoffer/core";
import type { proposalVersions } from "@siteoffer/db";
import { comparisonInputBounded, proposalDisplayGroups } from "./proposal-display-fields";

type Version = typeof proposalVersions.$inferSelect;
export type ReviewChange = { key: string; label: string; before: string; after: string; excerpted: boolean };
export type ReviewComparison =
  | { status: "unavailable"; reason: string }
  | {
      status: "ready";
      basis: "revision" | "previous";
      sourceId: string;
      sourceVersion: number;
      sourceHasDemo: boolean;
      changed: number;
      compared: number;
      groups: { id: string; title: string; changes: ReviewChange[]; unavailable: boolean }[];
    };
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Show the changed part of a long field, not two identical prefixes that hide a late edit. */
export function reviewChangeExcerpt(before: string, after: string) {
  if (Math.max(before.length, after.length) <= 1600) return { before, after, excerpted: false };
  let first = 0;
  while (first < Math.min(before.length, after.length) && before[first] === after[first]) first++;
  const start = Math.max(0, first - 200);
  const window = (s: string) => {
    const from = start > 0 && /[\uDC00-\uDFFF]/.test(s[start] ?? "") ? start - 1 : start;
    let end = Math.min(s.length, from + 1000);
    if (end < s.length && /[\uDC00-\uDFFF]/.test(s[end] ?? "")) end++;
    return `${from ? "…" : ""}${s.slice(from, end)}${s.length > end ? "…" : ""}`;
  };
  return { before: window(before), after: window(after), excerpted: true };
}

export function buildReviewComparison(current: Version, versions: readonly Version[]): ReviewComparison {
  const content = record(current.content);
  let source: Version | undefined;
  let basis: "revision" | "previous" = "previous";
  if (content.proposalRevision !== undefined) {
    basis = "revision";
    const pin = record(content.proposalRevision);
    source = versions.find(
      (v) =>
        v.id === pin.sourceVersionId &&
        v.proposalId === current.proposalId &&
        v.version < current.version &&
        v.auditId === current.auditId,
    );
    if (
      !source ||
      source.version !== pin.sourceVersion ||
      !comparisonInputBounded(source.content) ||
      typeof pin.sourceSha256 !== "string" ||
      proposalRevisionFingerprint(source) !== pin.sourceSha256
    )
      return {
        status: "unavailable",
        reason: "保存した修正元の提案を確認できません。制作履歴から元の版と内容を確認してください。",
      };
  } else
    source = [...versions]
      .filter((v) => v.proposalId === current.proposalId && v.version < current.version)
      .sort((a, b) => b.version - a.version)[0];
  if (!source) return { status: "unavailable", reason: "比較する前の提案版はありません。" };
  const groups: Extract<ReviewComparison, { status: "ready" }>["groups"] = [];
  let changed = 0,
    compared = 0;
  const previous = proposalDisplayGroups(source.content);
  for (const next of proposalDisplayGroups(current.content)) {
    const old = previous.find((g) => g.id === next.id)!;
    const unavailable = next.unavailable || old.unavailable;
    const changes: ReviewChange[] = [];
    if (!unavailable)
      for (const entry of next.fields) {
        const before = old.fields.find((f) => f.key === entry.key)?.value ?? "";
        compared++;
        if (before !== entry.value) {
          changed++;
          changes.push({ key: entry.key, label: entry.label, ...reviewChangeExcerpt(before, entry.value) });
        }
      }
    groups.push({ id: next.id, title: next.title, unavailable, changes });
  }
  const oldContent = record(source.content);
  const assetsBounded =
    comparisonInputBounded(oldContent.demoImageAssets) && comparisonInputBounded(content.demoImageAssets);
  const beforeAssets = assetsBounded ? parseProposalImageSnapshot(oldContent.demoImageAssets) : null;
  const afterAssets = assetsBounded ? parseProposalImageSnapshot(content.demoImageAssets) : null;
  const imageChanges: ReviewChange[] = [];
  function imageField(key: string, label: string, before: string, after: string) {
    compared++;
    if (before !== after) {
      changed++;
      imageChanges.push({ key, label, ...reviewChangeExcerpt(before, after) });
    }
  }
  const hash = (v: unknown) => (typeof v === "string" && /^[a-f0-9]{64}$/i.test(v) ? v.toLowerCase() : "");
  const oldHash = hash(oldContent.designSha256),
    newHash = hash(content.designSha256);
  const designValid = (oldContent.designSha256 == null || !!oldHash) && (content.designSha256 == null || !!newHash);
  if (designValid)
    imageField(
      "design",
      "制作元の承認画像",
      oldHash ? "登録あり" : "登録なし",
      newHash ? (oldHash && oldHash !== newHash ? "別の承認画像" : "登録あり") : "登録なし",
    );
  if (assetsBounded && beforeAssets && afterAssets) {
    const describe = (items: typeof beforeAssets) =>
      items
        .map((a) => `${a.slot === "hero" ? "メイン写真" : "ロゴ"}：${a.label}`)
        .sort()
        .join("\n") || "登録なし";
    const identity = (items: typeof beforeAssets) =>
      JSON.stringify(
        items
          .map((a) => [a.slot, a.assetId, a.sha256, a.policyRevision, a.policy])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
    const before = describe(beforeAssets),
      after = describe(afterAssets);
    imageField(
      "assets",
      "掲載写真・ロゴ",
      before,
      identity(beforeAssets) !== identity(afterAssets) && before === after
        ? `${after}\n画像ファイルまたは利用条件が変わりました。`
        : after,
    );
  }
  groups.push({
    id: "images",
    title: "画像",
    changes: imageChanges,
    unavailable: !designValid || !assetsBounded || !beforeAssets || !afterAssets,
  });
  return {
    status: "ready",
    basis,
    sourceId: source.id,
    sourceVersion: source.version,
    sourceHasDemo: !!source.demoArtifactDir,
    changed,
    compared,
    groups,
  };
}
