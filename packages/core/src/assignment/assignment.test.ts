import { appSettings, assignments, auditEvents, type Db } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock, HOUR } from "../common/clock.ts";
import { recordActivity } from "../sales-activity/activity.ts";
import { claimAssignment } from "./claim.ts";
import { releaseExpiredAssignments } from "./expiry.ts";
import { extendAssignment, listAssignments, reassignAssignment, releaseAssignment } from "./manage.ts";
import { isActiveAssignmentConflict } from "./shared.ts";
import { createCompany, createOpsUser, createSalesUser } from "./test-helpers.ts";

let db: Db;
let close: () => Promise<void>;
let clock: ReturnType<typeof fixedClock>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock = fixedClock("2026-10-14T00:00:00Z");
});
afterEach(async () => {
  await close();
});

async function activeFor(companyId: string) {
  const rows = await db.select().from(assignments).where(eq(assignments.companyId, companyId));
  return rows.filter((r) => !["released", "lost", "completed"].includes(r.status));
}

describe("担当確保（AC-10）", () => {
  it("同時に複数人が確保しても有効な担当は1件で、ほかは already_assigned", async () => {
    const company = await createCompany(db);
    const sellers = await Promise.all([1, 2, 3, 4, 5].map(() => createSalesUser(db)));
    // 注意：PGliteは単一接続のため、Promise.all でもトランザクションは直列に実行される。
    // ここで確かめられるのは「先行チェック＋一意制約で1件に絞られ、負けた側が Result で返る」こと。
    // 本当の同時実行（行ロック・一意制約の競合）は実PostgreSQL（Docker環境）で確認する。
    const results = await Promise.all(sellers.map((s) => claimAssignment(db, clock, s.actor, company.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r.ok === false && r.error).toBe("already_assigned");
    }
    expect(await activeFor(company.id)).toHaveLength(1);
  });

  it("一意制約違反（先行チェックをすり抜けた同時確保）を already_assigned と判定できる", async () => {
    const company = await createCompany(db);
    const [s1, s2] = [await createSalesUser(db), await createSalesUser(db)];
    const now = clock.now();
    await db.insert(assignments).values({ companyId: company.id, userId: s1.user.id, claimedAt: now });
    const e = await db
      .insert(assignments)
      .values({ companyId: company.id, userId: s2.user.id, claimedAt: now })
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).not.toBeNull();
    expect(isActiveAssignmentConflict(e)).toBe(true);
    expect(isActiveAssignmentConflict(new Error("other"))).toBe(false);
  });

  it("確保を履歴に残す", async () => {
    const company = await createCompany(db);
    const s = await createSalesUser(db);
    const r = await claimAssignment(db, clock, s.actor, company.id);
    expect(r.ok).toBe(true);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "assignment.claim"));
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(s.user.id);
  });

  it("営業可能でない企業・営業ユーザー以外・停止中のユーザーは確保できない", async () => {
    const notReady = await createCompany(db, { pipelineStatus: "in_review" });
    const company = await createCompany(db);
    const s = await createSalesUser(db);
    const suspended = await createSalesUser(db, { status: "suspended" });
    const ops = await createOpsUser(db);

    const r1 = await claimAssignment(db, clock, s.actor, notReady.id);
    expect(r1.ok === false && r1.error).toBe("company_not_sellable");
    const r2 = await claimAssignment(db, clock, ops.actor, company.id);
    expect(r2.ok === false && r2.error).toBe("forbidden");
    const r3 = await claimAssignment(db, clock, suspended.actor, company.id);
    expect(r3.ok === false && r3.error).toBe("user_suspended");
    const r4 = await claimAssignment(db, clock, { kind: "system", job: "x" }, company.id);
    expect(r4.ok === false && r4.error).toBe("forbidden");
  });
});

describe("同時担当の上限（AC-11）", () => {
  it("既定3社を超える確保は limit_reached で拒否する", async () => {
    const s = await createSalesUser(db);
    const cs = await Promise.all([1, 2, 3, 4].map(() => createCompany(db)));
    for (const c of cs.slice(0, 3)) {
      expect((await claimAssignment(db, clock, s.actor, c.id)).ok).toBe(true);
    }
    const r = await claimAssignment(db, clock, s.actor, cs[3]!.id);
    expect(r.ok === false && r.error).toBe("limit_reached");
    expect(await activeFor(cs[3]!.id)).toHaveLength(0);
  });

  it("上限は運営設定から読む", async () => {
    await db.insert(appSettings).values({ key: "assignment.maxActivePerUser", value: 1 });
    const s = await createSalesUser(db);
    const [a, b] = [await createCompany(db), await createCompany(db)];
    expect((await claimAssignment(db, clock, s.actor, a.id)).ok).toBe(true);
    const r = await claimAssignment(db, clock, s.actor, b.id);
    expect(r.ok === false && r.error).toBe("limit_reached");
  });

  it("解除した担当は上限に数えない", async () => {
    await db.insert(appSettings).values({ key: "assignment.maxActivePerUser", value: 1 });
    const s = await createSalesUser(db);
    const [a, b] = [await createCompany(db), await createCompany(db)];
    const r = await claimAssignment(db, clock, s.actor, a.id);
    if (!r.ok) throw new Error(r.error);
    expect((await releaseAssignment(db, clock, s.actor, { assignmentId: r.value.id, reason: "辞退" })).ok).toBe(true);
    expect((await claimAssignment(db, clock, s.actor, b.id)).ok).toBe(true);
  });
});

