import { appSettings, assignments, auditEvents, companies, type Db, proposalVersions, shareLinks } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../common/actor.ts";
import { fixedClock, HOUR } from "../common/clock.ts";
import { issueShareLink, listShareLinks, revokeShareLink, verifyShareLink } from "./share-link.ts";
import { seedAssignment, seedCompany, seedDeliveryVersion, seedProposalVersion, seedUser } from "./test-helpers.ts";
import { hashShareToken, isShareTokenFormat, shareLinkUrl } from "./token.ts";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-14T00:00:00Z");

let salesA: Actor;
let salesB: Actor;
let ops: Actor;
let companyA: string; // A が担当中
let companyB: string; // B が担当中
let versionA: string; // companyA の承認済み提案版
let versionB: string; // companyB の承認済み提案版

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock.set("2026-10-14T00:00:00Z");
  const a = await seedUser(db, "sales");
  const b = await seedUser(db, "sales");
  salesA = a.actor;
  salesB = b.actor;
  ops = (await seedUser(db, "ops")).actor;
  companyA = (await seedCompany(db)).id;
  companyB = (await seedCompany(db)).id;
  await seedAssignment(db, companyA, a.user.id);
  await seedAssignment(db, companyB, b.user.id);
  versionA = (await seedProposalVersion(db, companyA, { artifactDir: "/artifacts/a" })).id;
  versionB = (await seedProposalVersion(db, companyB, { artifactDir: "/artifacts/b" })).id;
});

afterEach(async () => {
  await close();
});

