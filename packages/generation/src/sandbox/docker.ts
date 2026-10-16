import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SANDBOX_REQUEST_FILE,
  SANDBOX_RESULT_FILE,
  SANDBOX_WORKDIR,
  type SandboxResult,
  type SandboxRunner,
  type SandboxRunOutcome,
  type SandboxRunSpec,
  sandboxResultSchema,
} from "./types.ts";

/**
 * ジョブごとの使い捨てコンテナでCodexを動かす（24.4）。
 * Codex SDKはこの隔離コンテナ内で実行し、ホストの認証ファイルは読み取り専用で渡す。
 */
export interface DockerSandboxConfig {
  /** 生成用イメージ（T12で用意。Codex CLI・SDK・このパッケージのエントリを含む） */
  image: string;
  /** dockerコマンドのパス */
  dockerPath: string;
  /**
   * コンテナのネットワーク。Codexは OpenAI のAPIに接続する必要があるため none では動かない想定。
   * 送信先を限定したネットワーク（出口プロキシ付き等）を指定する。host は拒否する。
   */
  network: string;
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  /** /tmp と CODEX_HOME に使う tmpfs の上限 */
  tmpfsMb: number;
  /** ホスト側のCodex認証ファイル（ChatGPTログインの auth.json）。読み取り専用で渡す */
  codexAuthFile: string;
  /** コンテナ内で実行するコマンド */
  entryCommand: string[];
  /** コンテナ内の実行ユーザー */
  user: string;
}

export const DEFAULT_DOCKER_SANDBOX_CONFIG: Omit<DockerSandboxConfig, "image" | "network" | "codexAuthFile"> = {
  dockerPath: "docker",
  cpus: 1,
  memoryMb: 2048,
  pidsLimit: 256,
  tmpfsMb: 256,
  entryCommand: [
    "node",
    "--import",
    "/app/node_modules/tsx/dist/loader.mjs",
    "/app/packages/generation/src/sandbox/container-entry.ts",
  ],
  user: "1000:1000",
};

const CONTAINER_HOME = "/home/codex";
const CONTAINER_CODEX_HOME = `${CONTAINER_HOME}/.codex`;

/** dockerクライアントのプロセスに渡してよい環境変数。アプリの秘密値（DB接続・APIキー等）は渡さない */
const DOCKER_CLIENT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
];

export function containerName(jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) throw new Error(`コンテナ名に使えないジョブID: ${jobId}`);
  return `siteoffer-gen-${jobId}`;
}

/** docker run の引数を組み立てる（純粋関数。テスト対象） */
export function buildDockerRunArgs(
  config: DockerSandboxConfig,
  spec: Pick<SandboxRunSpec, "jobId" | "workDir" | "timeoutMs">,
): string[] {
  if (config.network === "host") throw new Error("生成コンテナに host ネットワークは使わない");
  if (!/^\d+:\d+$/.test(config.user)) throw new Error("実行ユーザーは数値のUID:GIDで指定する");
  if (!path.isAbsolute(spec.workDir)) throw new Error("作業ディレクトリは絶対パスで指定する");
  if (!path.isAbsolute(config.codexAuthFile)) throw new Error("Codex認証ファイルは絶対パスで指定する");
  for (const p of [spec.workDir, config.codexAuthFile]) {
    // -v の区切り文字を含むパスは別のマウント指定として解釈されうるため拒否する
    if (p.includes(":") || p.includes(",")) throw new Error(`マウントに使えないパス: ${p}`);
  }
  const tmpfs = `rw,noexec,nosuid,size=${config.tmpfsMb}m`;
  const [uid, gid] = config.user.split(":");
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    containerName(spec.jobId),
    "--label",
    `siteoffer.generation.job=${spec.jobId}`,
    // ネットワーク
    "--network",
    config.network,
    // 資源の上限
    "--cpus",
    String(config.cpus),
    "--memory",
    `${config.memoryMb}m`,
    "--memory-swap",
    `${config.memoryMb}m`,
    "--pids-limit",
    String(config.pidsLimit),
    "--stop-timeout",
    "10",
    // 権限
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    config.user,
    "--tmpfs",
    `/tmp:${tmpfs}`,
    "--tmpfs",
    `${CONTAINER_CODEX_HOME}:rw,nosuid,size=${config.tmpfsMb}m,uid=${uid},gid=${gid},mode=0700`,
    // マウント：このジョブの作業ディレクトリと、読み取り専用のCodex認証だけ
    "--mount",
    `type=bind,source=${spec.workDir},target=${SANDBOX_WORKDIR}`,
    "--mount",
    `type=bind,source=${config.codexAuthFile},target=/run/siteoffer-auth.json,readonly`,
    "--workdir",
    SANDBOX_WORKDIR,
    // 環境変数：値を明示したものだけ。ホストの値を引き継ぐ形式（-e NAME）や --env-file は使わない
    "--env",
    "SITEOFFER_SANDBOX=1",
    "--env",
    "SITEOFFER_CODEX_AUTH_SOURCE=/run/siteoffer-auth.json",
    "--env",
    `HOME=${CONTAINER_HOME}`,
    "--env",
    `CODEX_HOME=${CONTAINER_CODEX_HOME}`,
    "--env",
    `SITEOFFER_TIMEOUT_MS=${spec.timeoutMs}`,
    config.image,
    ...config.entryCommand,
  ];
}

