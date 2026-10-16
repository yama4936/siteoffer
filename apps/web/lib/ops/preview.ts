import path from "node:path";
import type { Actor } from "@siteoffer/core";
import { type DbOrTx, proposalVersions } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { contentTypeFor, resolveArtifactFile } from "../../../preview/src/static";
import { siteSecurityHeaders } from "../sales/improvement";
import { isUuid } from "./form";
import { requireOps } from "./guard";

/** Review exact proposal versions; never resolve a path supplied as an artifact root. */
export async function serveOpsPreview(
  db: DbOrTx,
  actor: Actor | null,
  versionId: string,
  rawRest: string,
): Promise<Response> {
  const headers = siteSecurityHeaders();
  // Generated HTML must not be able to execute as the authenticated management origin.
  headers["Content-Security-Policy"] += "; sandbox allow-same-origin; script-src-elem 'none'";
  const missing = () => new Response("Not Found", { status: 404, headers });
  if (!requireOps(actor).ok) return new Response("Forbidden", { status: 403, headers });
  if (!isUuid(versionId)) return missing();
  const [v] = await db
    .select({ dir: proposalVersions.demoArtifactDir })
    .from(proposalVersions)
    .where(eq(proposalVersions.id, versionId));
  if (!v?.dir || !path.isAbsolute(v.dir)) return missing();
  return serveStaticPreview(v.dir, rawRest, `/ops/review/preview/${versionId}`);
}

/** Caller must authorize the company/version before supplying a database artifact directory. */
export async function serveStaticPreview(directory: string, rawRest: string, prefix: string): Promise<Response> {
  const headers = siteSecurityHeaders();
  headers["Content-Security-Policy"] += "; sandbox allow-same-origin; script-src-elem 'none'";
  const missing = () => new Response("Not Found", { status: 404, headers });
  if (!path.isAbsolute(directory)) return missing();
  const file = await resolveArtifactFile(directory, rawRest);
  if (file.kind === "not_found") return missing();
  if (file.kind === "redirect_dir")
    return new Response(null, {
      status: 308,
      headers: { ...headers, Location: `${prefix}${rawRest}/index.html` },
    });
  try {
    if (file.stats.size > 20 * 1024 * 1024) return missing();
    const body = await file.handle.readFile();
    return new Response(new Uint8Array(body), {
      headers: { ...headers, "Content-Type": contentTypeFor(file.filePath) },
    });
  } finally {
    await file.handle.close();
  }
}
