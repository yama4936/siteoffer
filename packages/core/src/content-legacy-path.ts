import { detectSecretLike } from "./domain-preference/secrets.ts";

const control = (value: string) =>
  Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const sensitive =
  /^(?:token|access_?token|refresh_?token|id_token|auth_?token|auth|authorization|password|passwd|secret|api_key|apikey|session|sessionid|sid|signature|sig|key|csrf_?token|xsrf_?token)$/i;
/** Canonical relative article aliases only; never accepts a redirect destination. */
export function normalizeArticleLegacyPath(raw: string): string | null {
  if (
    typeof raw !== "string" ||
    raw.length > 2048 ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("#") ||
    raw.includes("\\") ||
    control(raw)
  )
    return null;
  const path = raw.split("?", 1)[0]!;
  if (path.includes("//") || /%(?:2f|5c|25|00|0a|0d)/i.test(path) || /%(?![a-f0-9]{2})/i.test(raw)) return null;
  let decoded: string;
  let canonicalPath: string;
  try {
    decoded = decodeURIComponent(path);
    decodeURIComponent(raw.slice(path.length).replace(/\+/g, " "));
    const decodedUrl = `https://legacy.invalid${decodeURIComponent(raw)}`;
    if (detectSecretLike(decodedUrl) || /(?:sk-(?:proj-)?[a-z0-9_-]{20,}|ghp_[a-z0-9]{30,})/i.test(decodedUrl))
      return null;
    canonicalPath = decoded.split("/").map(encodeURIComponent).join("/").replace(/\/$/, "") || "/";
  } catch {
    return null;
  }
  if (control(decoded) || decoded.split("/").some((segment) => segment === "." || segment === "..")) return null;
  const url = new URL(raw, "https://legacy.invalid");
  for (const [key, value] of url.searchParams) if (sensitive.test(key) || control(key) || control(value)) return null;
  url.searchParams.sort();
  const query = url.searchParams.toString();
  if (
    (canonicalPath === "/" && !query) ||
    canonicalPath === "/news/images" ||
    canonicalPath.startsWith("/news/images/")
  )
    return null;
  if (
    canonicalPath === "/news" &&
    (!query || ["article", "page", "q", "category"].some((key) => url.searchParams.has(key)))
  )
    return null;
  const result = `${canonicalPath}${query ? `?${query}` : ""}`;
  return result.length <= 2048 ? result : null;
}
export function articleLegacyPath(source: string | null) {
  if (!source || source.length > 2048 || control(source)) return null;
  try {
    const url = new URL(source);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) return null;
    // Inspect the original path before WHATWG URL parsing can remove dot segments.
    const raw = /^https?:\/\/[^/?#]+(\/[^#]*)?$/i.exec(source);
    if (!raw) {
      const rootQuery = /^https?:\/\/[^/?#]+(\?[^#]+)$/i.exec(source);
      return rootQuery ? normalizeArticleLegacyPath(`/${rootQuery[1]}`) : null;
    }
    return normalizeArticleLegacyPath(raw[1] ?? "/");
  } catch {
    return null;
  }
}
