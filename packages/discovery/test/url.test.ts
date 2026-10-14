import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../src/url.ts";

function n(u: string) {
  const r = normalizeUrl(u);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("URLの正規化", () => {
  it("スキーム・www・末尾スラッシュ・ホストの大文字小文字を揃える", () => {
    const variants = [
      "https://kakuseiko.test/",
      "http://kakuseiko.test",
      "https://www.kakuseiko.test",
      "HTTP://WWW.KakuSeiko.TEST/",
      "kakuseiko.test",
      "https://kakuseiko.test:443/#top",
    ];
    for (const v of variants) expect(n(v).normalizedUrl).toBe("https://kakuseiko.test");
    expect(n("https://www.kakuseiko.test/").domain).toBe("kakuseiko.test");
  });

  it("追跡用パラメータを除き、残りのパラメータは順序を揃えて残す", () => {
    expect(n("https://a.test/p/?utm_source=x&gclid=1&fbclid=2&b=2&a=1").normalizedUrl).toBe("https://a.test/p?a=1&b=2");
    expect(n("http://WWW.Aoba-Print.test/?utm_source=portal&utm_medium=listing&gclid=abc123").normalizedUrl).toBe(
      "https://aoba-print.test",
    );
  });

  it("パスの大文字小文字は保つ（サーバーが区別しうる）", () => {
    expect(n("https://a.test/About/").normalizedUrl).toBe("https://a.test/About");
  });

  it("http/https以外・公開アドレスでないホストは扱わない", () => {
    expect(normalizeUrl("ftp://a.test/")).toMatchObject({ ok: false, error: "unsupported_scheme" });
    expect(normalizeUrl("http://localhost:3000/")).toMatchObject({ ok: false, error: "non_public_host" });
    expect(normalizeUrl("http://169.254.169.254/latest/meta-data")).toMatchObject({
      ok: false,
      error: "non_public_host",
    });
    expect(normalizeUrl("http://10.0.0.1/")).toMatchObject({ ok: false, error: "non_public_host" });
    expect(normalizeUrl("http://[::1]/")).toMatchObject({ ok: false, error: "non_public_host" });
    expect(normalizeUrl("http://user:pass@a.test/")).toMatchObject({ ok: false, error: "invalid_url" });
    expect(normalizeUrl("http://")).toMatchObject({ ok: false });
  });
});
