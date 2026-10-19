import { existsSync } from "node:fs";
import path from "node:path";
import { demoGenerationEnv, demoPublicEnv, resolveDemoMode } from "./generation-mode.ts";
import { inspectPendingGenerationWork } from "./generation-pending.ts";
import { generationPreflight, type PreflightCheck, printPreflightChecks } from "./generation-preflight.ts";
import { generationWorkReadiness } from "./generation-work-readiness.ts";
import { DEMO_DATABASE_URL, DEMO_PATHS, REPO_ROOT } from "./paths.ts";
import { assertResumeProfile } from "./resume.ts";

async function main() {
  const mode = resolveDemoMode(["--resume", "--real-generation"], process.env);
  if (existsSync(path.join(REPO_ROOT, ".env"))) process.loadEnvFile(path.join(REPO_ROOT, ".env"));
  resolveDemoMode(["--resume", "--real-generation"], process.env);
  const env = { ...demoPublicEnv(process.env, mode), ...demoGenerationEnv(process.env, mode) };
  const checks: PreflightCheck[] = [];
  try {
    await assertResumeProfile(DEMO_PATHS);
    checks.push({ name: "既存データ", ok: true, message: "DBと共有復旧鍵が存在。初期化・シードはしません。" });
  } catch {
    checks.push({ name: "既存データ", ok: false, message: "既存DB・共有復旧鍵の場所と権限を確認してください。" });
  }
  checks.push(...(await generationPreflight(env)));
  try {
    checks.push(...generationWorkReadiness(await inspectPendingGenerationWork(DEMO_DATABASE_URL)));
  } catch {
    checks.push({
      name: "未完了業務・稼働状況",
      ok: false,
      message: "DBに接続して件数を確認できません。同じDEMO_DB_PORTで稼働中に確認するか、起動時の再確認が必要です。",
    });
  }
  printPreflightChecks(checks);
  console.log("読み取り専用の事前確認です。サーバー起動・データ更新・モデル通信は行っていません。");
  console.log(
    "実生成で起動すると、以後の診断・提案・納品依頼はCodexの利用枠を消費します。画像生成APIは有効にしません。",
  );
  process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}
main().catch(() => {
  console.error("事前確認を完了できませんでした。起動設定を確認してください。");
  process.exitCode = 1;
});
