import type { SalesActivityKind } from "@siteoffer/core";
import { ACTIVITY_KINDS } from "./sales/labels";

export type ActivityHistoryFilters = {
  page: number;
  query: string;
  kind: "all" | SalesActivityKind;
  consultations: "all" | "only";
};
export const DEFAULT_ACTIVITY_HISTORY: ActivityHistoryFilters = {
  page: 1,
  query: "",
  kind: "all",
  consultations: "all",
};
export type ActivityHistoryPage = {
  assignment: { id: string; companyId: string; companyName: string; salesName: string; status: string };
  filters: ActivityHistoryFilters;
  items: {
    id: string;
    kind: SalesActivityKind;
    occurredAt: string;
    note: string | null;
    nextActionAt: string | null;
    nextActionMode: string;
    consultOps: boolean;
  }[];
  total: number;
  allTotal: number;
  pageCount: number;
  pageSize: 20;
  hasConsultations: boolean;
  latestNote: string | null;
};
export function parseActivityHistoryQuery(
  search: Record<string, string | string[] | undefined>,
): ActivityHistoryFilters | null {
  const { page = "1", q = "", kind = "all", consultations = "all" } = search;
  if (
    typeof page !== "string" ||
    !/^[1-9]\d*$/.test(page) ||
    !Number.isSafeInteger(Number(page)) ||
    typeof q !== "string" ||
    q.length > 200 ||
    Array.from(q).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    typeof kind !== "string" ||
    (kind !== "all" && !ACTIVITY_KINDS.some((k) => k.value === kind)) ||
    (consultations !== "all" && consultations !== "only")
  )
    return null;
  return { page: Number(page), query: q.trim(), kind: kind as ActivityHistoryFilters["kind"], consultations };
}
export function activityHistoryParams(filters: ActivityHistoryFilters) {
  return new URLSearchParams({
    page: String(filters.page),
    q: filters.query,
    kind: filters.kind,
    consultations: filters.consultations,
  });
}
export function normalizeActivityHistoryFilters(value: unknown): ActivityHistoryFilters | null {
  if (!value || typeof value !== "object") return null;
  const v = value as ActivityHistoryFilters;
  if (
    !Number.isSafeInteger(v.page) ||
    v.page < 1 ||
    typeof v.query !== "string" ||
    typeof v.kind !== "string" ||
    typeof v.consultations !== "string"
  )
    return null;
  return parseActivityHistoryQuery({ page: String(v.page), q: v.query, kind: v.kind, consultations: v.consultations });
}
export function validActivityHistoryPage(value: unknown, assignmentId: string): value is ActivityHistoryPage {
  if (!value || typeof value !== "object") return false;
  const v = value as ActivityHistoryPage;
  return (
    v.assignment?.id === assignmentId &&
    typeof v.assignment.companyName === "string" &&
    v.pageSize === 20 &&
    Number.isSafeInteger(v.total) &&
    v.total >= 0 &&
    Number.isSafeInteger(v.allTotal) &&
    v.allTotal >= v.total &&
    Number.isSafeInteger(v.pageCount) &&
    v.pageCount >= 1 &&
    !!normalizeActivityHistoryFilters(v.filters) &&
    v.filters.page <= v.pageCount &&
    Array.isArray(v.items) &&
    v.items.length <= 20 &&
    typeof v.hasConsultations === "boolean" &&
    (v.latestNote === null || typeof v.latestNote === "string") &&
    v.items.every(
      (i) =>
        !!i &&
        typeof i.id === "string" &&
        ACTIVITY_KINDS.some((k) => k.value === i.kind) &&
        typeof i.occurredAt === "string" &&
        Number.isFinite(Date.parse(i.occurredAt)) &&
        (i.note === null || typeof i.note === "string") &&
        (i.nextActionAt === null ||
          (typeof i.nextActionAt === "string" && Number.isFinite(Date.parse(i.nextActionAt)))) &&
        typeof i.consultOps === "boolean" &&
        typeof i.nextActionMode === "string",
    )
  );
}