describe("発行", () => {
  it("営業は自分の担当企業の承認済み提案版を共有できる。平文はハッシュだけ保存され、操作履歴が残る", async () => {
    const r = await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA });
    if (!r.ok) throw new Error(r.error);
    expect(isShareTokenFormat(r.value.token)).toBe(true);
    expect(r.value.link.companyId).toBe(companyA);
    // 既定の有効期間は運営設定 shareLink.defaultTtlHours（既定値 14日）
    expect(r.value.link.expiresAt.getTime() - clock.now().getTime()).toBe(24 * 14 * HOUR);

    const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, r.value.link.id));
    expect(row!.tokenHash).toBe(hashShareToken(r.value.token));
    expect(row!.tokenHash).not.toContain(r.value.token);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.targetId, r.value.link.id));
    expect(events.map((e) => e.action)).toEqual(["share_link.issue"]);
    expect(JSON.stringify(events[0])).not.toContain(r.value.token);
    expect(JSON.stringify(events[0])).not.toContain(row!.tokenHash);
  });

  it("トークンは毎回異なる", async () => {
    const r1 = await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA });
    const r2 = await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA });
    expect(r1.ok && r2.ok && r1.value.token !== r2.value.token).toBe(true);
  });

  it("営業は他人の担当企業のリンクを発行できない（AC-17）", async () => {
    const r = await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionB });
    expect(r).toMatchObject({ ok: false, error: "forbidden" });
    expect(await db.select().from(shareLinks)).toHaveLength(0);
  });

  it("担当のいない企業のリンクは営業には発行できず、運営はできる", async () => {
    const free = (await seedCompany(db)).id;
    const v = (await seedProposalVersion(db, free, { artifactDir: "/artifacts/free" })).id;
    expect(await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: v })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect((await issueShareLink(db, clock, ops, { purpose: "proposal", targetId: v })).ok).toBe(true);
  });

  it("承認前・差し戻しの版、成果物のない版は共有できない（運営でも）", async () => {
    for (const status of ["generating", "in_review", "rejected", "failed"] as const) {
      const v = (await seedProposalVersion(db, companyA, { status, artifactDir: "/artifacts/x" })).id;
      expect(await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: v })).toMatchObject({
        ok: false,
        error: "target_not_approved",
      });
      expect(await issueShareLink(db, clock, ops, { purpose: "proposal", targetId: v })).toMatchObject({
        ok: false,
        error: "target_not_approved",
      });
    }
    const noDir = (await seedProposalVersion(db, companyA, { artifactDir: null })).id;
    expect(await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: noDir })).toMatchObject({
      ok: false,
      error: "target_no_artifact",
    });
  });

  it("存在しない版・UUIDでない値は target_not_found", async () => {
    for (const targetId of ["00000000-0000-4000-8000-000000000000", "../../etc", ""]) {
      expect(await issueShareLink(db, clock, ops, { purpose: "proposal", targetId })).toMatchObject({
        ok: false,
        error: "target_not_found",
      });
    }
  });

  it("営業拒否中の企業には提案を共有できない", async () => {
    await db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, companyA));
    expect(await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA })).toMatchObject({
      ok: false,
      error: "company_suppressed",
    });
  });

  it("未ログイン・顧客・system は発行できない", async () => {
    const customer: Actor = { kind: "customer", shareLinkId: "x" };
    const system: Actor = { kind: "system", job: "t" };
    for (const a of [null, customer, system]) {
      expect(await issueShareLink(db, clock, a, { purpose: "proposal", targetId: versionA })).toMatchObject({
        ok: false,
        error: "forbidden",
      });
    }
  });

  it("有効期間：運営設定の既定値を使う。営業は既定より長くできない。0以下は不可", async () => {
    await db.insert(appSettings).values({ key: "shareLink.defaultTtlHours", value: 48 });
    const r = await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA });
    expect(r.ok && r.value.link.expiresAt.getTime() - clock.now().getTime()).toBe(48 * HOUR);
    const short = await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA, ttlHours: 2 });
    expect(short.ok && short.value.link.expiresAt.getTime() - clock.now().getTime()).toBe(2 * HOUR);
    expect(
      await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA, ttlHours: 49 }),
    ).toMatchObject({ ok: false, error: "invalid_ttl" });
    expect(
      await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA, ttlHours: 0 }),
    ).toMatchObject({ ok: false, error: "invalid_ttl" });
    expect((await issueShareLink(db, clock, ops, { purpose: "proposal", targetId: versionA, ttlHours: 500 })).ok).toBe(
      true,
    );
  });

  it("納品の版のリンクは運営だけが発行できる", async () => {
    const [assignment] = await db.select().from(assignments).where(eq(assignments.companyId, companyA));
    const dv = await seedDeliveryVersion(db, companyA, assignment!.id, (salesA as { userId: string }).userId, "/d/1");
    expect(await issueShareLink(db, clock, salesA, { purpose: "delivery", targetId: dv.id })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    const r = await issueShareLink(db, clock, ops, { purpose: "delivery", targetId: dv.id });
    expect(r.ok && r.value.link.companyId).toBe(companyA);
  });
});

