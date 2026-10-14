import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * インストールされているCodex SDKとCodex CLI（npmの @openai/codex）の版を、package.json から読む。
 * 読めなければnull（推測で埋めない）。
 * CLIの版は「SDKと一緒に入っているnpmパッケージの版」であり、別のcodex実行ファイルを使う構成では一致しない。
 */
export function readCodexVersions(): { sdkVersion: string | null; cliVersion: string | null } {
  let sdkPkgPath: string | null = null;
  try {
    // exports に package.json が無いため、エントリから親をたどる
    let dir = path.dirname(fileURLToPath(import.meta.resolve("@openai/codex-sdk")));
    for (let i = 0; i < 5 && sdkPkgPath === null; i++) {
      const p = path.join(dir, "package.json");
      try {
        if ((JSON.parse(readFileSync(p, "utf8")) as { name?: string }).name === "@openai/codex-sdk") sdkPkgPath = p;
      } catch {
        // 次の親へ
      }
      dir = path.dirname(dir);
    }
  } catch {
    sdkPkgPath = null;
  }
  const version = (p: string): string | null => {
    try {
      const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: unknown }).version;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  };
  const sdkVersion = sdkPkgPath ? version(sdkPkgPath) : null;
  let cliVersion: string | null = null;
  if (sdkPkgPath) {
    try {
      cliVersion = version(createRequire(sdkPkgPath).resolve("@openai/codex/package.json"));
    } catch {
      cliVersion = null;
    }
  }
  return { sdkVersion, cliVersion };
}
