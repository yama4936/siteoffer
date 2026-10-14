// 営業の「提案を共有」の結合テスト（PGlite）。権限・承認状態・営業抑止・取り消し（11章・AC-14・AC-17）
import { type Actor, fixedClock, hashShareToken, verifyShareLink } from "@siteoffer/core";
import { seedAssignment, seedCompany, seedProposalVersion, seedUser } from "@siteoffer/core/share-link/testing";
import { companies, type Db, shareLinks } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueProposalShare, listProposalShares, revokeProposalShare, type ShareDeps } from "./share.ts";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-14T00:00:00Z");
let salesA: Actor;
let salesB: Actor;
let companyA: string;
let versionA: string;
let versionB: string;

const ORIGIN = "http://preview.example.test:3200";

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const deps = (actor: Actor | null): ShareDeps => ({ db, clock, actor });

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock.set("2026-10-14T00:00:00Z");
  const a = await seedUser(db, "sales");
  const b = await seedUser(db, "sales");
  salesA = a.actor;
  salesB = b.actor;
  companyA = (await seedCompany(db)).id;
  const companyB = (await seedCompany(db)).id;
  await seedAssignment(db, companyA, a.user.id);
  await seedAssignment(db, companyB, b.user.id);
  versionA = (await seedProposalVersion(db, companyA, { artifactDir: "/artifacts/a" })).id;
  versionB = (await seedProposalVersion(db, companyB, { artifactDir: "/artifacts/b" })).id;
}, 30_000);

afterEach(async () => {
  await close();
});

describe("提案の共有リンクの発行", () => {
  it("担当中の営業は承認済みの版のリンクを発行でき、プレビューのURLを一度だけ受け取る", async () => {
    const r = await issueProposalShare(deps(salesA), form({ proposalVersionId: versionA }), ORIGIN);
    expect(r?.status).toBe("ok");
    const url = r!.shareUrl!;
    expect(url).toMatch(/^http:\/\/preview\.example\.test:3200\/s\/[A-Za-z0-9_-]{43}\/$/);
    const token = url.split("/s/")[1]!.replace(/\/$/, "");
    // DBにはハッシュだけ。URLのトークンで検証が通る
    const [row] = await db.select().from(shareLinks);
    expect(row!.tokenHash).toBe(hashShareToken(token));
    expect((await verifyShareLink(db, clock, token)).ok).toBe(true);
    // 一覧にはURL（トークン）を含めない
    const list = await listProposalShares(deps(salesA), versionA);
    expect(list.ok && list.value.map((l) => l.state)).toEqual(["active"]);
    expect(JSON.stringify(list)).not.toContain(token);
  });

  it("営業は他人の担当企業のリンクを発行できない（AC-17）", async () => {
    const r = await issueProposalShare(deps(salesA), form({ proposalVersionId: versionB }), ORIGIN);
    expect(r).toMatchObject({ status: "error" });
    expect(r!.message).toContain("自分が担当中の企業");
    expect(r!.shareUrl).toBeUndefined();
    expect(await db.select().from(shareLinks)).toHaveLength(0);
    expect((await listProposalShares(deps(salesA), versionB)).ok).toBe(false);
  });

  it("承認前の版・デモのない版・営業拒否中の企業・未ログインはそれぞれの文言で断る", async () => {
    const inReview = (await seedProposalVersion(db, companyA, { status: "in_review", artifactDir: "/x" })).id;
    expect((await issueProposalShare(deps(salesA), form({ proposalVersionId: inReview }), ORIGIN))?.message).toContain(
      "承認が済んでいない",
    );
    const noDemo = (await seedProposalVersion(db, companyA, { artifactDir: null })).id;
    expect((await issueProposalShare(deps(salesA), form({ proposalVersionId: noDemo }), ORIGIN))?.message).toContain(
      "改善デモがまだない",
    );
    expect((await issueProposalShare(deps(null), form({ proposalVersionId: versionA }), ORIGIN))?.message).toBe(
      "ログインしてください。",
    );
    await db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, companyA));
    expect((await issueProposalShare(deps(salesA), form({ proposalVersionId: versionA }), ORIGIN))?.message).toContain(
      "営業拒否",
    );
    expect(await db.select().from(shareLinks)).toHaveLength(0);
  });

  it("有効期間：既定より長い指定は断り、短い指定は受け付ける。形式違いも断る", async () => {
    const long = await issueProposalShare(
      deps(salesA),
      form({ proposalVersionId: versionA, ttlHours: "100000" }),
      ORIGIN,
    );
    expect(long?.status).toBe("error");
    const tooLong = await issueProposalShare(
      deps(salesA),
      form({ proposalVersionId: versionA, ttlHours: "9999" }),
      ORIGIN,
    );
    expect(tooLong?.message).toContain("有効期間を確認してください");
    const bad = await issueProposalShare(deps(salesA), form({ proposalVersionId: versionA, ttlHours: "-1" }), ORIGIN);
    expect(bad?.status).toBe("error");
    const short = await issueProposalShare(deps(salesA), form({ proposalVersionId: versionA, ttlHours: "24" }), ORIGIN);
    expect(short?.status).toBe("ok");
    expect(new Date(short!.shareExpiresAt!).getTime() - clock.now().getTime()).toBe(24 * 3600 * 1000);
  });
});

describe("提案の共有リンクの取り消し", () => {
  it("発行者は取り消せ、他の営業は取り消せない。取り消し後は検証が通らない", async () => {
    const r = await issueProposalShare(deps(salesA), form({ proposalVersionId: versionA }), ORIGIN);
    const token = r!.shareUrl!.split("/s/")[1]!.replace(/\/$/, "");
    const [link] = await db.select().from(shareLinks);
    const byOther = await revokeProposalShare(deps(salesB), form({ linkId: link!.id }));
    expect(byOther?.status).toBe("error");
    expect((await verifyShareLink(db, clock, token)).ok).toBe(true);
    expect((await revokeProposalShare(deps(salesA), form({ linkId: link!.id })))?.status).toBe("ok");
    expect((await verifyShareLink(db, clock, token)).ok).toBe(false);
    expect((await revokeProposalShare(deps(salesA), form({ linkId: link!.id })))?.message).toContain(
      "すでに取り消されています",
    );
    const list = await listProposalShares(deps(salesA), versionA);
    expect(list.ok && list.value.map((l) => l.state)).toEqual(["revoked"]);
  });

  it("期限切れのリンクは一覧で期限切れと表示する", async () => {
    await issueProposalShare(deps(salesA), form({ proposalVersionId: versionA, ttlHours: "1" }), ORIGIN);
    clock.advance(2 * 3600 * 1000);
    const list = await listProposalShares(deps(salesA), versionA);
    expect(list.ok && list.value.map((l) => l.state)).toEqual(["expired"]);
  });
});
