import { assignments, auditEvents, type Db, domainPreferences } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../common/clock.ts";
import { seedBase } from "../contract/test-seed.ts";
import {
  confirmDomainPreference,
  EXISTING_DOMAIN_REVIEW_NOTICE,
  NEW_DOMAIN_AVAILABILITY_NOTICE,
  saveDomainPreference,
} from "./domain-preference.ts";
import { detectSecretLike } from "./secrets.ts";

let db: Db;
let close: () => Promise<void>;
const clock = fixedClock("2026-10-14T00:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

describe("秘密らしき値の検出", () => {
  it.each([
    ["AWSアクセスキー風", "キーは AKIAABCDEFGHIJKLMNOP です"], // git-check: allow-dummy-secret（検出テスト用のダミー値）
    ["AWSシークレット風", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["aws_secret_access_key", "aws_secret_access_key をもらった"],
    ["秘密鍵", "-----BEGIN RSA PRIVATE KEY-----"], // git-check: allow-dummy-secret（検出テスト用のダミー値）
    ["パスワード（日本語）", "パスワード：hunter22"],
    ["パスワード（英語）", "password=abc12345"],
    ["移管コード（キーワード付き）", "移管コードは aB3kL9xQ2z"],
    ["AuthCode", "AuthCode: 9f8e7d6c5b"],
    ["移管コード風の単独文字列", "先方から Xy7#kP2q!Lm を預かった"],
    ["ランダムな長い英数字", "R4nD0mT0k3nV4lu3XyZ"],
  ])("%s を検出する", (_label, text) => {
    expect(detectSecretLike(text)).not.toBeNull();
  });

  it.each([
    "パスワードは制作会社が管理している",
    "メールは使っている。現在のドメインを続けたい",
    "https://www.example-koumuten.co.jp/company/",
    "info@example-koumuten.co.jp に連絡",
    "Tokyo-2024 年度中に公開したい",
    "ペッパーミント株式会社",
    "移管について相談したい",
    "",
  ])("通常の記述は検出しない：%s", (text) => {
    expect(detectSecretLike(text)).toBeNull();
  });
});

describe("ドメイン希望の記録（AC-13）", () => {
  it("13章の項目を記録でき、注意文を返す。操作履歴が残る", async () => {
    const base = await seedBase(db);
    const r = await saveDomainPreference(db, clock, base.salesActor, {
      companyId: base.company.id,
      assignmentId: base.assignment.id,
      currentUrl: "https://www.example-koumuten.jp/",
      currentDomain: "Example-Koumuten.JP",
      intent: "new",
      newDomainCandidates: ["koumuten-new.example", "KOUMUTEN-NEW.example", "https://second.example/"],
      currentManager: "vendor",
      usesEmail: "yes",
      customerWish: "新しいドメインにしたいが、メールは今のまま",
      needsOpsReview: false, // 営業は変更できない
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.preference).toMatchObject({
      currentDomain: "example-koumuten.jp",
      intent: "new",
      newDomainCandidates: ["koumuten-new.example", "second.example"],
      currentManager: "vendor",
      usesEmail: "yes",
      needsOpsReview: true,
      confirmedAt: null,
    });
    expect(r.value.notices).toContain(NEW_DOMAIN_AVAILABILITY_NOTICE);
    const events = await db.select().from(auditEvents);
    expect(events.map((e) => e.action)).toContain("domain_preference.create");
  });

  it("同じ担当で再度記録すると更新され、運営確認はやり直しになる", async () => {
    const base = await seedBase(db);
    const first = await saveDomainPreference(db, clock, base.salesActor, {
      companyId: base.company.id,
      assignmentId: base.assignment.id,
      intent: "undecided",
    });
    if (!first.ok) throw new Error(first.error);
    const conf = await confirmDomainPreference(db, clock, base.opsActor, { id: first.value.preference.id });
    expect(conf.ok && conf.value.confirmedAt).toBeTruthy();
    const second = await saveDomainPreference(db, clock, base.salesActor, {
      companyId: base.company.id,
      assignmentId: base.assignment.id,
      intent: "keep",
      currentDomain: "example-koumuten.jp",
    });
    if (!second.ok) throw new Error(second.error);
    expect(second.value.preference.id).toBe(first.value.preference.id);
    expect(second.value.preference.confirmedAt).toBeNull();
    expect(second.value.notices).toContain(EXISTING_DOMAIN_REVIEW_NOTICE);
    expect(await db.select().from(domainPreferences)).toHaveLength(1);
  });

  it("営業は確認できない。担当外の営業は記録できない。解除済みの担当では記録できない", async () => {
    const base = await seedBase(db);
    const r = await saveDomainPreference(db, clock, base.salesActor, {
      companyId: base.company.id,
      assignmentId: base.assignment.id,
      intent: "undecided",
    });
    if (!r.ok) throw new Error(r.error);
    expect(await confirmDomainPreference(db, clock, base.salesActor, { id: r.value.preference.id })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(
      await saveDomainPreference(db, clock, base.otherSalesActor, {
        companyId: base.company.id,
        assignmentId: base.assignment.id,
        intent: "new",
      }),
    ).toMatchObject({ ok: false, error: "forbidden" });
    await db.update(assignments).set({ status: "released" }).where(eq(assignments.id, base.assignment.id));
    expect(
      await saveDomainPreference(db, clock, base.salesActor, {
        companyId: base.company.id,
        assignmentId: base.assignment.id,
        intent: "new",
      }),
    ).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("運営は運営確認の要否を外せる。ただし既存ドメインを使う希望は常に要確認", async () => {
    const base = await seedBase(db);
    const a = await saveDomainPreference(db, clock, base.opsActor, {
      companyId: base.company.id,
      intent: "new",
      needsOpsReview: false,
    });
    const b = await saveDomainPreference(db, clock, base.opsActor, {
      companyId: base.company.id,
      intent: "keep",
      needsOpsReview: false,
    });
    expect(a.ok && a.value.preference.needsOpsReview).toBe(false);
    expect(b.ok && b.value.preference.needsOpsReview).toBe(true);
  });

  it("自由記述・候補に秘密らしき値があれば保存を拒否し、値をエラーに含めない", async () => {
    const base = await seedBase(db);
    const cases = [
      { customerWish: "移管コード: Xy7#kP2q!Lm" },
      { customerWish: "レジストラのパスワード=Secr3tPass" },
      { customerWish: "AKIAABCDEFGHIJKLMNOP" }, // git-check: allow-dummy-secret（検出テスト用のダミー値）
      { newDomainCandidates: ["Xy7#kP2q!Lm"] },
      { currentUrl: "https://example.jp/?pw=hunter22" },
    ];
    for (const c of cases) {
      const r = await saveDomainPreference(db, clock, base.salesActor, {
        companyId: base.company.id,
        assignmentId: base.assignment.id,
        intent: "transfer_consult",
        ...c,
      });
      expect(r).toMatchObject({ ok: false, error: "secret_like_value" });
      const text = JSON.stringify(r);
      for (const v of ["Xy7#kP2q!Lm", "Secr3tPass", "AKIAABCDEFGHIJKLMNOP", "hunter22"]) expect(text).not.toContain(v); // git-check: allow-dummy-secret（検出テスト用のダミー値）
    }
    expect(await db.select().from(domainPreferences)).toHaveLength(0);
  });

  it("移管コード・パスワード・鍵の欄はスキーマに無い", () => {
    const cols = Object.keys(domainPreferences).map((k) => k.toLowerCase());
    for (const banned of ["password", "authcode", "transfercode", "eppcode", "secret", "key"]) {
      expect(cols.some((c) => c.includes(banned))).toBe(false);
    }
  });

  it("ドメインの形式でない候補は拒否する", async () => {
    const base = await seedBase(db);
    const r = await saveDomainPreference(db, clock, base.salesActor, {
      companyId: base.company.id,
      assignmentId: base.assignment.id,
      intent: "new",
      newDomainCandidates: ["工務店 の ドメイン"],
    });
    expect(r).toMatchObject({ ok: false, error: "invalid_input" });
  });
});
