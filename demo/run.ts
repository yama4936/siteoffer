/**
 * デモの一括起動（pnpm demo）。モックとローカルだけで動かす：
 *   デモ用DB（PGlite、マイグレーション込み）→ シード → web（3100）・プレビュー（3200）・ワーカー
 * Ctrl+C（SIGINT）・SIGTERM で全部止める。どれかが異常終了したときも全部止める。
 *
 * 外部へはアクセスしない：生成はモック、企業候補はフィクスチャ、診断は取得済みの collected.json、
 * 評価設定はデモ用の仮値（config/site-evaluation.demo.json）。実Codex・国税庁API・PSI・AWS・Dockerは使わない。
 * ルートの .env は読まない（実APIのキーを子プロセスへ渡さないため、該当の環境変数は空にする）。
 *
 *   pnpm demo           起動（データは .data/demo に残る）
 *   pnpm demo:reset     .data/demo を消してから起動（作り直し）
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { assertPlainDirectory } from "./backup/bundle.ts";
import { alive, readOwner } from "./backup/owner.ts";
import { DEMO_DATABASE_URL, DEMO_PATHS, DEMO_PORTS, REPO_ROOT } from "./paths.ts";
import { pnpmCommand } from "./pnpm-command.ts";
import { demoSearchEnv } from "./search-env.ts";
import { demoShareKey } from "./share-key.ts";

const realDiscovery = process.argv.includes("--real-discovery");
if (realDiscovery && existsSync(path.join(REPO_ROOT, ".env"))) process.loadEnvFile(path.join(REPO_ROOT, ".env"));
if (realDiscovery && !process.env.NTA_APPLICATION_ID?.trim())
  throw new Error("NTA_APPLICATION_ID を .env に設定してください。既存データは変更していません");

const reset = process.argv.includes("--reset");

interface Proc {
  name: string;
  child: ChildProcess;
  exited: Promise<number | null>;
}

const procs: Proc[] = [];
let shuttingDown = false;

function log(msg: string) {
  console.log(`[demo] ${msg}`);
}

/** 実APIのキー等を渡さない。デモで使う値だけを上書きする */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...demoSearchEnv(process.env, realDiscovery) };
  for (const k of [
    "SITEOFFER_SHARE_TOKEN_KEY",
    "NTA_APPLICATION_ID",
    "PSI_API_KEY",
    "OPENAI_API_KEY",
    "SITEOFFER_IMAGE_MODEL",
    "CODEX_API_KEY",
    "SITEOFFER_CODEX_AUTH_FILE",
    "SITEOFFER_CODEX_IMAGE",
    "SITEOFFER_CODEX_NETWORK",
    "SITEOFFER_CODEX_MODEL",
    "SITEOFFER_BACKUP_PASSPHRASE",
  ]) {
    // An empty value also prevents Next.js from reloading a real key from the root .env.
    env[k] = "";
  }
  if (realDiscovery) env.NTA_APPLICATION_ID = process.env.NTA_APPLICATION_ID;
  env.SITEOFFER_DEMO_MODE = realDiscovery ? "false" : "true";
  env.SITEOFFER_DISCOVERY_ONLY = realDiscovery ? "true" : "false";
  env.DATABASE_URL = DEMO_DATABASE_URL;
  env.SITEOFFER_BACKUP_DATA_ROOT = DEMO_PATHS.data;
  env.SITEOFFER_BACKUP_ROOT = DEMO_PATHS.backups;
  return env;
}

