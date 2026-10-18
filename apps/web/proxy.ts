import { normalizeArticleLegacyPath, resolveArticleLegacyPath } from "@siteoffer/core";
import { type NextRequest, NextResponse } from "next/server";
import { getArticleLegacyDb } from "./lib/article-legacy-db";

/** Redirect legacy /news query URLs before React can start streaming the article page. */
export async function proxy(request: NextRequest) {
  if (request.method !== "GET" && request.method !== "HEAD") return NextResponse.next();
  const match = /^\/published\/([a-f0-9-]{36})\/news\/?$/i.exec(request.nextUrl.pathname);
  if (!match || !normalizeArticleLegacyPath(`/news${request.nextUrl.search}`)) return NextResponse.next();
  try {
    const target = await resolveArticleLegacyPath(getArticleLegacyDb(), match[1]!, `/news${request.nextUrl.search}`);
    return target
      ? new NextResponse(null, { status: 308, headers: { Location: target, "Cache-Control": "no-store" } })
      : NextResponse.next();
  } catch {
    return new NextResponse(request.method === "HEAD" ? null : "Temporarily unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
export const config = { matcher: "/published/:companyId/news" };
