import { randomUUID } from "node:crypto";
import { type Actor, fixedClock } from "@siteoffer/core";
import { auditEvents, type Db, productTerms, users } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createProductTermsVersion } from "./commands";
import { EMPTY_PRODUCT_TERMS_DRAFT, inspectProductTermsDraft } from "./product-terms-draft";
import { saveProductTermsDraft } from "./save-product-terms-draft";
import { seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
const clock = fixedClock("2026-10-19T00:00:00Z");
const draft = {
  ...EMPTY_PRODUCT_TERMS_DRAFT,
  version: "fixture-v1",
  name: "架空条件（試験専用）",
  scope: "トップ・会社案内",
  price: "300,001",
  monthlyFee: "5,000",
  rewardType: "rate",
  rewardValue: "12.5",
};
const form = (values = draft) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) fd.set(key, value);
  return fd;
};
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
const save = (actor: Actor | null, fd = form()) => saveProductTermsDraft({ db, clock }, actor, fd, randomUUID());

it("プレビューと同じ値を新しい版に保存し、履歴を同じトランザクションで1件だけ記録する", async () => {
  const { actor } = await seedUser(db, "ops");
  const result = await save(actor);
  expect(result).toMatchObject({ status: "saved", saved: { version: draft.version }, errors: {} });
  const rows = await db.select().from(productTerms),
    events = await db.select().from(auditEvents);
  expect(rows).toHaveLength(1);
  expect(events).toHaveLength(1);
  const preview = inspectProductTermsDraft(draft);
  expect(rows[0]).toMatchObject({
    price: preview.price,
    monthlyFee: preview.monthlyFee,
    rewardRule: preview.rewardRule,
    scope: { description: draft.scope },
    active: true,
  });
  expect(events[0]).toMatchObject({ actorId: actor.userId, action: "product_terms.create", targetId: rows[0]!.id });
  expect(events[0]!.after).toMatchObject({ price: preview.price, rewardRule: preview.rewardRule });
});

it("同じ版の再送は既存の内容と履歴を変えず、版名のエラーを返す", async () => {
  const { actor } = await seedUser(db, "ops");
  expect((await save(actor)).status).toBe("saved");
  const before = await db.select().from(productTerms),
    events = await db.select().from(auditEvents);
  const result = await save(actor, form({ ...draft, price: "1", name: "変更してはいけない" }));
  expect(result).toMatchObject({ status: "error", errors: { version: expect.any(String) } });
  expect(await db.select().from(productTerms)).toEqual(before);
  expect(await db.select().from(auditEvents)).toEqual(events);
});

it("未設定と0円を区別して保存でき、割合の値が空のときは保存しない", async () => {
  const { actor } = await seedUser(db, "ops");
  expect((await save(actor, form({ ...EMPTY_PRODUCT_TERMS_DRAFT, version: "unset", name: "未設定" }))).status).toBe(
    "saved",
  );
  expect(
    (
      await save(
        actor,
        form({ ...draft, version: "zero", price: "0", monthlyFee: "0", rewardType: "fixed", rewardValue: "0" }),
      )
    ).status,
  ).toBe("saved");
  expect(await save(actor, form({ ...draft, version: "invalid", rewardValue: "" }))).toMatchObject({
    status: "error",
    errors: { rewardValue: expect.any(String) },
  });
  const rows = await db.select().from(productTerms);
  expect(rows.find((row) => row.version === "unset")).toMatchObject({
    price: null,
    monthlyFee: null,
    rewardRule: null,
  });
  expect(rows.find((row) => row.version === "zero")).toMatchObject({
    price: 0,
    monthlyFee: 0,
    rewardRule: { type: "fixed", amount: 0 },
  });
  expect(rows).toHaveLength(2);
  expect(await db.select().from(auditEvents)).toHaveLength(2);
});

it("運営以外はDBへ触れず、有効でない運営や偽装した役割でも保存できない", async () => {
  const { actor: ops, user } = await seedUser(db, "ops"),
    { actor: sales } = await seedUser(db, "sales");
  const forbiddenDb = new Proxy({} as Db, {
    get() {
      throw new Error("DB touched");
    },
  });
  for (const actor of [
    null,
    sales,
    { kind: "system", job: "fixture" },
    { kind: "customer", shareLinkId: "fixture" },
  ] as (Actor | null)[])
    expect((await saveProductTermsDraft({ db: forbiddenDb, clock }, actor, form(), "test")).status).toBe("error");
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
  for (const actor of [
    ops,
    { kind: "ops", userId: sales.userId },
    { kind: "ops", userId: randomUUID() },
    { kind: "ops", userId: "bad" },
  ] as Actor[])
    expect(await save(actor)).toMatchObject({ status: "error", saved: null });
  expect(await db.select().from(productTerms)).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});

it("不正な直接送信とDBの金額上限超過を、書き込む前に拒否する", async () => {
  const { actor } = await seedUser(db, "ops");
  const fd = form();
  fd.append("rewardValue", "100");
  expect((await save(actor, fd)).status).toBe("error");
  for (const patch of [{ price: "2147483648" }, { rewardValue: "12.501" }, { rewardType: "bad" }])
    expect((await save(actor, form({ ...draft, ...patch }))).status).toBe("error");
  const input = inspectProductTermsDraft(draft).input!;
  for (const patch of [
    { price: 2147483648 },
    { monthlyFee: 2147483648 },
    { rewardRule: { type: "fixed", amount: 2147483648 } },
  ])
    expect(await createProductTermsVersion({ db, clock }, actor, { ...input, ...patch })).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  expect(await db.select().from(productTerms)).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
});

it("監査履歴の失敗時は版も巻き戻し、例外の内容を利用者へ出さない", async () => {
  const { actor } = await seedUser(db, "ops");
  await db.execute(
    sql`create function reject_terms_event() returns trigger language plpgsql as $$ begin raise exception 'fixture-private-database-detail'; end $$`,
  );
  await db.execute(
    sql`create trigger reject_terms_event before insert on audit_events for each row execute function reject_terms_event()`,
  );
  const result = await save(actor);
  expect(result.status).toBe("error");
  expect(JSON.stringify(result)).not.toContain("fixture-private-database-detail");
  expect(await db.select().from(productTerms)).toHaveLength(0);
  expect(await db.select().from(auditEvents)).toHaveLength(0);
  await db.execute(sql`drop trigger reject_terms_event on audit_events`);
  expect((await save(actor)).status).toBe("saved");
});
