import { readFile, writeFile } from "node:fs/promises";
import { checkDist } from "../check/check-dist.ts";
import { buildSite } from "./build-site.ts";
import { SITE_BUILD_REQUEST, SITE_BUILD_RESULT, type SiteBuildReceipt, siteBuildRequestSchema } from "./protocol.ts";

async function main() {
  if (process.env.SITEOFFER_SITE_SANDBOX !== "1" || process.cwd() !== "/work") return 2;
  const request = siteBuildRequestSchema.parse(JSON.parse(await readFile(SITE_BUILD_REQUEST, "utf8")));
  const result: SiteBuildReceipt = {
    executionId: request.executionId,
    ok: false,
    reason: "internal-error",
    check: null,
  };
  try {
    const build = await buildSite({
      inputPath: "/work/site.json",
      outDir: "/work/dist",
      mode: request.mode,
      timeoutMs: request.timeoutMs,
      env: {},
    });
    if (!build.ok) result.reason = build.reason;
    else {
      const report = await checkDist(build.outDir, { mode: request.mode, mobile: false });
      const counts: Record<string, number> = {};
      for (const [key, value] of Object.entries(report.counts)) if (typeof value === "number") counts[key] = value;
      result.check = {
        ok: report.ok,
        pages: report.pages.slice(0, 100),
        counts,
        errors: report.issues
          .filter((i) => i.severity === "error")
          .slice(0, 20)
          .map((i) => ({ kind: i.kind, file: i.file.slice(0, 512), detail: i.detail.slice(0, 1000) })),
        mobile: "skipped",
      };
      result.ok = report.ok && report.pages.length <= 100;
      result.reason = result.ok ? null : "check-failed";
    }
  } catch {
    /* Never copy arbitrary transport, filesystem, or input contents into operator messages. */
  }
  await writeFile(SITE_BUILD_RESULT, JSON.stringify(result), "utf8");
  return result.ok ? 0 : 1;
}
main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error("site build: invalid request or runtime failure");
    process.exitCode = 2;
  },
);
