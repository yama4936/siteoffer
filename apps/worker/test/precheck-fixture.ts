/** AIの事前チェックのテスト用の部品。実際の check.py を通る最小サイトの作成と、検査スクリプトの偽物 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PythonRunner } from "../src/skills/precheck.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const SITE_REBUILD_SCRIPTS = path.join(REPO_ROOT, ".agents/skills/site-rebuild/scripts");
const MAKE_SITE = fileURLToPath(new URL("./fixtures/make-precheck-site.py", import.meta.url));

/** <artifactDir>/site に check.py・check_mobile_quality.py を通るサイトを作る（スマホ確認の画像は <artifactDir>/review） */
export function makePrecheckSite(siteDir: string) {
  execFileSync("python3", ["-I", MAKE_SITE, SITE_REBUILD_SCRIPTS, siteDir]);
}

type Output = { ok: boolean; errors: unknown[] };

/** 検査スクリプトの偽物。呼ばれたスクリプトと引数を calls に残す */
export function fakePython(check: Output, mobile: Output = { ok: true, errors: [] }) {
  const calls: { script: string; args: string[] }[] = [];
  const run: PythonRunner = async (script, args) => {
    calls.push({ script, args });
    const out = path.basename(script) === "check.py" ? check : mobile;
    return { code: out.ok ? 0 : 1, stdout: JSON.stringify(out), stderr: "" };
  };
  return { run, calls };
}
