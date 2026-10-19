import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveWorkerConfig } from "../apps/worker/src/config.ts";
import { DEFAULT_SITE_BUILD_IMAGE } from "../apps/worker/src/site-builder-docker.ts";
import { isInternalProxyNetwork } from "../packages/generation/src/sandbox/environment.ts";
import { type RuntimeKind, runtimeLabelsMatch, runtimeSourceFingerprint } from "../scripts/runtime-fingerprint.ts";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  message: string;
}
export interface PreflightDeps {
  readableFile(file: string): Promise<boolean>;
  command(command: string, args: string[]): Promise<string>;
}
const exec = promisify(execFile);
const local: PreflightDeps = {
  async readableFile(file) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > 1_048_576) return false;
    await access(file, constants.R_OK);
    return true;
  },
  async command(command, args) {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USERPROFILE",
      "SystemRoot",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
      "DOCKER_CERT_PATH",
      "DOCKER_TLS_VERIFY",
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    const { stdout } = await exec(command, args, { timeout: 10000, maxBuffer: 16384, windowsHide: true, env });
    return stdout.trim();
  },
};

async function inspectRuntimeImage(
  kind: RuntimeKind,
  name: string,
  image: string,
  deps: PreflightDeps,
): Promise<PreflightCheck> {
  const setting = kind === "codex" ? "SITEOFFER_CODEX_IMAGE" : "SITEOFFER_SITE_BUILD_IMAGE";
  const build = `pnpm ${kind === "codex" ? "codex:build" : "site:build"}`;
  const result = (ok: boolean, message: string): PreflightCheck => ({ name, ok, message });
  if (!image)
    return result(
      false,
      `${setting}が未設定です。使用するイメージのタグを指定してください。作成が必要な場合は${build}を使えます。自動選択・設定変更はしません。`,
    );
  if (!/^[a-z0-9][a-z0-9./_:@-]{0,254}$/i.test(image))
    return result(
      false,
      `${setting}のタグの形式を確認してください。指定値は表示せず、Dockerへの照会も行っていません。`,
    );
  let fingerprint: string;
  try {
    fingerprint = await runtimeSourceFingerprint(kind);
  } catch {
    return result(
      false,
      "現在の制作ソースを確認できません。ファイルと読み取り権限を確認してください。イメージの古さは未確認です。",
    );
  }
  let raw: string;
  try {
    raw = await deps.command("docker", ["image", "inspect", "--format", "{{json .Config.Labels}}", image]);
  } catch {
    return result(
      false,
      `指定したイメージを参照できません。Dockerへの接続と${setting}のタグを確認してください。作成が必要な場合は${build}を使えます。ソースの一致は未確認です。`,
    );
  }
  let labels: unknown;
  try {
    labels = JSON.parse(raw);
  } catch {
    return result(
      false,
      `取得したイメージの記録を読み取れません。Dockerと指定タグを確認してください。作り直す場合は${build}を使えます。`,
    );
  }
  return runtimeLabelsMatch(labels, kind, fingerprint)
    ? result(true, "イメージと現在の制作ソースが一致（実行品質は未検証）")
    : result(
        false,
        `イメージの種類・ソースの記録が未確認、または現在の制作ソースと一致しません。${build}で再ビルドしてください。自動取得・設定変更はしません。`,
      );
}

