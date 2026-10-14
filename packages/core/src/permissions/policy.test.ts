import { describe, expect, it } from "vitest";
import type { Actor } from "../common/actor.ts";
import { authorize, authorizeUser, can, type Resource, requireUser } from "./policy.ts";

const SALES_A = "00000000-0000-4000-8000-00000000000a";
const SALES_B = "00000000-0000-4000-8000-00000000000b";
const OPS = "00000000-0000-4000-8000-0000000000aa";

const salesA: Actor = { kind: "sales", userId: SALES_A };
const ops: Actor = { kind: "ops", userId: OPS };
const customer: Actor = { kind: "customer", shareLinkId: "link" };
const system: Actor = { kind: "system", job: "test" };

type Row = [label: string, action: string, resource: Resource, expected: { sales: boolean; ops: boolean }];
const Y = true;
const N = false;

const companyFree = { type: "company", companyId: "c1", sellable: true, assignedUserId: null } as const;
const companyOthers = { type: "company", companyId: "c2", sellable: true, assignedUserId: SALES_B } as const;
const companyMine = { type: "company", companyId: "c3", sellable: true, assignedUserId: SALES_A } as const;
const companyUnreviewed = { type: "company", companyId: "c4", sellable: false, assignedUserId: null } as const;

/** AC-17：営業ユーザー（A）から見た許可・拒否の表。運営は営業の利用停止の例外を除き許可 */
const table: Row[] = [
  // 企業共通の状態（担当中か・営業拒否）は誰の担当でも読める
  ["企業共通状態（他人の担当）", "read_shared", companyOthers, { sales: Y, ops: Y }],
  ["企業共通状態（未確認の候補）", "read_shared", companyUnreviewed, { sales: Y, ops: Y }],
  ["企業詳細（営業可能・未担当）", "read", companyFree, { sales: Y, ops: Y }],
  ["企業詳細（運営確認前）", "read", companyUnreviewed, { sales: N, ops: Y }],
  ["担当確保（営業可能）", "claim", companyFree, { sales: Y, ops: Y }],
  ["担当確保（運営確認前）", "claim", companyUnreviewed, { sales: N, ops: Y }],
  ["営業拒否の記録（自分の担当）", "report_refusal", companyMine, { sales: Y, ops: Y }],
  ["営業拒否の記録（他人の担当）", "report_refusal", companyOthers, { sales: N, ops: Y }],
  ["企業情報の修正・除外", "manage", companyFree, { sales: N, ops: Y }],
  // 案件
  ["自分の案件を読む", "read", { type: "assignment", ownerUserId: SALES_A }, { sales: Y, ops: Y }],
  ["他人の非公開案件を読む", "read", { type: "assignment", ownerUserId: SALES_B }, { sales: N, ops: Y }],
  ["他人の案件を更新", "update", { type: "assignment", ownerUserId: SALES_B }, { sales: N, ops: Y }],
  ["自分の案件を解除", "release", { type: "assignment", ownerUserId: SALES_A }, { sales: Y, ops: Y }],
  ["案件の引き継ぎ（付け替え）", "reassign", { type: "assignment", ownerUserId: SALES_A }, { sales: N, ops: Y }],
  ["自分の案件の期限延長", "extend", { type: "assignment", ownerUserId: SALES_A }, { sales: N, ops: Y }],
  ["全員の案件の一覧（所有者を限定しない）", "read", { type: "assignment", ownerUserId: null }, { sales: N, ops: Y }],
  // 活動メモ
  ["自分の活動メモを読む", "read", { type: "salesActivity", ownerUserId: SALES_A }, { sales: Y, ops: Y }],
  ["自分の活動を記録", "create", { type: "salesActivity", ownerUserId: SALES_A }, { sales: Y, ops: Y }],
  ["他人の活動メモを読む", "read", { type: "salesActivity", ownerUserId: SALES_B }, { sales: N, ops: Y }],
  ["他人の案件に活動を記録", "create", { type: "salesActivity", ownerUserId: SALES_B }, { sales: N, ops: Y }],
  ["全員の相談の一覧", "read", { type: "salesActivity", ownerUserId: null }, { sales: N, ops: Y }],
  // ドメイン希望
  ["自分の案件のドメイン希望", "update", { type: "domainPreference", ownerUserId: SALES_A }, { sales: Y, ops: Y }],
  ["他人のドメイン希望を読む", "read", { type: "domainPreference", ownerUserId: SALES_B }, { sales: N, ops: Y }],
  ["ドメイン希望を記録", "create", { type: "domainPreference", ownerUserId: SALES_A }, { sales: Y, ops: Y }],
  ["担当なしのドメイン希望を記録", "create", { type: "domainPreference", ownerUserId: null }, { sales: N, ops: Y }],
  ["ドメイン希望を確認済みに", "confirm", { type: "domainPreference", ownerUserId: SALES_A }, { sales: N, ops: Y }],
  // 契約
  ["自分の契約を読む", "read", { type: "contract", ownerUserId: SALES_A }, { sales: Y, ops: Y }],
  ["自分の成約報告", "report", { type: "contract", ownerUserId: SALES_A }, { sales: Y, ops: Y }],
  ["他人の契約を読む", "read", { type: "contract", ownerUserId: SALES_B }, { sales: N, ops: Y }],
  ["自分の契約を確認済みにする", "confirm", { type: "contract", ownerUserId: SALES_A }, { sales: N, ops: Y }],
  ["自分の契約内容を変更", "update", { type: "contract", ownerUserId: SALES_A }, { sales: N, ops: Y }],
  ["所有者を限定しない成約報告", "report", { type: "contract", ownerUserId: null }, { sales: N, ops: Y }],
  // 報酬
  ["自分の報酬を読む", "read", { type: "reward", ownerUserId: SALES_A }, { sales: Y, ops: Y }],
  ["他人の報酬を読む", "read", { type: "reward", ownerUserId: SALES_B }, { sales: N, ops: Y }],
  ["自分の報酬額を変更", "manage", { type: "reward", ownerUserId: SALES_A }, { sales: N, ops: Y }],
  ["所有者を限定しない報酬の読み取り", "read", { type: "reward", ownerUserId: null }, { sales: N, ops: Y }],
  ["入金を記録・変更", "manage", { type: "payment" }, { sales: N, ops: Y }],
  // 入金・条件・設定・履歴
  ["入金を読む", "read", { type: "payment" }, { sales: N, ops: Y }],
  ["販売条件を読む", "read", { type: "productTerms" }, { sales: Y, ops: Y }],
  ["価格・報酬条件を変更", "manage", { type: "productTerms" }, { sales: N, ops: Y }],
  ["運営設定を読む", "read", { type: "settings" }, { sales: N, ops: Y }],
  ["運営設定を変更", "update", { type: "settings" }, { sales: N, ops: Y }],
  ["操作履歴を読む", "read", { type: "auditLog" }, { sales: N, ops: Y }],
  // ユーザー
  ["自分のユーザー情報", "read", { type: "user", userId: SALES_A, role: "sales" }, { sales: Y, ops: Y }],
  ["他人のユーザー情報", "read", { type: "user", userId: SALES_B, role: "sales" }, { sales: N, ops: Y }],
  ["ユーザー一覧", "list", { type: "user", userId: SALES_B, role: "sales" }, { sales: N, ops: Y }],
  ["営業ユーザーを利用停止", "suspend", { type: "user", userId: SALES_B, role: "sales" }, { sales: N, ops: Y }],
  ["自分を利用停止", "suspend", { type: "user", userId: SALES_A, role: "sales" }, { sales: N, ops: Y }],
  ["営業ユーザーの停止を解除", "reactivate", { type: "user", userId: SALES_B, role: "sales" }, { sales: N, ops: Y }],
  ["運営ユーザーを利用停止", "suspend", { type: "user", userId: OPS, role: "ops" }, { sales: N, ops: N }],
];

