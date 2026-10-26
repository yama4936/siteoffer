import { companies, companyProfiles, type Db } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../db", () => ({ getDb: vi.fn() }));
vi.mock("../session", () => ({ getCurrentActor: vi.fn() }));

import { companyProfileAction } from "../../app/(ops)/ops/companies/[companyId]/profile-actions";
import { getDb } from "../db";
import { getCurrentActor } from "../session";
import { seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
const initial = { nonce: "", ok: false, message: "", revision: null, refreshRequired: false };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  vi.mocked(getDb).mockReturnValue(db);
});
afterEach(async () => {
  await close();
  vi.resetAllMocks();
});
async function setup() {
  const { actor } = await seedUser(db, "ops");
  vi.mocked(getCurrentActor).mockResolvedValue(actor);
  const [company] = await db.insert(companies).values({ name: "架空の会社情報受付" }).returning();
  const form = new FormData();
  for (const [key, value] of Object.entries({
    companyId: company!.id,
    revision: "0",
    email: "contact@example.test",
    source: "架空の確認資料",
  }))
    form.set(key, value);
  return { form, actor };
}
it("明示確認を必要とし、実DBへ保存し、同じ内容は版を保持し、競合は更新案内を返す", async () => {
  const s = await setup();
  expect((await companyProfileAction(initial, s.form)).ok).toBe(false);
  expect(await db.select().from(companyProfiles)).toHaveLength(0);
  s.form.set("confirmed", "on");
  const saved = await companyProfileAction(initial, s.form);
  expect(saved).toMatchObject({ ok: true, revision: 1, refreshRequired: false });
  expect((await db.select().from(companyProfiles))[0]!.values).toMatchObject({
    email: "contact@example.test",
    phone: null,
  });
  s.form.set("revision", "1");
  expect(await companyProfileAction(initial, s.form)).toMatchObject({ ok: true, revision: 1 });
  s.form.set("revision", "0");
  s.form.set("email", "changed@example.test");
  expect(await companyProfileAction(initial, s.form)).toMatchObject({ ok: false, refreshRequired: true });
  expect((await db.select().from(companyProfiles))[0]!.values).toMatchObject({ email: "contact@example.test" });
});
it("認証のない保存を拒否し、内部の例外を画面へ出さない", async () => {
  const s = await setup();
  s.form.set("confirmed", "on");
  vi.mocked(getCurrentActor).mockResolvedValue(null);
  expect((await companyProfileAction(initial, s.form)).ok).toBe(false);
  expect(await db.select().from(companyProfiles)).toHaveLength(0);
  vi.mocked(getDb).mockImplementation(() => {
    throw new Error("PRIVATE_DATABASE_CONNECTION");
  });
  const failed = await companyProfileAction(initial, s.form);
  expect(failed.ok).toBe(false);
  expect(failed.message).not.toContain("PRIVATE_DATABASE_CONNECTION");
});