/** Metadata checks only: no auth contents, containers, image pulls, model or external HTTP calls. */
export async function generationPreflight(
  env: NodeJS.ProcessEnv,
  deps: PreflightDeps = local,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const check = async (name: string, action: () => Promise<boolean>, success: string, failure: string) => {
    let ok = false;
    try {
      ok = await action();
    } catch {
      /* Never print raw errors, paths, keys or daemon output. */
    }
    checks.push({ name, ok, message: ok ? success : failure });
  };
  const config = resolveWorkerConfig(env);
  const valid =
    config.ok &&
    config.value.generator.kind === "codex" &&
    config.value.siteBuild.kind === "docker" &&
    config.value.generationInput === "default" &&
    config.value.auditCollector.kind === "python";
  checks.push({
    name: "実生成の構成",
    ok: valid,
    message: valid
      ? "Codex・会社別入力・実取得・Dockerビルドを選択"
      : "CodexのIMAGE・NETWORK・AUTH_FILEとサイトビルド設定を確認してください。",
  });
  const auth = env.SITEOFFER_CODEX_AUTH_FILE?.trim() || "";
  const mountable =
    path.isAbsolute(auth) &&
    !/[,"]/.test(auth) &&
    Array.from(auth).every((char) => char.charCodeAt(0) >= 32) &&
    (!auth.includes(":") || /^[a-z]:[\\/][^:]*$/i.test(auth));
  await check(
    "認証ファイル",
    () => (mountable ? deps.readableFile(auth) : Promise.resolve(false)),
    "通常ファイルの存在・読み取り権限を確認（ログインの有効性は未検証）",
    !auth
      ? "SITEOFFER_CODEX_AUTH_FILEが未設定です。読み取り可能な認証ファイルの絶対パスを指定してください。内容や秘密値は表示しません。"
      : "SITEOFFER_CODEX_AUTH_FILEに、読み取り可能な通常ファイルの絶対パスを設定してください。内容や秘密値は表示しません。",
  );
  const user = env.SITEOFFER_CODEX_USER?.trim() || "1000:1000";
  checks.push({
    name: "生成ユーザー",
    ok: /^[1-9][0-9]*:[0-9]+$/.test(user),
    message: /^[1-9][0-9]*:[0-9]+$/.test(user) ? "非root数値UID:GIDを確認" : "生成用の非root数値UID:GIDが必要です。",
  });
  await check(
    "Docker",
    async () => (await deps.command("docker", ["version", "--format", "{{.Server.Os}}"])) === "linux",
    "LinuxコンテナのDockerへ接続可能",
    "Docker DesktopとLinuxコンテナの接続先を確認してください。",
  );
  for (const [kind, name, image] of [
    ["codex", "生成イメージ", env.SITEOFFER_CODEX_IMAGE?.trim() || ""],
    ["site", "ビルドイメージ", env.SITEOFFER_SITE_BUILD_IMAGE?.trim() || DEFAULT_SITE_BUILD_IMAGE],
  ] as const)
    checks.push(await inspectRuntimeImage(kind, name, image, deps));
  const network = env.SITEOFFER_CODEX_NETWORK?.trim() || "";
  const proxyConfigured = !!env.SITEOFFER_CODEX_HTTPS_PROXY?.trim();
  await check(
    "生成ネットワーク",
    async () => {
      if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(network) || ["host", "none"].includes(network)) return false;
      if (proxyConfigured)
        return isInternalProxyNetwork(
          await deps.command("docker", ["network", "inspect", "--format", "{{json .}}", network]),
        );
      return !["host", "null", ""].includes(
        await deps.command("docker", ["network", "inspect", "--format", "{{.Driver}}", network]),
      );
    },
    proxyConfigured
      ? "プロキシ用の内部専用bridgeを確認（プロキシ到達性・送信先制限は未検証）"
      : "指定ネットワークが存在（送信先制限・到達性は未検証）",
    !network
      ? "SITEOFFER_CODEX_NETWORKが未設定です。準備した生成ネットワークの名前を指定してください。ネットワークの作成や接続変更は行っていません。"
      : proxyConfigured
        ? "プロキシ利用にはInternal=trueのbridgeが必要です。送信先を制限しないネットワークでは起動しません。"
        : "host・none以外の、準備済みの生成ネットワークを設定してください。",
  );
  await check(
    "Python",
    async () =>
      (await deps.command(env.SITEOFFER_PYTHON_BIN?.trim() || (process.platform === "win32" ? "python" : "python3"), [
        "-I",
        "-X",
        "utf8",
        "-c",
        "import sys; print(sys.version_info.major)",
      ])) === "3",
    "診断で使用するPython 3を確認",
    "SITEOFFER_PYTHON_BINまたはPython 3のインストールを確認してください。",
  );
  return checks;
}

export function printPreflightChecks(checks: PreflightCheck[]) {
  for (const check of checks) console.log(`[${check.ok ? "OK" : "要対応"}] ${check.name}：${check.message}`);
}
