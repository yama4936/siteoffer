import { createServer, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import { err, ok } from "@siteoffer/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkFetchableUrl,
  createPublicLookup,
  createPublicPageFetcher,
  decodeBody,
  type HttpTransport,
  isPublicIpAddress,
  nodeHttpTransport,
} from "../src/fetch-page.ts";

describe("公開アドレスの判定", () => {
  it("非公開・予約・メタデータのアドレスを弾く", () => {
    for (const ip of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "198.18.0.1",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "64:ff9b::a00:1",
    ]) {
      expect(isPublicIpAddress(ip), ip).toBe(false);
    }
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("2606:4700::1")).toBe(true);
    expect(isPublicIpAddress("not-an-ip")).toBe(false);
  });

  it("URLの字面：http(s)・標準ポート・ドメイン名だけを通す", () => {
    expect(checkFetchableUrl("https://kakuu.example.jp/about").ok).toBe(true);
    for (const u of [
      "file:///etc/passwd",
      "http://localhost/",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "https://kakuu.example.jp:8443/",
      "https://user:pass@kakuu.example.jp/",
      "http://metadata.internal/",
    ]) {
      expect(checkFetchableUrl(u).ok, u).toBe(false);
    }
  });

  it("名前解決の結果に非公開アドレスが1つでもあれば接続させない", async () => {
    const lookup = createPublicLookup(async (host) =>
      host === "evil.example.jp"
        ? [
            { address: "93.184.216.34", family: 4 },
            { address: "10.0.0.5", family: 4 },
          ]
        : [{ address: "93.184.216.34", family: 4 }],
    );
    const call = (host: string) =>
      new Promise<{ e: unknown; address: unknown }>((resolve) =>
        (lookup as unknown as (h: string, o: object, cb: (e: unknown, a?: unknown) => void) => void)(
          host,
          {},
          (e, address) => resolve({ e, address }),
        ),
      );
    expect((await call("evil.example.jp")).e).toBeInstanceOf(Error);
    expect(await call("good.example.jp")).toEqual({ e: null, address: "93.184.216.34" });
  });
});

/** 応答を順に返す偽のHTTP（実際の通信はしない） */
function fakeTransport(routes: Record<string, Awaited<ReturnType<HttpTransport>>>) {
  const calls: string[] = [];
  const transport: HttpTransport = async (url) => {
    calls.push(url.href);
    return routes[url.href] ?? err("network_error", "接続に失敗");
  };
  return { transport, calls };
}
const page = (status: number, body = "", location: string | null = null, contentType = "text/html; charset=utf-8") =>
  ok({ status, location, contentType, body: Buffer.from(body) });

describe("ページ取得（リダイレクト・種類・制限時間）", () => {
  it("リダイレクト先を1回ごとに検査し、非公開アドレスへの転送を取得しない", async () => {
    const { transport, calls } = fakeTransport({
      "https://kakuu.example.jp/": page(301, "", "http://169.254.169.254/latest/meta-data/"),
    });
    const r = await createPublicPageFetcher({ transport })("https://kakuu.example.jp/");
    expect(r).toMatchObject({ ok: false, error: "blocked_url" });
    expect(calls).toEqual(["https://kakuu.example.jp/"]);
  });

  it("相対リダイレクトを追い、最終URLと本文を返す", async () => {
    const { transport } = fakeTransport({
      "http://kakuu.example.jp/": page(302, "", "https://kakuu.example.jp/top"),
      "https://kakuu.example.jp/top": page(301, "", "/company/"),
      "https://kakuu.example.jp/company/": page(200, "<h1>株式会社架空</h1>"),
    });
    const r = await createPublicPageFetcher({ transport })("http://kakuu.example.jp/");
    expect(r).toMatchObject({ ok: true, value: { finalUrl: "https://kakuu.example.jp/company/", status: 200 } });
    if (r.ok) expect(r.value.body).toContain("株式会社架空");
  });

  it("リダイレクトの回数に上限がある", async () => {
    const { transport } = fakeTransport({
      "https://a.example.jp/": page(302, "", "https://b.example.jp/"),
      "https://b.example.jp/": page(302, "", "https://a.example.jp/"),
    });
    const r = await createPublicPageFetcher({ transport, maxRedirects: 3 })("https://a.example.jp/");
    expect(r).toMatchObject({ ok: false, error: "too_many_redirects" });
  });

  it("200以外とHTML以外は取得できないものとする", async () => {
    const { transport } = fakeTransport({
      "https://a.example.jp/": page(404),
      "https://b.example.jp/": page(200, "%PDF", null, "application/pdf"),
    });
    const f = createPublicPageFetcher({ transport });
    expect(await f("https://a.example.jp/")).toMatchObject({ ok: false, error: "http_status" });
    expect(await f("https://b.example.jp/")).toMatchObject({ ok: false, error: "unsupported_content_type" });
  });

  it("制限時間を超えたら打ち切る", async () => {
    const transport: HttpTransport = () => new Promise(() => {});
    const r = await createPublicPageFetcher({ transport, timeoutMs: 20 })("https://slow.example.jp/");
    expect(r).toMatchObject({ ok: false, error: "timeout" });
  });

  it("Shift_JIS のページを文字化けさせずに読む", () => {
    // 「架空」の Shift_JIS
    const sjis = Buffer.from([0x89, 0xcb, 0x8b, 0xf3]);
    expect(decodeBody(sjis, "text/html; charset=Shift_JIS")).toBe("架空");
    const withMeta = Buffer.concat([Buffer.from('<meta charset="shift_jis">'), sjis]);
    expect(decodeBody(withMeta, "text/html")).toContain("架空");
  });
});

describe("node:http による取得（ループバックの模擬サーバー。外部へは接続しない）", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });
  async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return (server.address() as AddressInfo).port;
  }
  /** テスト用：ホスト名を模擬サーバーへ向ける lookup（本番では createPublicLookup が非公開アドレスを弾く） */
  const toLoopback: LookupFunction = ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
    o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as LookupFunction;

  it("本文がサイズ上限を超えたら打ち切る", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("a".repeat(600));
      res.end("b".repeat(600));
    });
    const r = await nodeHttpTransport(new URL(`http://mock.example.jp:${port}/`), {
      signal: new AbortController().signal,
      maxBytes: 1000,
      lookup: toLoopback,
      userAgent: "test",
    });
    expect(r).toMatchObject({ ok: false, error: "too_large" });
  });

  it("既定の lookup はループバックへの接続を拒否する", async () => {
    const port = await serve((_req, res) => res.end("ok"));
    const r = await nodeHttpTransport(new URL(`http://mock.example.jp:${port}/`), {
      signal: new AbortController().signal,
      maxBytes: 1000,
      lookup: createPublicLookup(async () => [{ address: "127.0.0.1", family: 4 }]),
      userAgent: "test",
    });
    expect(r).toMatchObject({ ok: false, error: "blocked_address" });
  });
});
