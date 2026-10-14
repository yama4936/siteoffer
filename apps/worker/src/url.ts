import { isIP } from "node:net";

/**
 * 診断に送る前のURLの確認（19章）。公開HTTP/HTTPS以外・内部ネットワーク・クラウドメタデータを弾く。
 * 名前解決後のアドレスとリダイレクト先の確認は collect.py が行う（非公開アドレスなら fatal＝評価不能）。
 * ここではURLの字面で判断できるものだけを見る。
 */
export function checkPublicHttpUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "URLとして解釈できない" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "HTTP/HTTPS以外" };
  if (url.username || url.password) return { ok: false, reason: "認証情報を含むURL" };
  if (url.port && !["80", "443"].includes(url.port)) return { ok: false, reason: `標準以外のポート（${url.port}）` };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "内部向けのホスト名" };
  }
  if (!host.includes(".") && isIP(host) === 0) return { ok: false, reason: "ドメインでないホスト名" };
  const v = isIP(host);
  if (v === 4 && isPrivateV4(host)) return { ok: false, reason: "非公開のIPv4アドレス" };
  if (v === 6 && isPrivateV6(host)) return { ok: false, reason: "非公開のIPv6アドレス" };
  return { ok: true, url };
}

function isPrivateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  if (s.startsWith("::ffff:")) return true;
  return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff");
}