// biome-ignore lint/suspicious/noExplicitAny: 表の行は action と resource の組を動的に持つ
const check = (actor: Actor | null, action: string, resource: Resource) => can(actor, action as any, resource as any);

describe("権限の表（AC-17）", () => {
  it.each(table)("営業：%s（%s）", (_label, action, resource, expected) => {
    expect(check(salesA, action, resource)).toBe(expected.sales);
  });

  it.each(table)("運営：%s（%s）", (_label, action, resource, expected) => {
    expect(check(ops, action, resource)).toBe(expected.ops);
  });

  it.each(table)("未ログイン：%s（%s）は拒否", (_label, action, resource) => {
    expect(check(null, action, resource)).toBe(false);
  });

  it.each(table)("顧客（提案リンク）：%s（%s）は拒否", (_label, action, resource) => {
    expect(check(customer, action, resource)).toBe(false);
  });
});

describe("authorize", () => {
  it("未ログインは unauthenticated、権限なしは forbidden、許可は ok", () => {
    expect(authorize(null, "read", { type: "settings" })).toMatchObject({ ok: false, error: "unauthenticated" });
    expect(authorize(salesA, "read", { type: "settings" })).toMatchObject({ ok: false, error: "forbidden" });
    expect(authorize(ops, "read", { type: "settings" })).toEqual({ ok: true, value: undefined });
  });
});

describe("requireUser・authorizeUser（業務関数の入口）", () => {
  const own = { type: "assignment", ownerUserId: SALES_A } as const;

  it("営業・運営だけを通し、system・customer・未ログインは forbidden", () => {
    expect(requireUser(salesA)).toEqual({ ok: true, value: salesA });
    expect(requireUser(ops)).toEqual({ ok: true, value: ops });
    for (const a of [system, customer, null]) {
      expect(requireUser(a)).toMatchObject({ ok: false, error: "forbidden" });
    }
  });

  it("can() では許可される system も、authorizeUser では forbidden", () => {
    expect(can(system, "read", own)).toBe(true);
    expect(authorizeUser(system, "read", own)).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("未ログインは unauthenticated ではなく forbidden に寄せる", () => {
    expect(authorizeUser(null, "read", own)).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("許可なら型を絞った actor を返し、拒否なら指定のメッセージを使う", () => {
    expect(authorizeUser(salesA, "read", own)).toEqual({ ok: true, value: salesA });
    expect(authorizeUser(salesA, "reassign", own, "運営だけ")).toEqual({
      ok: false,
      error: "forbidden",
      message: "運営だけ",
    });
  });
});
