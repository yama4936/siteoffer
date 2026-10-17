import { ContentError } from "@siteoffer/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./session", () => ({ getCurrentActor: vi.fn() }));

import { privateRead, queryPage, queryUuid, queryValue } from "./private-read";
import { getCurrentActor } from "./session";

const userId = "a3c6aa83-f383-4220-90d4-0386d0f936d6";
beforeEach(() => vi.mocked(getCurrentActor).mockReset());
describe("private live read boundary", () => {
  it("rejects missing and wrong-role authentication before invoking the read", async () => {
    const read = vi.fn();
    vi.mocked(getCurrentActor).mockResolvedValueOnce(null).mockResolvedValueOnce({ kind: "sales", userId });
    for (const status of [401, 403]) {
      const response = await privateRead(["ops"], read);
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Vary")).toBe("Cookie");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("uses the current actor, including customer identity, and does not reuse a prior actor", async () => {
    vi.mocked(getCurrentActor).mockResolvedValueOnce({ kind: "customer_user", userId }).mockResolvedValueOnce(null);
    const read = vi.fn(async (actor) => ({ checkedFor: actor.userId }));
    expect(await (await privateRead(["customer_user"], read)).json()).toEqual({
      ok: true,
      result: { checkedFor: userId },
    });
    expect((await privateRead(["customer_user"], read)).status).toBe(401);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("preserves domain denial and hides unexpected internal errors", async () => {
    vi.mocked(getCurrentActor).mockResolvedValue({ kind: "ops", userId });
    const denied = await privateRead(["ops"], async () => {
      throw new ContentError("利用権限をご確認ください");
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).message).toBe("利用権限をご確認ください");
    const failed = await privateRead(["ops"], async () => {
      throw new Error("internal-database-host:5432");
    });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("internal-database-host");
    expect(failed.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("rejects ambiguous or malformed scopes instead of falling back to unfiltered reads", () => {
    for (const query of ["company=", "company=invalid", `company=${userId}&company=${userId}`])
      expect(() => queryUuid(new URLSearchParams(query), "company")).toThrow();
    expect(() => queryUuid(new URLSearchParams(), "company", true)).toThrow();
    expect(queryUuid(new URLSearchParams(), "company")).toBeUndefined();
    expect(queryUuid(new URLSearchParams(`company=${userId}`), "company", true)).toBe(userId);
    expect(() => queryValue(new URLSearchParams("kind=list&kind=count"), "kind")).toThrow();
  });
  it("accepts bounded whole-number pages and rejects ambiguous or invalid pages", () => {
    expect(queryPage(new URLSearchParams())).toBe(0);
    expect(queryPage(new URLSearchParams("page=100000"))).toBe(100000);
    for (const page of ["", "-1", "1.5", "1e2", "NaN", "100001", "1&page=2"])
      expect(() => queryPage(new URLSearchParams(`page=${page}`))).toThrow();
  });
});