describe("検証（AC-14）", () => {
  async function issue(actor: Actor = salesA, targetId = versionA) {
    const r = await issueShareLink(db, clock, actor, { purpose: "proposal", targetId });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }

  it("有効なトークンは対象の成果物ディレクトリを返す", async () => {
    const { token, link } = await issue();
    const v = await verifyShareLink(db, clock, token);
    expect(v).toMatchObject({
      ok: true,
      value: { linkId: link.id, companyId: companyA, targetId: versionA, artifactDir: "/artifacts/a" },
    });
    expect(v.ok && v.value.actor).toEqual({ kind: "customer", shareLinkId: link.id });
  });

  it("期限切れのトークンは not_found（期限ちょうどで見られなくなる）", async () => {
    const { token, link } = await issue();
    clock.set(new Date(link.expiresAt.getTime() - 1));
    expect((await verifyShareLink(db, clock, token)).ok).toBe(true);
    clock.set(link.expiresAt);
    expect(await verifyShareLink(db, clock, token)).toEqual({ ok: false, error: "not_found", message: "expired" });
  });

  it("取り消し後は not_found", async () => {
    const { token, link } = await issue();
    expect((await revokeShareLink(db, clock, salesA, link.id)).ok).toBe(true);
    expect(await verifyShareLink(db, clock, token)).toEqual({ ok: false, error: "not_found", message: "revoked" });
  });

  it("不明・不正な形式のトークンは not_found", async () => {
    await issue();
    expect(await verifyShareLink(db, clock, "a".repeat(43))).toMatchObject({ ok: false, message: "unknown" });
    for (const t of ["", "short", "../../etc/passwd", `${"a".repeat(43)}/`]) {
      expect(await verifyShareLink(db, clock, t)).toMatchObject({ ok: false, error: "not_found" });
    }
  });

  it("用途・対象の版の指定と一致しないリンクは拒否する", async () => {
    const { token } = await issue();
    expect(await verifyShareLink(db, clock, token, { targetId: versionB })).toMatchObject({
      ok: false,
      message: "target_mismatch",
    });
    expect(await verifyShareLink(db, clock, token, { purpose: "delivery" })).toMatchObject({
      ok: false,
      message: "target_mismatch",
    });
    expect((await verifyShareLink(db, clock, token, { purpose: "proposal", targetId: versionA })).ok).toBe(true);
  });

  it("発行後に版が承認取り消し（rejected）になったら見られない", async () => {
    const { token } = await issue();
    await db.update(proposalVersions).set({ status: "rejected" }).where(eq(proposalVersions.id, versionA));
    expect(await verifyShareLink(db, clock, token)).toMatchObject({ ok: false, message: "target_not_approved" });
  });

  it("リンクの企業と対象の企業が食い違う行（DBの改ざん等）は拒否する", async () => {
    const { token, link } = await issue();
    await db.update(shareLinks).set({ companyId: companyB }).where(eq(shareLinks.id, link.id));
    expect(await verifyShareLink(db, clock, token)).toMatchObject({ ok: false, message: "target_mismatch" });
  });
});

describe("取り消し", () => {
  it("発行者と運営は取り消せる。他の営業は取り消せない。二重の取り消しは already_revoked", async () => {
    const r1 = await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA });
    const r2 = await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA });
    if (!r1.ok || !r2.ok) throw new Error("issue failed");

    expect(await revokeShareLink(db, clock, salesB, r1.value.link.id)).toMatchObject({ ok: false, error: "forbidden" });
    expect((await verifyShareLink(db, clock, r1.value.token)).ok).toBe(true);

    clock.advance(HOUR);
    const rev = await revokeShareLink(db, clock, salesA, r1.value.link.id);
    expect(rev.ok && rev.value.revokedAt?.toISOString()).toBe(clock.now().toISOString());
    expect(await revokeShareLink(db, clock, salesA, r1.value.link.id)).toMatchObject({
      ok: false,
      error: "already_revoked",
    });
    expect((await revokeShareLink(db, clock, ops, r2.value.link.id)).ok).toBe(true);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "share_link.revoke"));
    expect(events.map((e) => e.actorKind).sort()).toEqual(["ops", "sales"]);
  });

  it("存在しないリンク・UUIDでない値は not_found", async () => {
    expect(await revokeShareLink(db, clock, ops, "00000000-0000-4000-8000-000000000000")).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await revokeShareLink(db, clock, ops, "x")).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("一覧", () => {
  it("営業は自分の担当企業の版について自分が発行したものだけ、運営はすべて見える", async () => {
    await issueShareLink(db, clock, salesA, { purpose: "proposal", targetId: versionA });
    await issueShareLink(db, clock, ops, { purpose: "proposal", targetId: versionA });
    const mine = await listShareLinks(db, salesA, { purpose: "proposal", targetId: versionA });
    expect(mine.ok && mine.value.length).toBe(1);
    expect(mine.ok && JSON.stringify(mine.value)).not.toContain("tokenHash");
    const all = await listShareLinks(db, ops, { purpose: "proposal", targetId: versionA });
    expect(all.ok && all.value.length).toBe(2);
    expect(await listShareLinks(db, salesB, { purpose: "proposal", targetId: versionA })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });
});

describe("URL", () => {
  it("末尾に / を付けたプレビューのURLを作る", () => {
    expect(shareLinkUrl("http://localhost:3200/", "t".repeat(43))).toBe(`http://localhost:3200/s/${"t".repeat(43)}/`);
  });
});
