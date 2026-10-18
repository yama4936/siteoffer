import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDockerClientEnv,
  buildDockerRunArgs,
  DEFAULT_DOCKER_SANDBOX_CONFIG,
  type DockerSandboxConfig,
  DockerSandboxRunner,
} from "../src/sandbox/docker.ts";

const config: DockerSandboxConfig = {
  ...DEFAULT_DOCKER_SANDBOX_CONFIG,
  image: "siteoffer-codex:test",
  network: "siteoffer-codex-egress",
  codexAuthFile: "/srv/codex/auth.json",
};
const spec = { jobId: "job-1", workDir: "/tmp/siteoffer-gen/job-1", timeoutMs: 60_000 };

const SECRET_ENV = {
  DATABASE_URL: "postgres://user:secret-db-pass@db/siteoffer",
  OPENAI_API_KEY: "sk-test-secret-value",
  CODEX_API_KEY: "codex-secret-value",
  SESSION_SECRET: "session-secret-value",
  AWS_SECRET_ACCESS_KEY: "aws-secret-value",
  PATH: "/usr/bin",
  DOCKER_HOST: "unix:///var/run/docker.sock",
};

function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));
}

describe("DockerSandboxRunner の引数", () => {
  const args = buildDockerRunArgs(config, spec);

  it("使い捨て・資源の上限・権限の制限が入る", () => {
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toContain("--read-only");
    expect(flagValues(args, "--network")).toEqual(["siteoffer-codex-egress"]);
    expect(flagValues(args, "--cpus")).toEqual(["1"]);
    expect(flagValues(args, "--memory")).toEqual(["2048m"]);
    expect(flagValues(args, "--memory-swap")).toEqual(["2048m"]);
    expect(flagValues(args, "--pids-limit")).toEqual(["256"]);
    expect(flagValues(args, "--cap-drop")).toEqual(["ALL"]);
    expect(flagValues(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(flagValues(args, "--name")).toEqual(["siteoffer-gen-job-1"]);
  });

  it("マウントは作業ディレクトリと読み取り専用の認証ファイルだけ", () => {
    const mounts = flagValues(args, "--mount");
    expect(mounts).toEqual([
      "type=bind,source=/tmp/siteoffer-gen/job-1,target=/work",
      "type=bind,source=/srv/codex/auth.json,target=/run/siteoffer-auth.json,readonly",
    ]);
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    expect(args.some((a) => a.includes("docker.sock"))).toBe(false);
  });

  it("環境変数は値を明示したものだけで、秘密の値が入らない", () => {
    const envs = flagValues(args, "--env");
    expect(envs.every((e) => /^[A-Z_]+=/.test(e))).toBe(true);
    expect(envs.map((e) => e.split("=")[0]).sort()).toEqual([
      "CODEX_HOME",
      "HOME",
      "SITEOFFER_CODEX_AUTH_SOURCE",
      "SITEOFFER_SANDBOX",
      "SITEOFFER_TIMEOUT_MS",
    ]);
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--env-file");
    const joined = args.join(" ");
    for (const [k, v] of Object.entries(SECRET_ENV)) {
      if (k === "PATH" || k === "DOCKER_HOST") continue;
      expect(joined).not.toContain(k);
      expect(joined).not.toContain(v);
    }
  });

  it("dockerクライアントにもアプリの秘密値を渡さない", () => {
    const env = buildDockerClientEnv(SECRET_ENV);
    expect(env).toEqual({ PATH: "/usr/bin", DOCKER_HOST: "unix:///var/run/docker.sock" });
  });
  it("native absolute paths with spaces and Japanese characters remain a single --mount value", () => {
    const workDir = path.resolve("temporary work", "制作確認"),
      authFile = path.resolve("temporary auth", "auth.json");
    const args = buildDockerRunArgs({ ...config, codexAuthFile: authFile }, { ...spec, workDir });
    expect(flagValues(args, "--mount")).toEqual([
      `type=bind,source=${workDir},target=/work`,
      `type=bind,source=${authFile},target=/run/siteoffer-auth.json,readonly`,
    ]);
    for (const source of [path.resolve("bad,name"), path.resolve('bad"name'), path.resolve("bad\nname")])
      expect(() => buildDockerRunArgs(config, { ...spec, workDir: source })).toThrow();
  });
  it("forwards Windows Docker client directories without forwarding app credentials into either environment", () => {
    const env = buildDockerClientEnv({
      ...SECRET_ENV,
      USERPROFILE: "C:\\Users\\test",
      SystemRoot: "C:\\Windows",
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
      TEMP: "C:\\Temp",
    });
    expect(env).toMatchObject({ USERPROFILE: "C:\\Users\\test", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(
      flagValues(buildDockerRunArgs(config, spec), "--env").some(
        (value) => value.startsWith("USERPROFILE=") || value.startsWith("APPDATA="),
      ),
    ).toBe(false);
  });

  it("host ネットワーク・相対パス・区切り文字を含むパス・不正なジョブIDを拒否する", () => {
    expect(() => buildDockerRunArgs({ ...config, user: "codex" }, spec)).toThrow();
    expect(() => buildDockerRunArgs({ ...config, network: "host" }, spec)).toThrow();
    expect(() => buildDockerRunArgs(config, { ...spec, workDir: "rel/dir" })).toThrow();
    expect(() => buildDockerRunArgs(config, { ...spec, workDir: "/tmp/a,source=/etc" })).toThrow();
    expect(() => buildDockerRunArgs(config, { ...spec, jobId: "../x" })).toThrow();
  });

  it("Codexの一時ホームは実行ユーザーだけが書き込める", () => {
    const args = buildDockerRunArgs({ ...config, user: "501:20" }, spec);
    expect(flagValues(args, "--tmpfs")).toContain("/home/codex/.codex:rw,nosuid,size=256m,uid=501,gid=20,mode=0700");
  });
});

it("開始前に中断済みなら作業ファイルもDockerプロセスも作らない", async () => {
  const runner = new DockerSandboxRunner({ ...config, dockerPath: "must-not-start" });
  expect(
    await runner.run({
      ...spec,
      workDir: "/does-not-exist/cancelled",
      signal: AbortSignal.abort(),
      request: {} as never,
    }),
  ).toMatchObject({ ok: false, error: "aborted", result: null });
});
