import { expect, it, vi } from "vitest";
import { runLocalHttpSmoke } from "../local-http-smoke.ts";

it.each([{ args: ["--finish"] }, { args: ["--force"] }, { args: ["--finish", "--force"] }])(
  "古い業務更新の引数 $args をネットワーク通信前に拒否する",
  async ({ args }) => {
    const request = vi.fn<typeof fetch>();
    expect(await runLocalHttpSmoke(args, request)).toMatchObject({ ok: false, refused: true });
    expect(request).not.toHaveBeenCalled();
  },
);
it("6経路をCookieなしのGETだけで確認し、認証済みの業務確認とは区別する", async () => {
  const request = vi.fn<typeof fetch>(async (input, init) => {
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual", cache: "no-store" });
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return String(input).endsWith("/login") || String(input).endsWith("/register")
      ? new Response("SiteOffer", { headers: { "Content-Type": "text/html" } })
      : new Response(null, { status: 307, headers: { Location: "/login" } });
  });
  const result = await runLocalHttpSmoke([], request);
  expect(result).toMatchObject({ ok: true, refused: false, scope: "anonymous-http-only" });
  expect(request).toHaveBeenCalledTimes(6);
});
it("保護ページの200、外部への転送、公開入口の不正な内容を成功にしない", async () => {
  const request = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith("/login")
      ? new Response("SiteOffer", { headers: { "Content-Type": "application/json" } })
      : String(input).endsWith("/ops")
        ? new Response("SiteOffer", { headers: { "Content-Type": "text/html" } })
        : new Response(null, {
            status: 307,
            headers: { Location: "https://other.example.test/login?token=do-not-store" },
          }),
  );
  const result = await runLocalHttpSmoke([], request);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("do-not-store");
});
it("接続障害は失敗としてまとめ、例外に含まれる秘密値やURLを出力しない", async () => {
  const result = await runLocalHttpSmoke(
    [],
    vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-token https://private.example.test")),
  );
  expect(result).toMatchObject({ ok: false, refused: false });
  expect(JSON.stringify(result)).not.toMatch(/secret-token|private\.example/);
});
