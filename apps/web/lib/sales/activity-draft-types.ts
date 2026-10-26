import type { SalesActivityKind } from "@siteoffer/core";
export type ActivityValues = {
  kind: SalesActivityKind;
  occurredAt: string;
  nextActionMode: "keep" | "replace" | "clear";
  nextActionAt: string;
  note: string;
  consultOps: boolean;
  declineKind: "" | "not_now" | "do_not_contact";
  recontactAfter: string;
  declineReason: string;
};
export type ActivityDraftSnapshot = { revision: number; values: ActivityValues | null; updatedAt: string | null };
export type ActivityDraftResult =
  | { status: "ok"; snapshot: ActivityDraftSnapshot }
  | { status: "conflict"; snapshot: ActivityDraftSnapshot }
  | { status: "error"; message: string };
export type ActivityCommitResult =
  | { status: "ok"; snapshot: ActivityDraftSnapshot; activityId: string }
  | Exclude<ActivityDraftResult, { status: "ok" }>;
export function jstInputDate(now: Date) {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 16);
}
export function emptyActivity(now: Date): ActivityValues {
  return {
    kind: "no_answer",
    occurredAt: jstInputDate(now),
    nextActionMode: "keep",
    nextActionAt: "",
    note: "",
    consultOps: false,
    declineKind: "",
    recontactAfter: "",
    declineReason: "",
  };
}
export function suggestedFollowUp(now: Date, days: number) {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  jst.setUTCDate(jst.getUTCDate() + days);
  jst.setUTCHours(10, 0, 0, 0);
  return jst.toISOString().slice(0, 16);
}
