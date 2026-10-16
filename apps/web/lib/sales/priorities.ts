import type { MyAssignmentItem } from "./queries";
export const ASSIGNMENT_VIEWS = {
  all: "対応中すべて",
  overdue: "予定・期限の超過",
  today: "今日の対応",
  unscheduled: "次回予定なし",
  scheduled: "今後の予定",
  waiting: "運営確認待ち",
  closed: "終了した担当",
} as const;
export type AssignmentView = keyof typeof ASSIGNMENT_VIEWS;
export function assignmentNextStep(a: MyAssignmentItem, now: Date) {
  const time = now.getTime();
  const tomorrowJst = (Math.floor((time + 9 * 3600000) / 86400000) + 1) * 86400000 - 9 * 3600000;
  const result = (group: Exclude<AssignmentView, "all">, priority: number, label: string, reason: string) => ({
    group,
    priority,
    label,
    reason,
    due: Math.min(a.nextActionAt?.getTime() ?? Infinity, a.expiresAt?.getTime() ?? Infinity),
  });
  if (["completed", "released", "lost"].includes(a.status))
    return result("closed", 6, "対応履歴を見る", "この担当での対応は終了しています。");
  if (a.status === "awaiting_ops")
    return result("waiting", 5, "相談・引き継ぎを確認", "運営の判断を待っています。連絡内容を確認できます。");
  if (a.contractStatus === "completed")
    return result(
      "waiting",
      5,
      "納品の進行状況を確認",
      "契約は完了しています。納品に向けた運営からの連絡を確認してください。",
    );
  if (a.status === "contract_pending" || ["reported", "under_review"].includes(a.contractStatus ?? ""))
    return result(
      "waiting",
      5,
      "契約の確認状況を見る",
      "成約報告は確認中です。同じ契約を重複して報告しないでください。",
    );
  if (a.expiresAt && a.expiresAt.getTime() <= time)
    return result(
      "overdue",
      0,
      "担当期限と進捗を確認",
      "担当期限を過ぎています。状況を確認し、必要なら運営へ相談してください。",
    );
  if (a.nextActionAt && a.nextActionAt.getTime() <= time)
    return result(
      "overdue",
      0,
      "予定していた対応を確認",
      "次回対応の予定時刻を過ぎています。対応内容を確認し、記録・予定を更新してください。",
    );
  if (a.nextActionAt && a.nextActionAt.getTime() < tomorrowJst)
    return result(
      "today",
      1,
      "今日の予定を確認",
      "今日の対応予定があります。対応後に進捗と次回予定を記録してください。",
    );
  if (a.expiresAt && a.expiresAt.getTime() < tomorrowJst)
    return result(
      "today",
      1,
      "期限前に進捗を確認",
      "担当期限が今日です。進捗を確認し、継続が必要なら運営へ相談してください。",
    );
  if (!a.nextActionAt)
    return result(
      "unscheduled",
      2,
      a.status === "claimed" ? "提案を確認して初回対応へ" : "次回対応を決める",
      a.status === "claimed"
        ? "担当を確保済みです。提案内容を確認して対応を始めましょう。"
        : "次回の対応予定が未設定です。活動記録から予定を決められます。",
    );
  return result("scheduled", 3, "次の予定を確認", "次回対応の予定を登録済みです。");
}
export function prioritizeAssignments(rows: MyAssignmentItem[], now: Date) {
  return rows
    .map((a) => ({ ...a, next: assignmentNextStep(a, now) }))
    .sort(
      (a, b) =>
        a.next.priority - b.next.priority ||
        (a.next.due === b.next.due ? 0 : a.next.due - b.next.due) ||
        a.claimedAt.getTime() - b.claimedAt.getTime() ||
        a.id.localeCompare(b.id),
    );
}
