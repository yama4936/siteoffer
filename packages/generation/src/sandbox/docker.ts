import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { runIsolatedContainer } from "./docker-process.ts";
import { recoverDockerExecution } from "./stop-recovery.ts";
import {
  SANDBOX_REQUEST_FILE,
  SANDBOX_RESULT_FILE,
  SANDBOX_WORKDIR,
  type SandboxResult,
  type SandboxRunner,
  type SandboxRunOutcome,
  type SandboxRunSpec,
  type SandboxStopReference,
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
  entryCommand: ["node", "/app/packages/generation/src/sandbox/container-entry.ts"],
  user: "1000:1000",
};

const CONTAINER_HOME = "/home/codex";
const CONTAINER_CODEX_HOME = `${CONTAINER_HOME}/.codex`;

/** dockerクライアントのプロセスに渡してよい環境変数。アプリの秘密値（DB接続・APIキー等）は渡さない */
const DOCKER_CLIENT_ENV_ALLOWLIST = [
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
];

export function containerName(jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) throw new Error(`コンテナ名に使えないジョブID: ${jobId}`);
  return `siteoffer-gen-${jobId}`;
}

/** docker run の引数を組み立てる（純粋関数。テスト対象） */
export function buildDockerRunArgs(
  config: DockerSandboxConfig,
  spec: Pick<SandboxRunSpec, "jobId" | "workDir" | "timeoutMs"> & { executionId?: string },
): string[] {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(spec.jobId)) throw new Error("生成ジョブの識別子が不正です");
  if (config.network === "host") throw new Error("生成コンテナに host ネットワークは使わない");
  if (!/^\d+:\d+$/.test(config.user)) throw new Error("実行ユーザーは数値のUID:GIDで指定する");
  if (!path.isAbsolute(spec.workDir)) throw new Error("作業ディレクトリは絶対パスで指定する");
  if (!path.isAbsolute(config.codexAuthFile)) throw new Error("Codex認証ファイルは絶対パスで指定する");
  for (const p of [spec.workDir, config.codexAuthFile]) {
    // --mount uses comma-separated options. A Windows drive colon belongs to the source path.
    const drivePath = /^[a-z]:[\\/][^:]*$/i.test(p);
    if (
      (p.includes(":") && !drivePath) ||
      p.includes(",") ||
      p.includes('"') ||
      Array.from(p).some((char) => char.charCodeAt(0) < 32)
    )
      throw new Error("マウント先のパスに使えない文字があります");
  }
  const tmpfs = `rw,noexec,nosuid,size=${config.tmpfsMb}m`;
  const [uid, gid] = config.user.split(":");
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--init",
    "--name",
    containerName(spec.executionId ?? spec.jobId),
    "--label",
    `siteoffer.generation.job=${spec.jobId}`,
    ...(spec.executionId ? ["--label", `siteoffer.generation.execution=${spec.executionId}`] : []),
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
    if (spec.signal?.aborted)
      return { ok: false, error: "aborted", message: "中断された", result: null, stopped: true };
    const executionId = randomUUID();
    let stopReference: SandboxStopReference = {
      executionId,
      jobId: spec.jobId,
      containerName: containerName(executionId),
      host: hostname(),
      clientPid: null,
      clientClosed: false,
      stopped: false,
    };
    let executing = false;
    try {
      const args = buildDockerRunArgs(this.config, { ...spec, executionId });
      await writeFile(path.join(spec.workDir, SANDBOX_REQUEST_FILE), JSON.stringify({ ...spec.request, executionId }));
      await spec.saveStopReference?.(stopReference);
      if (spec.signal?.aborted) {
        stopReference = { ...stopReference, clientClosed: true, stopped: true };
        await spec.saveStopReference?.(stopReference);
        return {
          ok: false,
          error: "aborted",
          message: "開始前に中断しました",
          result: null,
          stopped: true,
          stopReference,
        };
      }
      executing = true;
      const r = await runIsolatedContainer(
        this.config.dockerPath,
        args,
        stopReference.containerName,
        this.env,
        spec.timeoutMs,
        spec.signal,
        async (pid) => {
          stopReference = { ...stopReference, clientPid: pid };
          await spec.saveStopReference?.(stopReference);
        },
      );
      stopReference = { ...stopReference, clientPid: r.pid, clientClosed: r.closed, stopped: r.stopped };
      await spec.saveStopReference?.(stopReference);
      if (!r.stopped)
        return {
          ok: false,
          error: "sandbox_stop_unconfirmed",
          message: "生成コンテナの停止を確認できません。自動再試行を止め、作業データを保持しました。",
          result: null,
          stopped: false,
          stopReference,
        };
      const result = await this.readResult(spec.workDir, executionId);
      if (r.registrationFailed)
        return {
          ok: false,
          error: "aborted",
          message: "実行情報を保存できなかったため中断しました",
          result: null,
          stopped: true,
          stopReference,
        };
      if (r.timedOut)
        return {
          ok: false,
          error: "timeout",
          message: `${spec.timeoutMs}msで停止を指示し、終了を確認しました`,
          result,
          stopped: true,
          stopReference,
        };
      if (r.aborted)
        return {
          ok: false,
          error: "aborted",
          message: "中断して終了を確認しました",
          result,
          stopped: true,
          stopReference,
        };
      if (result === null) {
        return {
          ok: false,
          error: "sandbox_error",
          message: `現在の実行と一致する結果ファイルがありません（終了コード ${r.code}）`,
          result,
          stopped: true,
          stopReference,
        };
      }
      if (!result.ok || r.code !== 0)
        return {
          ok: false,
          error: "sandbox_error",
          message: `隔離生成の実行に失敗しました（終了コード ${r.code}）`,
          result,
          stopped: true,
          stopReference,
        };
      return { ok: true, result, stopped: true, stopReference };
    } catch {
      if (!executing) stopReference = { ...stopReference, clientClosed: true, stopped: true };
      return {
        ok: false,
        error: executing ? "sandbox_stop_unconfirmed" : "sandbox_error",
        message: executing
          ? "生成の終了を確認できません。停止確認が済むまで再試行を停止します。"
          : "隔離生成を開始できません。設定と作業場所を確認してください。",
        result: null,
        stopped: !executing,
        stopReference,
      };
    }
  }

  recoverStop(reference: SandboxStopReference) {
    return recoverDockerExecution(this.config.dockerPath, this.env, reference);
  }

  private async readResult(workDir: string, executionId: string): Promise<SandboxResult | null> {
    try {
      const parsed = sandboxResultSchema.safeParse(
        JSON.parse(await readFile(path.join(workDir, SANDBOX_RESULT_FILE), "utf8")),
      );
      return parsed.success && parsed.data.executionId === executionId ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