describe("未着手の期限解除（AC-11）", () => {
  it("確保から72時間活動がなければ解除し、別の人が確保できる", async () => {
    const company = await createCompany(db);
    const [s1, s2] = [await createSalesUser(db), await createSalesUser(db)];
    const r = await claimAssignment(db, clock, s1.actor, company.id);
    if (!r.ok) throw new Error(r.error);

    clock.advance(72 * HOUR - 1);
    expect(await releaseExpiredAssignments(db, clock)).toEqual({ released: [], escalated: [] });

    clock.advance(1);
    const res = await releaseExpiredAssignments(db, clock);
    expect(res.released).toEqual([r.value.id]);
    const [row] = await db.select().from(assignments).where(eq(assignments.id, r.value.id));
    expect(row!.status).toBe("released");
    expect(row!.releaseReason).toBe("unstarted_timeout");
    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "assignment.release_unstarted_timeout"));
    expect(events).toHaveLength(1);
    expect(events[0]!.actorKind).toBe("system");

    // 再実行しても二重に処理しない
    expect(await releaseExpiredAssignments(db, clock)).toEqual({ released: [], escalated: [] });
    expect((await claimAssignment(db, clock, s2.actor, company.id)).ok).toBe(true);
  });

  it("未着手（not_started）の記録だけでは着手扱いにしない", async () => {
    const company = await createCompany(db);
    const s = await createSalesUser(db);
    const r = await claimAssignment(db, clock, s.actor, company.id);
    if (!r.ok) throw new Error(r.error);
    await recordActivity(db, clock, s.actor, { assignmentId: r.value.id, kind: "not_started" });
    clock.advance(72 * HOUR);
    expect((await releaseExpiredAssignments(db, clock)).released).toEqual([r.value.id]);
  });

  it("活動があれば期限が延び、72時間では解除しない", async () => {
    const company = await createCompany(db);
    const s = await createSalesUser(db);
    const r = await claimAssignment(db, clock, s.actor, company.id);
    if (!r.ok) throw new Error(r.error);
    clock.advance(48 * HOUR);
    await recordActivity(db, clock, s.actor, { assignmentId: r.value.id, kind: "no_answer" });
    clock.advance(24 * HOUR);
    expect(await releaseExpiredAssignments(db, clock)).toEqual({ released: [], escalated: [] });
  });

  it("営業中（working）の期限超過は解除し、別の人が確保できる（4章 No.52）", async () => {
    const company = await createCompany(db);
    const [s1, s2] = [await createSalesUser(db), await createSalesUser(db)];
    const r = await claimAssignment(db, clock, s1.actor, company.id);
    if (!r.ok) throw new Error(r.error);
    const act = await recordActivity(db, clock, s1.actor, { assignmentId: r.value.id, kind: "no_answer" });
    expect(act.ok && act.value.assignment.status).toBe("working");

    clock.advance(200 * HOUR);
    expect(await releaseExpiredAssignments(db, clock)).toEqual({ released: [r.value.id], escalated: [] });
    const [row] = await db.select().from(assignments).where(eq(assignments.id, r.value.id));
    expect(row!.status).toBe("released");
    expect(row!.releaseReason).toBe("working_timeout");
    const other = await claimAssignment(db, clock, s2.actor, company.id);
    expect(other.ok).toBe(true);
  });

  it("商談中の期限超過は解除せず運営確認待ちにし、別の人は確保できない", async () => {
    const company = await createCompany(db);
    const [s1, s2] = [await createSalesUser(db), await createSalesUser(db)];
    const r = await claimAssignment(db, clock, s1.actor, company.id);
    if (!r.ok) throw new Error(r.error);
    const act = await recordActivity(db, clock, s1.actor, { assignmentId: r.value.id, kind: "negotiating" });
    expect(act.ok && act.value.assignment.status).toBe("negotiating");

    clock.advance(200 * HOUR);
    const res = await releaseExpiredAssignments(db, clock);
    expect(res).toEqual({ released: [], escalated: [r.value.id] });
    const [row] = await db.select().from(assignments).where(eq(assignments.id, r.value.id));
    expect(row!.status).toBe("awaiting_ops");
    expect(row!.releasedAt).toBeNull();

    const other = await claimAssignment(db, clock, s2.actor, company.id);
    expect(other.ok === false && other.error).toBe("already_assigned");
    // 運営確認待ちは再実行しても変わらない
    expect(await releaseExpiredAssignments(db, clock)).toEqual({ released: [], escalated: [] });
  });

  it("期限の時間は運営設定から読む", async () => {
    await db.insert(appSettings).values({ key: "assignment.unstartedTimeoutHours", value: 24 });
    const company = await createCompany(db);
    const s = await createSalesUser(db);
    const r = await claimAssignment(db, clock, s.actor, company.id);
    if (!r.ok) throw new Error(r.error);
    clock.advance(24 * HOUR);
    expect((await releaseExpiredAssignments(db, clock)).released).toEqual([r.value.id]);
  });
});

