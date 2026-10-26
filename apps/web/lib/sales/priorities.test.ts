import { expect, it } from "vitest";
import { assignmentNextStep, prioritizeAssignments } from "./priorities";
import type { MyAssignmentItem } from "./queries";

const now = new Date("2026-10-16T14:30:00Z"); // 23:30 JST
const base: MyAssignmentItem = {
  id: "a",
  companyId: "c",
  companyName: "架空企業",
  prefecture: null,
  city: null,
  status: "working",
  claimedAt: new Date("2026-10-15T00:00:00Z"),
  expiresAt: null,
  nextActionAt: null,
  lastActivityAt: null,
  contractStatus: null,
};
it("today ends at midnight Japan time and future dates are not called overdue", () => {
  expect(assignmentNextStep({ ...base, nextActionAt: new Date("2026-10-16T14:59:00Z") }, now).group).toBe("today");
  expect(assignmentNextStep({ ...base, nextActionAt: new Date("2026-10-16T15:00:00Z") }, now).group).toBe("scheduled");
  expect(assignmentNextStep({ ...base, nextActionAt: now }, now).group).toBe("overdue");
});
it("waiting and ended assignments never prompt duplicate contact for expired dates", () => {
  for (const status of ["awaiting_ops", "contract_pending"]) {
    expect(assignmentNextStep({ ...base, status, expiresAt: new Date(0), nextActionAt: new Date(0) }, now).group).toBe(
      "waiting",
    );
  }
  for (const status of ["completed", "released", "lost"]) {
    expect(assignmentNextStep({ ...base, status, nextActionAt: new Date(0) }, now).group).toBe("closed");
  }
  expect(assignmentNextStep({ ...base, contractStatus: "reported", nextActionAt: new Date(0) }, now).group).toBe(
    "waiting",
  );
});
it("unset schedules and imminent assignment deadlines suggest the correct next action", () => {
  expect(assignmentNextStep({ ...base, status: "claimed" }, now).label).toContain("初回対応");
  expect(assignmentNextStep(base, now).group).toBe("unscheduled");
  expect(assignmentNextStep({ ...base, expiresAt: new Date("2026-10-16T14:45:00Z") }, now).group).toBe("today");
  expect(assignmentNextStep({ ...base, expiresAt: new Date(0) }, now).label).toContain("担当期限");
});
it("priorities are stable, put overdue work first and preserve the caller's rows", () => {
  const rows = [
    { ...base, id: "waiting", status: "awaiting_ops" },
    { ...base, id: "unscheduled" },
    { ...base, id: "overdue", nextActionAt: new Date(0) },
  ];
  expect(prioritizeAssignments(rows, now).map((a) => a.id)).toEqual(["overdue", "unscheduled", "waiting"]);
  expect(rows[0]?.id).toBe("waiting");
});

it("a completed contract is never described as awaiting contract review", () => {
  expect(assignmentNextStep({ ...base, contractStatus: "completed" }, now).label).toBe("納品の進行状況を確認");
});