/** dockerクライアントに渡す環境変数（許可したものだけ） */
export function buildDockerClientEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of DOCKER_CLIENT_ENV_ALLOWLIST) {
    const v = source[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function runProcess(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: () => void,
): Promise<{ code: number | null; timedOut: boolean; aborted: boolean; stderr: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, timedOut: false, aborted: true, stderr: "" });
      return;
    }
    const child = spawn(cmd, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout();
      child.kill("SIGTERM");
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      onTimeout();
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, timedOut, aborted, stderr });
    };
    child.once("error", (e) => {
      stderr += e.message;
      done(null);
    });
    child.once("close", (code) => done(code));
  });
}

export class DockerSandboxRunner implements SandboxRunner {
  readonly kind = "docker";
  private readonly config: DockerSandboxConfig;
  private readonly env: Record<string, string>;

  constructor(
    config: Pick<DockerSandboxConfig, "image" | "network" | "codexAuthFile"> & Partial<DockerSandboxConfig>,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.config = { ...DEFAULT_DOCKER_SANDBOX_CONFIG, ...config };
    this.env = buildDockerClientEnv(env);
  }

  async run(spec: SandboxRunSpec): Promise<SandboxRunOutcome> {
    if (spec.signal?.aborted) return { ok: false, error: "aborted", message: "中断された", result: null };
    await writeFile(path.join(spec.workDir, SANDBOX_REQUEST_FILE), JSON.stringify(spec.request));
    const args = buildDockerRunArgs(this.config, spec);
    const name = containerName(spec.jobId);
    const kill = () => {
      // 時間切れ・中断時はコンテナを確実に止める（docker run の終了だけではコンテナが残りうる）
      spawn(this.config.dockerPath, ["rm", "--force", name], { env: this.env, stdio: "ignore" }).on("error", () => {});
    };
    const r = await runProcess(this.config.dockerPath, args, this.env, spec.timeoutMs, spec.signal, kill);
    const result = await this.readResult(spec.workDir);
    if (r.timedOut) return { ok: false, error: "timeout", message: `${spec.timeoutMs}msで打ち切った`, result };
    if (r.aborted) return { ok: false, error: "aborted", message: "中断された", result };
    if (result === null) {
      return {
        ok: false,
        error: "sandbox_error",
        message: `結果ファイルがない（終了コード ${r.code}）: ${r.stderr.slice(0, 1000)}`,
        result,
      };
    }
    if (!result.ok)
      return { ok: false, error: "sandbox_error", message: result.error ?? `終了コード ${r.code}`, result };
    return { ok: true, result };
  }

  private async readResult(workDir: string): Promise<SandboxResult | null> {
    try {
      const parsed = sandboxResultSchema.safeParse(
        JSON.parse(await readFile(path.join(workDir, SANDBOX_RESULT_FILE), "utf8")),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