function start(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv): Proc {
  // 子プロセスはそれぞれ別のプロセスグループにする（pnpm・next の孫プロセスまでまとめて止めるため）
  // JS版のpnpmだけNodeへ渡し、スタンドアロン版のpnpm.exeは直接起動する。
  const invocation = cmd === "pnpm" ? pnpmCommand(args) : { command: cmd, args };
  const child = spawn(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
    env,
    stdio: name === "db" ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const prefix = (chunk: Buffer, out: NodeJS.WriteStream) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) out.write(`[${name}] ${line}\n`);
  };
  child.stdout?.on("data", (c: Buffer) => prefix(c, process.stdout));
  child.stderr?.on("data", (c: Buffer) => prefix(c, process.stderr));
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", (error) => {
      log(`${name} の起動に失敗：${error.message}`);
      resolve(1);
    });
  });
  const p = { name, child, exited };
  procs.push(p);
  if (name === "db")
    child.on("message", (message) => {
      if (message && typeof message === "object" && "type" in message && message.type === "siteoffer.stop.requested")
        void shutdown(0);
    });
  exited.then((code) => {
    if (!shuttingDown) {
      log(`${name} が終了した（終了コード ${code}）。全部止める`);
      void shutdown(1);
    }
  });
  return p;
}

function signalGroup(p: Proc, sig: NodeJS.Signals) {
  if (p.child.pid === undefined || p.child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(p.child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => p.child.kill());
    return;
  }
  try {
    process.kill(-p.child.pid, sig);
  } catch {
    // すでに止まっている
  }
}

async function stopProc(p: Proc, timeoutMs = 20_000) {
  if (p.child.pid === undefined || p.child.exitCode !== null || p.child.signalCode !== null) return;
  if (p.name === "db" && p.child.connected) p.child.send({ type: "siteoffer.stop" });
  else signalGroup(p, "SIGTERM");
  const timer = setTimeout(() => {
    log(`${p.name} が ${timeoutMs / 1000} 秒で止まらないため強制終了する`);
    signalGroup(p, "SIGKILL");
  }, timeoutMs);
  await p.exited;
  clearTimeout(timer);
}

async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("停止する（web・プレビュー・ワーカー → DB の順）");
  const db = procs.find((p) => p.name === "db");
  await Promise.all(procs.filter((p) => p !== db).map((p) => stopProc(p)));
  if (db) await stopProc(db);
  log("すべて停止した");
  process.exit(code);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

async function waitPort(port: number, what: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (shuttingDown) throw new Error("停止中");
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${what}（ポート ${port}）が ${timeoutMs / 1000} 秒以内に起動しなかった`);
}

function runOnce(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} が失敗した（終了コード ${code}）`)),
    );
  });
}

