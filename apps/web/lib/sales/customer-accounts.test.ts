import { describe, expect, it } from "vitest";
import { customerAccountRows, customerAccountState, type SalesCustomerAccount } from "./customer-accounts.ts";

const base: SalesCustomerAccount = {
  id: "a",
  email: "admin@example.test",
  role: "admin",
  status: "active",
  accountStatus: "active",
  expiresAt: "2026-10-30T00:00:00Z",
  acceptedAt: "2026-10-20T00:00:00Z",
  revokedAt: null,
};
const now = Date.parse("2026-10-28T00:00:00Z");

describe("営業画面の顧客アカウント表示", () => {
  it("招待・利用中・停止を区別し、アカウント停止と解除は停止として出す", () => {
    expect(customerAccountState(base, now)).toBe("active");
    expect(customerAccountState({ ...base, accountStatus: "suspended" }, now)).toBe("stopped");
    expect(customerAccountState({ ...base, status: "revoked", revokedAt: "2026-10-27T00:00:00Z" }, now)).toBe(
      "stopped",
    );
    const invited = { ...base, status: "invited" as const, accountStatus: null, acceptedAt: null };
    expect(customerAccountState(invited, now)).toBe("invited");
    expect(customerAccountState(invited, Date.parse(invited.expiresAt))).toBe("expired");
    expect(customerAccountState({ ...invited, expiresAt: "bad" }, now)).toBe("expired");
  });
  it("管理者を先に、同じ役割では利用中を先に並べ、役割と状態を日本語で出す", () => {
    const rows = customerAccountRows(
      [
        { ...base, id: "e1", email: "editor-stopped@example.test", role: "editor", status: "revoked" },
        { ...base, id: "e2", email: "editor@example.test", role: "editor" },
        { ...base, id: "a1" },
      ],
      now,
    );
    expect(rows.map((r) => [r.id, r.role, r.state])).toEqual([
      ["a1", "管理者", "利用中"],
      ["e2", "編集者", "利用中"],
      ["e1", "編集者", "停止"],
    ]);
  });
  it("表示用の行にはメール・役割・状態だけを持たせる", () => {
    const [row] = customerAccountRows([base], now);
    expect(Object.keys(row!).sort()).toEqual(["email", "id", "role", "state", "stopped"]);
  });
});
