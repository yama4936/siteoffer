import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSite, type CheckReport, checkDist, type SiteInputRaw } from "@siteoffer/astro-site";
import type { DemoCheckSummary } from "./content.ts";

export type SiteBuildOutcome =
  | { ok: true; distDir: string; check: DemoCheckSummary }
  /** retryable：一時的な失敗（ビルドの異常終了・時間切れ）。false なら同じ入力で再試行しても変わらない */
  | { ok: false; reason: string; message: string; retryable: boolean; check?: DemoCheckSummary };

/** デモのビルドと検査。テストではビルドを差し替えられる（Astroのビルドは時間とメモリを使う） */
export interface SiteBuilder {
  buildDemo(input: { siteInput: SiteInputRaw; workDir: string }): Promise<SiteBuildOutcome>;
}

export function summarizeCheck(report: CheckReport): DemoCheckSummary {
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(report.counts)) if (typeof v === "number") counts[k] = v;
  return {
    ok: report.ok,
    pages: report.pages,
    counts,
    errors: report.issues
      .filter((i) => i.severity === "error")
      .slice(0, 20)
      .map((i) => ({ kind: i.kind, file: i.file, detail: i.detail })),
    mobile: report.mobile.status,
  };
}

/**
 * templates/astro-site でデモ（mode=demo：非公式の提案である表示・noindex 付き）をビルドし、checkDist で検査する。
 * workDir に site.json と dist/ を作る。スマホ幅の検査（ヘッドレスChrome）は既定で行わない。
 */
export function createAstroSiteBuilder(options: { timeoutMs?: number; mobileCheck?: boolean } = {}): SiteBuilder {
  return {
    async buildDemo({ siteInput, workDir }) {
      await mkdir(workDir, { recursive: true });
      const inputPath = path.join(workDir, "site.json");
      await writeFile(inputPath, `${JSON.stringify(siteInput, null, 2)}\n`, "utf8");
      const outDir = path.join(workDir, "dist");
      const built = await buildSite({
        inputPath,
        outDir,
        mode: "demo",
        env: {},
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      if (!built.ok) {
        const retryable = built.reason === "astro-build-failed";
        const detail = built.errors?.length ? `: ${built.errors.slice(0, 5).join("; ")}` : "";
        return { ok: false, reason: built.reason, message: `${built.message}${detail}`, retryable };
      }
      const report = await checkDist(built.outDir, { mode: "demo", mobile: options.mobileCheck ?? false });
      const check = summarizeCheck(report);
      if (!report.ok) {
        const first = check.errors
          .slice(0, 5)
          .map((e) => `${e.kind}(${e.file})`)
          .join(", ");
        return {
          ok: false,
          reason: "check-failed",
          message: `デモの検査に失敗した: ${first}`,
          retryable: false,
          check,
        };
      }
      return { ok: true, distDir: built.outDir, check };
    },
  };
}
