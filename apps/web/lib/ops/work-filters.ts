import { WORK_GROUPS, type WorkGroup } from "./work-model";

export type WorkCursor = {
  filter: string;
  offsets: Partial<Record<WorkGroup, number>>;
  publicationAfter?: { since: string; id: string };
};
export type WorkFilters = { group: WorkGroup | "all"; query: string; cursor: WorkCursor | null };
export const emptyWorkFilters: WorkFilters = { group: "all", query: "", cursor: null };
export const workFilterKey = (group: string, query: string) => `${group}\n${query}`;
export function parseWorkFilters(params: URLSearchParams): WorkFilters | null {
  if (["group", "q", "cursor"].some((key) => params.getAll(key).length > 1)) return null;
  const group = params.get("group") ?? "all",
    raw = params.get("q") ?? "";
  if ((group !== "all" && !Object.hasOwn(WORK_GROUPS, group)) || raw.length > 200) return null;
  const query = raw.trim(),
    serialized = params.get("cursor");
  let cursor: WorkCursor | null = null;
  if (serialized !== null) {
    if (!serialized || serialized.length > 4096) return null;
    try {
      const value = JSON.parse(serialized);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((k) => !["filter", "offsets", "publicationAfter"].includes(k)) ||
        value.filter !== workFilterKey(group, query) ||
        !value.offsets ||
        typeof value.offsets !== "object" ||
        Array.isArray(value.offsets)
      )
        return null;
      if (
        Object.entries(value.offsets).some(
          ([key, n]) =>
            !Object.hasOwn(WORK_GROUPS, key) ||
            (group !== "all" && key !== group) ||
            typeof n !== "number" ||
            !Number.isSafeInteger(n) ||
            n < 0 ||
            n > 2147483647,
        )
      )
        return null;
      const after = value.publicationAfter;
      if (
        after !== undefined &&
        (!after ||
          typeof after !== "object" ||
          Array.isArray(after) ||
          Object.keys(after).some((k) => !["since", "id"].includes(k)) ||
          typeof after.since !== "string" ||
          !Number.isFinite(Date.parse(after.since)) ||
          new Date(after.since).toISOString() !== after.since ||
          typeof after.id !== "string" ||
          !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(after.id) ||
          !value.offsets.publication_materials)
      )
        return null;
      if (value.offsets.publication_materials && !after) return null;
      cursor = value as WorkCursor;
    } catch {
      return null;
    }
  }
  return { group: group as WorkFilters["group"], query, cursor };
}
export function workHref(filters: WorkFilters, path = "/ops") {
  const params = new URLSearchParams();
  if (filters.group !== "all") params.set("group", filters.group);
  if (filters.query) params.set("q", filters.query);
  if (filters.cursor) params.set("cursor", JSON.stringify(filters.cursor));
  return `${path}${params.size ? `?${params}` : ""}`;
}
