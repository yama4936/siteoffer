import type { CustomerImageDetails } from "@siteoffer/core";
export const detailKeys = ["label", "rightsBasis", "rightsNote", "requestedDemo", "requestedProduction"] as const;
export type DetailKey = (typeof detailKeys)[number];
export type MaterialDraft = Pick<CustomerImageDetails, DetailKey>;
export type MergeChoices = Partial<Record<DetailKey, "mine" | "latest">>;
export function materialConflicts(base: MaterialDraft, mine: MaterialDraft, latest: MaterialDraft) {
  return detailKeys.filter((key) => mine[key] !== base[key] && latest[key] !== base[key] && mine[key] !== latest[key]);
}
/** Do not silently replace either side when both changed the same field. */
export function mergeMaterialDraft(
  base: MaterialDraft,
  mine: MaterialDraft,
  latest: MaterialDraft,
  choices: MergeChoices,
): MaterialDraft | null {
  if (materialConflicts(base, mine, latest).some((key) => !choices[key])) return null;
  const merged = Object.fromEntries(
    detailKeys.map((key) => [
      key,
      choices[key] === "latest"
        ? latest[key]
        : choices[key] === "mine"
          ? mine[key]
          : mine[key] === base[key]
            ? latest[key]
            : mine[key],
    ]),
  );
  return merged as MaterialDraft;
}
