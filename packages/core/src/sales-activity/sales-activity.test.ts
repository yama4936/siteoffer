import { assignments, auditEvents, companies, type Db, salesActivities } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimAssignment } from "../assignment/claim.ts";
import { releaseAssignment } from "../assignment/manage.ts";
import { createCompany, createOpsUser, createSalesUser } from "../assignment/test-helpers.ts";
import { DAY, fixedClock, HOUR } from "../common/clock.ts";
import { listActivities, listOpsConsultations, recordActivity } from "./activity.ts";
import { liftSuppression, suppressCompany } from "./suppression.ts";

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

async function claimed() {
  const company = await createCompany(db);
  const s = await createSalesUser(db);
  const r = await claimAssignment(db, clock, s.actor, company.id);
  if (!r.ok) throw new Error(r.error);
  return { company, s, assignment: r.value };
}

async function companyRow(id: string) {
  const [c] = await db.select().from(companies).where(eq(companies.id, id));
  return c!;
}

describe("活動記録（12.3）", () => {
  it("活動に応じて担当の状態を進め、後戻りさせない", async () => {
    const { s, assignment } = await claimed();
    const id = assignment.id;
    const step = async (kind: Parameters<typeof recordActivity>[3]["kind"]) => {
      const r = await recordActivity(db, clock, s.actor, { assignmentId: id, kind });
      if (!r.ok) throw new Error(r.error);
      return r.value.assignment.status;
    };
    expect(await step("not_started")).toBe("claimed");
    expect(await step("no_answer")).toBe("working");
    expect(await step("proposal_sent")).toBe("working");
    expect(await step("negotiating")).toBe("negotiating");
    expect(await step("no_answer")).toBe("negotiating");
    expect(await step("contract_review")).toBe("contract_pending");
    // 契約完了の申告は完了扱いにせず、契約確認待ちのまま（完了は契約確認で行う）
    expect(await step("contract_completed")).toBe("contract_pending");

    const list = await listActivities(db, s.actor, id);
    expect(list.ok && list.value).toHaveLength(7);
  });

  it("再連絡予定には次回対応日が必要で、記録すると担当の次回対応日と期限に反映する", async () => {
    const { s, assignment } = await claimed();
    const bad = await recordActivity(db, clock, s.actor, { assignmentId: assignment.id, kind: "callback_scheduled" });
    expect(bad.ok === false && bad.error).toBe("invalid_input");

    const next = new Date(clock.now().getTime() + 10 * DAY);
    const r = await recordActivity(db, clock, s.actor, {
      assignmentId: assignment.id,
      kind: "callback_scheduled",
      nextActionAt: next,
      note: "来週以降に社長から折り返し",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.assignment.nextActionAt?.getTime()).toBe(next.getTime());
    expect(r.value.assignment.expiresAt?.getTime()).toBe(next.getTime());
    expect(r.value.assignment.lastActivityAt?.getTime()).toBe(clock.now().getTime());
  });

  it("未来の活動日時・過去の次回対応日は受け付けない", async () => {
    const { s, assignment } = await claimed();
    const future = await recordActivity(db, clock, s.actor, {
      assignmentId: assignment.id,
      kind: "no_answer",
      occurredAt: new Date(clock.now().getTime() + HOUR),
    });
    expect(future.ok === false && future.error).toBe("invalid_input");
    const pastNext = await recordActivity(db, clock, s.actor, {
      assignmentId: assignment.id,
      kind: "no_answer",
      nextActionAt: new Date(clock.now().getTime() - HOUR),
    });
    expect(pastNext.ok === false && pastNext.error).toBe("invalid_input");
  });

  it("運営への相談を記録し、運営だけが一覧できる", async () => {
    const { s, assignment } = await claimed();
    const ops = await createOpsUser(db);
    await recordActivity(db, clock, s.actor, {
      assignmentId: assignment.id,
      kind: "negotiating",
      consultOps: true,
      note: "支店単位で契約したいとのこと",
    });
    const r = await listOpsConsultations(db, ops.actor);
    expect(r.ok && r.value.map((a) => a.note)).toEqual(["支店単位で契約したいとのこと"]);
    const denied = await listOpsConsultations(db, s.actor);
    expect(denied.ok === false && denied.error).toBe("forbidden");
  });

  it("失注で担当が終わり、営業抑止にはならない", async () => {
    const { company, s, assignment } = await claimed();
    const r = await recordActivity(db, clock, s.actor, { assignmentId: assignment.id, kind: "lost" });
    expect(r.ok && r.value.assignment.status).toBe("lost");
    expect((await companyRow(company.id)).suppression).toBe("none");
    const again = await recordActivity(db, clock, s.actor, { assignmentId: assignment.id, kind: "no_answer" });
    expect(again.ok === false && again.error).toBe("not_active");
  });

  it("活動を操作履歴に残す", async () => {
    const { s, assignment } = await claimed();
    await recordActivity(db, clock, s.actor, { assignmentId: assignment.id, kind: "negotiating" });
    const recorded = await db.select().from(auditEvents).where(eq(auditEvents.action, "sales_activity.record"));
    expect(recorded).toHaveLength(1);
    const changed = await db.select().from(auditEvents).where(eq(auditEvents.action, "assignment.update_by_activity"));
    expect(changed).toHaveLength(1);
  });

  it("営業は他人の担当の活動履歴を見られない", async () => {
    const { assignment } = await claimed();
    const other = await createSalesUser(db);
    const r = await listActivities(db, other.actor, assignment.id);
    expect(r.ok === false && r.error).toBe("forbidden");
  });
});

describe("営業拒否（AC-12）", () => {
  it("今後連絡しないで：企業共通の抑止になり、担当は失注で終わり、誰も確保できない", async () => {
    const { company, s, assignment } = await claimed();
    const r = await recordActivity(db, clock, s.actor, {
      assignmentId: assignment.id,
      kind: "declined",
      decline: { kind: "do_not_contact", reason: "営業電話はすべて断っている" },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.assignment.status).toBe("lost");
    const c = await companyRow(company.id);
    expect(c.suppression).toBe("do_not_contact");
    expect(c.recontactAfter).toBeNull();

    const others = [s, await createSalesUser(db), await createSalesUser(db)];
    for (const o of others) {
      const claim = await claimAssignment(db, clock, o.actor, company.id);
      expect(claim.ok === false && claim.error).toBe("company_suppressed");
    }
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "company.suppress"));
    expect(events).toHaveLength(1);
  });

  it("今は不要：再連絡の目安を記録し、目安を過ぎても自動では解除しない", async () => {
    const { company, s, assignment } = await claimed();
    const recontact = new Date(clock.now().getTime() + 90 * DAY);
    const r = await recordActivity(db, clock, s.actor, {
      assignmentId: assignment.id,
      kind: "declined",
      decline: { kind: "not_now", recontactAfter: recontact },
    });
    if (!r.ok) throw new Error(r.error);
    const c = await companyRow(company.id);
    expect(c.suppression).toBe("not_now");
    expect(c.recontactAfter?.getTime()).toBe(recontact.getTime());

    clock.advance(100 * DAY);
    const other = await createSalesUser(db);
    const claim = await claimAssignment(db, clock, other.actor, company.id);
    expect(claim.ok === false && claim.error).toBe("company_suppressed");
  });

  it("営業拒否の内容と活動の種類が食い違えば受け付けない", async () => {
    const { s, assignment } = await claimed();
    const noDetail = await recordActivity(db, clock, s.actor, { assignmentId: assignment.id, kind: "declined" });
    expect(noDetail.ok === false && noDetail.error).toBe("invalid_input");
    const wrongKind = await recordActivity(db, clock, s.actor, {
      assignmentId: assignment.id,
      kind: "no_answer",
      decline: { kind: "not_now" },
    });
    expect(wrongKind.ok === false && wrongKind.error).toBe("invalid_input");
    const recontactOnDnc = await recordActivity(db, clock, s.actor, {
      assignmentId: assignment.id,
      kind: "declined",
      decline: { kind: "do_not_contact", recontactAfter: new Date(clock.now().getTime() + DAY) },
    });
    expect(recontactOnDnc.ok === false && recontactOnDnc.error).toBe("invalid_input");
    // 失敗した記録は活動も残さない
    expect(await db.select().from(salesActivities)).toHaveLength(0);
  });

  it("担当の解除や企業の再収集相当の更新で抑止は消えない", async () => {
    const { company, s } = await claimed();
    const ops = await createOpsUser(db);
    const supp = await suppressCompany(db, clock, ops.actor, { companyId: company.id, kind: "do_not_contact" });
    expect(supp.ok).toBe(true);
    // 運営の抑止で有効な担当は解除済み
    const rows = await db.select().from(assignments).where(eq(assignments.companyId, company.id));
    expect(rows.map((a) => a.status)).toEqual(["released"]);
    const rel = await releaseAssignment(db, clock, ops.actor, { assignmentId: rows[0]!.id, reason: "x" });
    expect(rel.ok === false && rel.error).toBe("not_active");

    // 再収集で企業情報が更新されても抑止の列は保持される（T4は suppression を書き換えない約束）
    await db
      .update(companies)
      .set({ industry: "建設業", pipelineStatus: "sellable" })
      .where(eq(companies.id, company.id));
    expect((await companyRow(company.id)).suppression).toBe("do_not_contact");
    const claim = await claimAssignment(db, clock, s.actor, company.id);
    expect(claim.ok === false && claim.error).toBe("company_suppressed");
  });

  it("営業は自分の担当企業にしか営業拒否を記録できず、強い抑止を弱められない", async () => {
    const { company, s } = await claimed();
    const other = await createSalesUser(db);
    const denied = await suppressCompany(db, clock, other.actor, { companyId: company.id, kind: "do_not_contact" });
    expect(denied.ok === false && denied.error).toBe("forbidden");
    const excluded = await suppressCompany(db, clock, s.actor, { companyId: company.id, kind: "excluded" });
    expect(excluded.ok === false && excluded.error).toBe("forbidden");
    expect((await companyRow(company.id)).suppression).toBe("none");
  });

  it("抑止の解除は運営だけが行え、解除後は確保できる", async () => {
    const { company, s, assignment } = await claimed();
    const ops = await createOpsUser(db);
    await recordActivity(db, clock, s.actor, {
      assignmentId: assignment.id,
      kind: "declined",
      decline: { kind: "not_now" },
    });
    const bySales = await liftSuppression(db, clock, s.actor, { companyId: company.id, reason: "x" });
    expect(bySales.ok === false && bySales.error).toBe("forbidden");
    expect((await companyRow(company.id)).suppression).toBe("not_now");

    const byOps = await liftSuppression(db, clock, ops.actor, {
      companyId: company.id,
      reason: "先方から再連絡の依頼",
    });
    expect(byOps.ok && byOps.value.suppression).toBe("none");
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "company.lift_suppression"));
    expect(events).toHaveLength(1);
    expect((await claimAssignment(db, clock, s.actor, company.id)).ok).toBe(true);
  });
});
