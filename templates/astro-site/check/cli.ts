#!/usr/bin/env node
/**
 * ビルド済み dist の検査CLI。
 *
 *   node check/cli.ts --dist dist [--mode demo|delivery] [--mobile] [--chrome /path/to/chrome] [--json]
 *
 * 終了コード：0 エラーなし（警告は許容） / 1 エラーあり / 64 引数の誤り
 */
import { parseArgs } from "node:util";
import type { SiteMode } from "../schema/site-input.ts";
import { checkDist, formatReport, isDirectory } from "./check-dist.ts";

async function main(): Promise<number> {
  let values: { dist?: string; mode?: string; mobile?: boolean; chrome?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        dist: { type: "string" },
        mode: { type: "string" },
        mobile: { type: "boolean", default: false },
        chrome: { type: "string" },
        json: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    console.error((e as Error).message);
    return 64;
  }
  if (!values.dist || !(await isDirectory(values.dist))) {
    console.error(
      "使い方: node check/cli.ts --dist <ビルド済みディレクトリ> [--mode demo|delivery] [--mobile] [--json]",
    );
    return 64;
  }
  if (values.mode && values.mode !== "demo" && values.mode !== "delivery") {
    console.error(`--mode は demo か delivery：${values.mode}`);
    return 64;
  }
  const report = await checkDist(values.dist, {
    mode: values.mode as SiteMode | undefined,
    mobile: values.mobile,
    mobileOptions: values.chrome ? { chromePath: values.chrome } : {},
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

process.exitCode = await main();