async function main() {
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown(0));

  for (const [port, what] of [
    [DEMO_PORTS.db, "DB"],
    [DEMO_PORTS.web, "web"],
    [DEMO_PORTS.preview, "プレビュー"],
  ] as const) {
    if (await portOpen(port)) {
      throw new Error(
        `ポート ${port}（${what}）が使用中。pnpm dev:db・pnpm dev（Docker）・別の pnpm demo を止めてから実行する`,
      );
    }
  }
  if (reset && process.env.DEMO_RESTORE_DIR)
    throw new Error("復元プロファイルはリセットしません。通常のデモで実行してください。");
  if (reset && existsSync(DEMO_PATHS.data)) {
    await assertPlainDirectory(DEMO_PATHS.data);
    try {
      const owner = await readOwner(DEMO_PATHS.data);
      if (alive(owner.pid)) throw new Error("このデータは稼働中です。正常停止してからリセットしてください。");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    log(`デモのデータ（${DEMO_PATHS.data}）を消して作り直す`);
    await rm(DEMO_PATHS.data, { recursive: true, force: true });
  }

  const env = baseEnv();
  const shareTokenKey = await demoShareKey(DEMO_PATHS.data);
  const node = process.execPath;

  start("db", node, ["--import", "tsx", "demo/db-server.ts"], env);
  await waitPort(DEMO_PORTS.db, "デモ用DB", process.platform === "win32" ? 600_000 : 120_000);
  await runOnce("seed", node, ["--import", "tsx", "demo/seed.ts"], env);

  // トンネル等で外から見せるときは、公開URLを DEMO_PUBLIC_PREVIEW_URL で渡す（web側は WEB_BASE_URL、
  // プレビューの埋め込み許可は PREVIEW_FRAME_ANCESTORS をそのまま引き継ぐ）
  const previewOrigin = process.env.DEMO_PUBLIC_PREVIEW_URL || `http://localhost:${DEMO_PORTS.preview}`;
  // DEMO_WEB_PROD=1 なら事前に作った本番ビルド（pnpm --filter @siteoffer/web build）を next start で動かす
  const webMode = process.env.DEMO_WEB_PROD === "1" ? "start" : "dev";
  start("preview", "pnpm", ["--filter", "@siteoffer/preview", "start"], {
    ...env,
    PREVIEW_PORT: String(DEMO_PORTS.preview),
    PREVIEW_HOST: "127.0.0.1",
    PREVIEW_ARTIFACT_BASE_DIR: DEMO_PATHS.artifacts,
  });
  start("worker", "pnpm", ["--filter", "@siteoffer/worker", "start"], {
    ...env,
    SITEOFFER_GENERATOR: "mock",
    SITEOFFER_DISCOVERY_PROVIDERS: realDiscovery ? "nta" : "fixture",
    SITEOFFER_AUDIT_COLLECTOR: "fixture",
    SITEOFFER_EVAL_CONFIG: DEMO_PATHS.evalConfig,
    SITEOFFER_GENERATION_INPUT: "fixture",
    // 記事を持つローカル案件も制作できる。明示された配信先は保持する。
    SITEOFFER_CONTENT_ORIGIN: env.SITEOFFER_CONTENT_ORIGIN?.trim() || `http://localhost:${DEMO_PORTS.web}`,
    // Astroのビルドを同時に走らせない（同時ビルドで失敗した例があった・メモリの節約）
    SITEOFFER_PROPOSAL_CONCURRENCY: "1",
    SITEOFFER_INTAKE_INTERVAL_MS: process.env.SITEOFFER_INTAKE_INTERVAL_MS ?? "3000",
    SITEOFFER_DEMO_ARTIFACT_DIR: DEMO_PATHS.demos,
    SITEOFFER_DELIVERY_ARTIFACT_DIR: DEMO_PATHS.deliveries,
    SITEOFFER_AUDIT_ARTIFACT_DIR: DEMO_PATHS.audits,
  });
  start(
    "web",
    "pnpm",
    [
      "--filter",
      "@siteoffer/web",
      "exec",
      "next",
      webMode,
      "--port",
      String(DEMO_PORTS.web),
      "--hostname",
      "127.0.0.1",
    ],
    {
      ...env,
      // 提案デモ・顧客確認のリンク先（プレビューは別オリジン）
      PREVIEW_ORIGIN: previewOrigin,
      PREVIEW_BASE_URL: previewOrigin,
      NEXT_TELEMETRY_DISABLED: "1",
      SITEOFFER_SHARE_TOKEN_KEY: shareTokenKey,
    },
  );

  await waitPort(DEMO_PORTS.preview, "プレビュー", 60_000);
  await waitPort(DEMO_PORTS.web, "web", 180_000);
  log(
    [
      realDiscovery ? "起動した（国税庁の実収集のみ。サイト診断・制作は停止）" : "起動した（モック・ローカルのみ）",
      `  ログイン：http://localhost:${DEMO_PORTS.web}/login`,
      "  デモ用アカウント：別の端末で pnpm demo:users",
      `  プレビュー：${previewOrigin}（共有リンクからだけ閲覧できる。/ は404が正常）`,
      "  手順：demo/README.md。止めるときは Ctrl+C",
    ].join("\n"),
  );
}

main().catch((e: unknown) => {
  console.error(`[demo] 起動できなかった：${(e as Error).message}`);
  void shutdown(1).then(() => process.exit(1));
  if (procs.length === 0) process.exit(1);
});
