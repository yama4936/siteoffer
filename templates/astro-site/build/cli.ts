#!/usr/bin/env node
/**
 * ビルドのCLI。生成コンテナ・ワーカーから呼ぶ。
 *
 *   node build/cli.ts --input site.json --out dist [--mode demo|delivery] [--check] [--mobile] [--json]
 *
 * --check を付けるとビルド後に check/ の検査を行い、エラーがあれば終了コード 1。
 * 終了コード：0 成功 / 1 検査エラー / 2 ビルド失敗（入力不正・delivery の要確認残存など） / 64 引数の誤り
 */
import { parseArgs } from "node:util";
import { checkDist, formatReport } from "../check/check-dist.ts";
import { buildSite } from "./build-site.ts";

async function main(): Promise<number> {
  let values: { input?: string; out?: string; mode?: string; check?: boolean; mobile?: boolean; json?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        input: { type: "string" },
        out: { type: "string" },
        mode: { type: "string" },
        check: { type: "boolean", default: false },
        mobile: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    console.error((e as Error).message);
    return 64;
  }
  if (!values.input || !values.out) {
    console.error(
      "使い方: node build/cli.ts --input site.json --out dist [--mode demo|delivery] [--check] [--mobile] [--json]",
    );
    return 64;
  }

  const result = await buildSite({ inputPath: values.input, outDir: values.out, mode: values.mode });
  if (!result.ok) {
    if (values.json) console.log(JSON.stringify({ build: result }, null, 2));
    else {
      console.error(`ビルド失敗（${result.reason}）：${result.message}`);
      for (const e of result.errors ?? []) console.error(`  - ${e}`);
      if (result.log) console.error(result.log);
    }
    return 2;
  }

  if (!values.check) {
    if (values.json) console.log(JSON.stringify({ build: { ...result, log: undefined } }, null, 2));
    else console.log(`ビルド成功（${result.mode}）：${result.outDir}　要確認マーカー ${result.markers.length} 件`);
    return 0;
  }

  const report = await checkDist(result.outDir, { mode: result.mode, mobile: values.mobile });
  if (values.json) console.log(JSON.stringify({ build: { ...result, log: undefined }, check: report }, null, 2));
  else {
    console.log(`ビルド成功（${result.mode}）：${result.outDir}`);
    console.log(formatReport(report));
  }
  return report.ok ? 0 : 1;
}

process.exitCode = await main();
