import { resolveArticleLegacyPath } from "@siteoffer/core";
import { getArticleLegacyDb } from "./article-legacy-db";
export async function articleLegacyResponse(request: Request, companyId: string) {
  const text = (status: number, body: string, extra: Record<string, string> = {}) =>
    new Response(request.method === "HEAD" ? null : body, {
      status,
      headers: { "Cache-Control": "no-store", ...extra },
    });
  if (request.method !== "GET" && request.method !== "HEAD")
    return text(405, "Method Not Allowed", { Allow: "GET, HEAD" });
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(companyId)) return text(404, "Not Found");
  const url = new URL(request.url),
    prefix = `/published/${companyId}`;
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return text(404, "Not Found");
  try {
    const target = await resolveArticleLegacyPath(
      getArticleLegacyDb(),
      companyId,
      `${url.pathname.slice(prefix.length) || "/"}${url.search}`,
    );
    return target
      ? new Response(null, { status: 308, headers: { Location: target, "Cache-Control": "no-store" } })
      : text(404, "Not Found");
  } catch {
    return text(503, "Temporarily unavailable");
  }
}
