import { randomBytes, randomUUID } from "node:crypto";
import {
  appSettings,
  assignments,
  auditEvents,
  companies,
  type Db,
  proposalVersions,
  shareLinks,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Actor } from "../common/actor.ts";
import { fixedClock } from "../common/clock.ts";
import { issueShareLink, listShareLinks, recoverShareLink, revokeShareLink, verifyShareLink } from "./share-link.ts";
import { seedAssignment, seedCompany, seedProposalVersion, seedUser } from "./test-helpers.ts";
import { createShareTokenRecovery } from "./token.ts";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-16T00:00:00Z");
const secret = randomBytes(32).toString("base64url"),
  recovery = createShareTokenRecovery(secret);
let actor: Extract<Actor, { kind: "sales" }>,
  other: Actor,
  ops: Actor,
  companyId: string,
  targetId: string,
  assignmentId: string;
const input = () => ({ purpose: "proposal" as const, targetId, requestKey: randomUUID() });
function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw Error(r.error);
  return r.value;
}
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  clock.set("2026-10-16T00:00:00Z");
  actor = (await seedUser(db, "sales")).actor as typeof actor;
  other = (await seedUser(db, "sales")).actor;
  ops = (await seedUser(db, "ops")).actor;
  companyId = (await seedCompany(db)).id;
  assignmentId = (await seedAssignment(db, companyId, actor.userId)).id;
  targetId = (await seedProposalVersion(db, companyId, { artifactDir: "/fixture/share" })).id;
});
afterEach(async () => {
  await close();
});
it("同時再送でも1件だけ発行し、同じURL・期限を返す。本文・鍵・受付キーはDBへ出さない", async () => {
  const request = input();
  const results = await Promise.all(
    Array.from({ length: 3 }, () => issueShareLink(db, clock, actor, request, recovery)),
  );
  const first = must(results[0]!);
  for (const r of results) expect(must(r)).toMatchObject({ link: first.link, token: first.token });
  expect(results.filter((r) => r.ok && r.value.created)).toHaveLength(1);
  expect(await db.select().from(shareLinks)).toHaveLength(1);
  expect(await db.select().from(auditEvents)).toHaveLength(1);
  const stored = JSON.stringify([
    await db.select().from(shareLinks),
    await db.select().from(auditEvents),
    await listShareLinks(db, actor, request),
  ]);
  for (const hidden of [secret, first.token, request.requestKey]) expect(stored).not.toContain(hidden);
  expect(must(await verifyShareLink(db, clock, first.token)).targetId).toBe(targetId);
});
it("再起動相当の新しい鍵オブジェクトでも本人が同じリンクを復旧し、既定期間の変更で延長しない", async () => {
  const request = input(),
    first = must(await issueShareLink(db, clock, actor, request, recovery));
  clock.set("2026-10-17T00:00:00Z");
  await db.insert(appSettings).values({ key: "shareLink.defaultTtlHours", value: 48 });
  expect(must(await issueShareLink(db, clock, actor, request, createShareTokenRecovery(secret)))).toEqual({
    ...first,
    created: false,
  });
  expect(must(await recoverShareLink(db, clock, actor, first.link.id, createShareTokenRecovery(secret)))).toEqual({
    link: first.link,
    token: first.token,
  });
  expect(await db.select().from(auditEvents)).toHaveLength(1);
});
it("同じ受付キーの別内容を拒否し、別の意図的発行は別リンクになる", async () => {
  const request = input();
  const first = must(await issueShareLink(db, clock, actor, request, recovery));
  expect(await issueShareLink(db, clock, actor, { ...request, ttlHours: 24 }, recovery)).toMatchObject({
    ok: false,
    error: "request_conflict",
  });
  const target2 = (await seedProposalVersion(db, companyId, { artifactDir: "/fixture/two" })).id;
  expect(await issueShareLink(db, clock, actor, { ...request, targetId: target2 }, recovery)).toMatchObject({
    ok: false,
    error: "request_conflict",
  });
  const second = must(await issueShareLink(db, clock, actor, input(), recovery));
  expect(second.token).not.toBe(first.token);
  expect(await db.select().from(shareLinks)).toHaveLength(2);
});
it("失効・期限切れの再送や再表示では復活させない", async () => {
  const request = input(),
    first = must(await issueShareLink(db, clock, actor, request, recovery));
  must(await revokeShareLink(db, clock, actor, first.link.id));
  expect(await issueShareLink(db, clock, actor, request, recovery)).toMatchObject({
    ok: false,
    error: "link_unavailable",
  });
  expect(await recoverShareLink(db, clock, actor, first.link.id, recovery)).toMatchObject({
    ok: false,
    error: "link_unavailable",
  });
  const request2 = input(),
    second = must(await issueShareLink(db, clock, actor, request2, recovery));
  clock.set(second.link.expiresAt);
  expect(await issueShareLink(db, clock, actor, request2, recovery)).toMatchObject({
    ok: false,
    error: "link_unavailable",
  });
  expect(await recoverShareLink(db, clock, actor, second.link.id, recovery)).toMatchObject({
    ok: false,
    error: "link_unavailable",
  });
  expect(await db.select().from(shareLinks)).toHaveLength(2);
});
it("他者・運営でも発行者でなければ秘密URLを再表示できない", async () => {
  const first = must(await issueShareLink(db, clock, actor, input(), recovery));
  for (const person of [other, ops, null, { kind: "ops" as const, userId: actor.userId }])
    expect(await recoverShareLink(db, clock, person, first.link.id, recovery)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
});
it("担当の解除後は元の発行者でも再表示・同一発行の再送を拒否する", async () => {
  const request = input(),
    first = must(await issueShareLink(db, clock, actor, request, recovery));
  await db.update(assignments).set({ status: "released" }).where(eq(assignments.id, assignmentId));
  expect(await recoverShareLink(db, clock, actor, first.link.id, recovery)).toMatchObject({
    ok: false,
    error: "forbidden",
  });
  expect(await issueShareLink(db, clock, actor, request, recovery)).toMatchObject({ ok: false, error: "forbidden" });
});
it("承認取消・営業抑止・成果物不足を現在のDBで再検査する", async () => {
  const request = input(),
    first = must(await issueShareLink(db, clock, actor, request, recovery));
  for (const [patch, error] of [
    [{ status: "in_review" }, "target_not_approved"],
    [{ status: "approved", demoArtifactDir: null }, "target_no_artifact"],
  ] as const) {
    await db.update(proposalVersions).set(patch).where(eq(proposalVersions.id, targetId));
    expect(await recoverShareLink(db, clock, actor, first.link.id, recovery)).toMatchObject({ ok: false, error });
    expect(await issueShareLink(db, clock, actor, request, recovery)).toMatchObject({ ok: false, error });
  }
  await db.update(proposalVersions).set({ demoArtifactDir: "/fixture/share" }).where(eq(proposalVersions.id, targetId));
  await db.update(companies).set({ suppression: "do_not_contact" }).where(eq(companies.id, companyId));
  expect(await recoverShareLink(db, clock, actor, first.link.id, recovery)).toMatchObject({
    ok: false,
    error: "company_suppressed",
  });
  expect(await issueShareLink(db, clock, actor, request, recovery)).toMatchObject({
    ok: false,
    error: "company_suppressed",
  });
});
it("利用停止した本人の発行・再表示・一覧・取り消しを拒否する", async () => {
  const request = input(),
    first = must(await issueShareLink(db, clock, actor, request, recovery));
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, actor.userId));
  for (const r of [
    await issueShareLink(db, clock, actor, request, recovery),
    await recoverShareLink(db, clock, actor, first.link.id, recovery),
    await revokeShareLink(db, clock, actor, first.link.id),
    await listShareLinks(db, actor, request),
  ])
    expect(r).toMatchObject({ ok: false, error: "forbidden" });
});
it("鍵の変更・欠落・ハッシュ破損で新しいリンクを増やさず、旧式は再表示不可を示す", async () => {
  const request = input(),
    first = must(await issueShareLink(db, clock, actor, request, recovery));
  const wrong = createShareTokenRecovery(randomBytes(32).toString("base64url"));
  for (const key of [undefined, wrong]) {
    expect(await recoverShareLink(db, clock, actor, first.link.id, key)).toMatchObject({
      ok: false,
      error: "recovery_unavailable",
    });
    expect(await issueShareLink(db, clock, actor, request, key)).toMatchObject({
      ok: false,
      error: "recovery_unavailable",
    });
  }
  expect((await verifyShareLink(db, clock, first.token)).ok).toBe(true);
  await db.update(shareLinks).set({ tokenHash: "invalid" }).where(eq(shareLinks.id, first.link.id));
  expect(await recoverShareLink(db, clock, actor, first.link.id, recovery)).toMatchObject({
    ok: false,
    error: "recovery_unavailable",
  });
  const legacy = must(await issueShareLink(db, clock, actor, { purpose: "proposal", targetId }));
  expect(legacy.link.recoverable).toBe(false);
  expect(await recoverShareLink(db, clock, actor, legacy.link.id, recovery)).toMatchObject({
    ok: false,
    error: "recovery_unavailable",
  });
  expect(await db.select().from(shareLinks)).toHaveLength(2);
});
it("記録の途中で失敗しても受付済みにはならず、同じキーで再試行できる", async () => {
  const request = input();
  await db.execute(
    sql`create function fail_issue_audit() returns trigger language plpgsql as $$ begin raise exception 'fixture'; end $$`,
  );
  await db.execute(
    sql`create trigger fail_issue before insert on audit_events for each row execute function fail_issue_audit()`,
  );
  await expect(issueShareLink(db, clock, actor, request, recovery)).rejects.toThrow();
  expect(await db.select().from(shareLinks)).toHaveLength(0);
  await db.execute(sql`drop trigger fail_issue on audit_events`);
  must(await issueShareLink(db, clock, actor, request, recovery));
  expect(await db.select().from(shareLinks)).toHaveLength(1);
});
it("壊れた入力と復旧鍵は拒否し、受付情報のない発行へ暗黙に切り替えない", async () => {
  for (const key of ["", "short", "a".repeat(44), "z".repeat(43)])
    expect(() => createShareTokenRecovery(key)).toThrow();
  expect(await issueShareLink(db, clock, actor, { ...input(), requestKey: "invalid" }, recovery)).toMatchObject({
    ok: false,
    error: "invalid_request",
  });
  expect(await issueShareLink(db, clock, actor, input())).toMatchObject({ ok: false, error: "recovery_unavailable" });
  for (const ttlHours of [NaN, Infinity, -1, 0, 1e100])
    expect((await issueShareLink(db, clock, actor, { ...input(), ttlHours }, recovery)).ok).toBe(false);
  expect(await db.select().from(shareLinks)).toHaveLength(0);
});