describe("運営による担当変更・解除・期限延長", () => {
  async function setup() {
    const company = await createCompany(db);
    const [s1, s2] = [await createSalesUser(db), await createSalesUser(db)];
    const ops = await createOpsUser(db);
    const r = await claimAssignment(db, clock, s1.actor, company.id);
    if (!r.ok) throw new Error(r.error);
    return { company, s1, s2, ops, assignment: r.value };
  }

  it("担当変更：旧担当を解除し、新担当を同じ状態で作り、履歴を残す", async () => {
    const { company, s2, ops, assignment, s1 } = await setup();
    await recordActivity(db, clock, s1.actor, { assignmentId: assignment.id, kind: "negotiating" });
    const r = await reassignAssignment(db, clock, ops.actor, {
      assignmentId: assignment.id,
      toUserId: s2.user.id,
      reason: "担当者の休暇",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.released.status).toBe("released");
    expect(r.value.created.userId).toBe(s2.user.id);
    expect(r.value.created.status).toBe("negotiating");
    const active = await activeFor(company.id);
    expect(active.map((a) => a.userId)).toEqual([s2.user.id]);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "assignment.reassign"));
    expect(events).toHaveLength(1);
  });

  it("運営確認待ちの担当を期限延長すると商談中に戻る", async () => {
    const { s1, ops, assignment } = await setup();
    await recordActivity(db, clock, s1.actor, { assignmentId: assignment.id, kind: "negotiating" });
    clock.advance(100 * HOUR);
    await releaseExpiredAssignments(db, clock);
    const r = await extendAssignment(db, clock, ops.actor, {
      assignmentId: assignment.id,
      expiresAt: new Date(clock.now().getTime() + 7 * 24 * HOUR),
      reason: "先方の社内検討待ち",
    });
    expect(r.ok && r.value.status).toBe("negotiating");
    const past = await extendAssignment(db, clock, ops.actor, { assignmentId: assignment.id, expiresAt: clock.now() });
    expect(past.ok === false && past.error).toBe("invalid_expiry");
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "assignment.extend"));
    expect(events).toHaveLength(1);
  });

  it("運営は他人の担当を解除できる", async () => {
    const { ops, assignment } = await setup();
    const r = await releaseAssignment(db, clock, ops.actor, { assignmentId: assignment.id, reason: "運営判断" });
    expect(r.ok && r.value.status).toBe("released");
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "assignment.release_by_ops"));
    expect(events).toHaveLength(1);
  });
});

describe("営業は他人の担当を操作できない", () => {
  it("解除・活動記録・期限延長・担当変更・一覧の閲覧", async () => {
    const company = await createCompany(db);
    const [owner, other] = [await createSalesUser(db), await createSalesUser(db)];
    const r = await claimAssignment(db, clock, owner.actor, company.id);
    if (!r.ok) throw new Error(r.error);
    const id = r.value.id;

    const rel = await releaseAssignment(db, clock, other.actor, { assignmentId: id, reason: "x" });
    expect(rel.ok === false && rel.error).toBe("forbidden");
    const act = await recordActivity(db, clock, other.actor, { assignmentId: id, kind: "no_answer" });
    expect(act.ok === false && act.error).toBe("forbidden");
    const ext = await extendAssignment(db, clock, owner.actor, {
      assignmentId: id,
      expiresAt: new Date(clock.now().getTime() + HOUR),
    });
    expect(ext.ok === false && ext.error).toBe("forbidden");
    const re = await reassignAssignment(db, clock, owner.actor, {
      assignmentId: id,
      toUserId: other.user.id,
      reason: "x",
    });
    expect(re.ok === false && re.error).toBe("forbidden");

    const list = await listAssignments(db, other.actor, { userId: owner.user.id });
    expect(list.ok && list.value).toEqual([]);

    const [row] = await db.select().from(assignments).where(eq(assignments.id, id));
    expect(row!.status).toBe("claimed");
    expect(row!.userId).toBe(owner.user.id);
  });
});
