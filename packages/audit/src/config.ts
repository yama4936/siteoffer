import path from "node:path";
import { fileURLToPath } from "node:url";

/** 評価スキル・設定・成果物の場所 */
export interface AuditPaths {
  /** リポジトリのルート */
  repoRoot: string;
  /** .agents/skills/site-evaluation */
  evaluationSkillDir: string;
  /** .agents/skills/site-proposal */
  proposalSkillDir: string;
  /** config/site-evaluation.json（読み取りのみ。アプリから書き換えない） */
  configPath: string;
  /** 成果物（collected.json・evaluation.json 等）の保存先。Gitに入れない場所にする */
  artifactRoot: string;
}

export interface AuditOptions {
  paths: AuditPaths;
  /** collect.py に --screenshot を付ける（Chrome/Chromium がなければ collect.py 側で unavailable になる） */
  screenshot: boolean;
  /** collect.py に --psi を付ける。外部API（PageSpeed Insights）へ対象URLを送るため既定は無効 */
  psi: boolean;
  /** collect.py のプロセス全体の上限 */
  collectTimeoutMs: number;
  /** score.py・decide.py の上限 */
  scriptTimeoutMs: number;
  /** Pythonの実行ファイル。常に -I（隔離モード）で起動する */
  pythonBin: string;
}

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function defaultAuditPaths(repoRoot: string = DEFAULT_REPO_ROOT, artifactRoot?: string): AuditPaths {
  return {
    repoRoot,
    evaluationSkillDir: path.join(repoRoot, ".agents/skills/site-evaluation"),
    proposalSkillDir: path.join(repoRoot, ".agents/skills/site-proposal"),
    configPath: path.join(repoRoot, "config/site-evaluation.json"),
    // reports/ は .gitignore 済み。アプリの成果物は reports/app/ 配下に分ける
    artifactRoot: artifactRoot ?? path.join(repoRoot, "reports/app"),
  };
}

/**
 * 既定の設定。環境変数 SITEOFFER_AUDIT_ARTIFACT_DIR で成果物の保存先を変えられる。
 * overrides で個別に上書きできる（テストでは一時ディレクトリを渡す）。
 */
export function defaultAuditOptions(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Omit<AuditOptions, "paths">> & { paths?: Partial<AuditPaths> } = {},
): AuditOptions {
  const base = defaultAuditPaths(overrides.paths?.repoRoot, env.SITEOFFER_AUDIT_ARTIFACT_DIR || undefined);
  return {
    screenshot: true,
    psi: false,
    collectTimeoutMs: 10 * 60 * 1000,
    scriptTimeoutMs: 60 * 1000,
    pythonBin: "python3",
    ...overrides,
    paths: { ...base, ...overrides.paths },
  };
}

export function scriptPaths(paths: AuditPaths) {
  return {
    collect: path.join(paths.evaluationSkillDir, "scripts/collect.py"),
    score: path.join(paths.evaluationSkillDir, "scripts/score.py"),
    decide: path.join(paths.proposalSkillDir, "scripts/decide.py"),
    rubric: path.join(paths.evaluationSkillDir, "references/rubric.md"),
    outputFormat: path.join(paths.evaluationSkillDir, "references/output-format.md"),
  };
}

/**
 * 成果物ディレクトリ。診断ごとに別のディレクトリを作り、再診断で過去を上書きしない。
 * ドメインはURLから取り、パスに使えない文字を除く（ディレクトリの外へ出ないようにする）。
 */
export function artifactDirFor(artifactRoot: string, url: string, auditId: string, at: Date): string {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const domain = host.replace(/[^a-z0-9.-]/g, "_").replace(/^\.+/, "") || "unknown";
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const dir = path.resolve(artifactRoot, domain, `${stamp}-${auditId.slice(0, 8)}`);
  const root = path.resolve(artifactRoot);
  if (!dir.startsWith(root + path.sep)) throw new Error("artifact dir escapes artifact root");
  return dir;
}
