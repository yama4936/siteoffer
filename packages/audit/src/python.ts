import { spawn } from "node:child_process";

export interface PythonRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted?: boolean;
}

export interface PythonRunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 子プロセスに追加で渡す環境変数（PSI_API_KEY など、必要なものだけ） */
  extraEnv?: Record<string, string>;
}

/** スキルのPythonスクリプトの実行口。テストでは差し替えられる */
export interface PythonRunner {
  run(script: string, args: string[], opts: PythonRunOptions): Promise<PythonRunResult>;
}

const MAX_OUTPUT = 1_000_000;
/** 子プロセスへ引き継ぐ環境変数。APIキー等の秘密値を既定で渡さないため、許可リストにする */
const PASS_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SystemRoot", "TEMP", "TMP"];

/** 引数の組み立て。常に -I（隔離モード：PYTHONPATH・ユーザーsite・カレントディレクトリを読まない）で起動する */
export function pythonArgv(script: string, args: string[]): string[] {
  return ["-I", "-X", "utf8", script, ...args];
}

export function createPythonRunner(
  pythonBin = process.env.SITEOFFER_PYTHON_BIN?.trim() || (process.platform === "win32" ? "python" : "python3"),
): PythonRunner {
  return {
    run(script, args, opts) {
      return new Promise((resolve) => {
        if (opts.signal?.aborted) {
          resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: true });
          return;
        }
        const env: Record<string, string> = {};
        for (const k of PASS_ENV) {
          const v = process.env[k];
          if (v !== undefined) env[k] = v;
        }
        Object.assign(env, opts.extraEnv);
        const child = spawn(pythonBin, pythonArgv(script, args), {
          cwd: opts.cwd,
          windowsHide: true,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let aborted = false;
        child.stdout.setEncoding("utf8").on("data", (d: string) => {
          if (stdout.length < MAX_OUTPUT) stdout += d;
        });
        child.stderr.setEncoding("utf8").on("data", (d: string) => {
          if (stderr.length < MAX_OUTPUT) stderr += d;
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs);
        const cancel = () => {
          aborted = true;
          child.kill("SIGKILL");
        };
        opts.signal?.addEventListener("abort", cancel, { once: true });
        const done = (exitCode: number | null, error = "") => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", cancel);
          resolve({ exitCode, stdout, stderr: `${stderr}${error}`, timedOut, ...(aborted ? { aborted: true } : {}) });
        };
        child.on("error", (e) => done(null, e.message));
        child.on("close", (code) => done(code));
      });
    },
  };
}

export function tail(s: string, n = 500): string {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}
