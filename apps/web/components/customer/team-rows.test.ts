import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompanyTeamManager } from "./team-manager";
import { type CompanyTeam, type CompanyTeamRow, companyTeamRowView } from "./team-rows";

const now = Date.parse("2026-10-28T00:00:00Z");
const row = (over: Partial<CompanyTeamRow>): CompanyTeamRow => ({
  accountStatus: "active",
  id: "11111111-1111-4111-8111-111111111111",
  email: "a@example.com",
  role: "editor",
  status: "active",
  revision: 1,
  expiresAt: "2026-10-30T00:00:00Z",
  acceptedAt: "2026-10-27T00:00:00Z",
  ...over,
});
const selfId = "99999999-9999-4999-8999-999999999999";

describe("companyTeamRowView", () => {
  it("自分の行は「あなた」で、解除できない", () => {
    const v = companyTeamRowView(row({ id: selfId, role: "admin" }), selfId, now);
    expect(v).toMatchObject({ self: true, roleLabel: "管理者", revokeLabel: null, canReinvite: false });
    expect(v.note).toBe("管理者の変更は運営にご依頼ください");
  });
  it("ほかの管理者は解除できず、運営への依頼を案内する", () => {
    const v = companyTeamRowView(row({ role: "admin" }), selfId, now);
    expect(v).toMatchObject({ self: false, revokeLabel: null, note: "管理者の変更は運営にご依頼ください" });
  });
  it("利用中の編集者は解除でき、招待中は取り消せる", () => {
    expect(companyTeamRowView(row({}), selfId, now)).toMatchObject({
      roleLabel: "編集者",
      statusLabel: "利用中",
      revokeLabel: "解除する",
      note: null,
    });
    expect(companyTeamRowView(row({ status: "invited", acceptedAt: null }), selfId, now)).toMatchObject({
      statusLabel: "招待中（まだ利用を始めていません）",
      revokeLabel: "招待を取り消す",
      canReinvite: false,
    });
  });
  it("期限切れ・解除済みの編集者は招待し直せる。解除済みは解除ボタンを出さない", () => {
    expect(
      companyTeamRowView(row({ status: "invited", expiresAt: "2026-10-27T00:00:00Z" }), selfId, now),
    ).toMatchObject({ statusLabel: "招待の期限が切れました", canReinvite: true, revokeLabel: "招待を取り消す" });
    expect(companyTeamRowView(row({ status: "revoked" }), selfId, now)).toMatchObject({
      statusLabel: "解除済み",
      canReinvite: true,
      revokeLabel: null,
    });
  });
  it("自分が編集者として残っていても、自分の行は解除できない", () => {
    expect(companyTeamRowView(row({ id: selfId }), selfId, now).revokeLabel).toBeNull();
  });
});

describe("CompanyTeamManager", () => {
  it("一覧と招待フォームを表示し、解除ボタンは編集者の行にだけ出す", () => {
    const team: CompanyTeam = {
      company: { id: "22222222-2222-4222-8222-222222222222", name: "テスト工務店" },
      selfAccessId: selfId,
      access: [
        row({ id: selfId, email: "me@example.com", role: "admin" }),
        row({ id: "33333333-3333-4333-8333-333333333333", email: "boss@example.com", role: "admin" }),
        row({ email: "editor@example.com" }),
      ],
    };
    const html = renderToStaticMarkup(
      createElement(CompanyTeamManager, {
        initial: team,
        actions: {
          invite: async () => ({ status: "error" as const, message: "" }),
          revoke: async () => ({ status: "error" as const, message: "" }),
          refresh: async () => ({ status: "error" as const, message: "" }),
        },
      }),
    );
    expect(html).toContain("担当者を招待する");
    expect(html).toContain("あなた");
    expect(html).toContain("editor@example.com");
    expect(html.match(/管理者の変更は運営にご依頼ください/g)).toHaveLength(2);
    expect(html.match(/>解除する</g)).toHaveLength(1);
    expect(html).not.toContain("contractId");
  });
});
