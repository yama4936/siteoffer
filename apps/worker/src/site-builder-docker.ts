import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  SITE_BUILD_REQUEST,
  SITE_BUILD_RESULT,
  type SiteImage,
  type SiteInput,
  type SiteMode,
  siteBuildResultSchema,
  validateSiteInput,
} from "@siteoffer/astro-site";
import { buildDockerClientEnv } from "@siteoffer/generation";
import type { SiteBuilder, SiteBuildOutcome } from "./site-builder.ts";
import { runSiteContainer } from "./site-docker-process.ts";

export interface DockerSiteBuilderConfig {
  image: string;
  dockerPath?: string;
  timeoutMs?: number;
  user?: string;
}
export const DEFAULT_SITE_BUILD_IMAGE = "siteoffer-site:local";
export const DEFAULT_SITE_BUILD_TIMEOUT_MS = 180_000;
function mountPath(value: string) {
  if (
    !path.isAbsolute(value) ||
    /[,"]/.test(value) ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32) ||
    (value.includes(":") && !/^[a-z]:[\\/][^:]*$/i.test(value))
  )
    throw new Error("ビルドの作業ディレクトリを確認してください");
}
export function siteBuildUserValid(user: string) {
  return /^[1-9][0-9]{0,9}:[0-9]{1,10}$/.test(user) && user.split(":").every((value) => Number(value) <= 2147483647);
}
export function siteBuildDockerArgs(image: string, stage: string, id: string, user = "1000:1000"): string[] {
  mountPath(stage);
  if (!/^[a-z0-9][a-z0-9./_:@-]{0,254}$/i.test(image) || !/^[a-f0-9-]{36}$/i.test(id))
    throw new Error("ビルド用イメージと実行IDを確認してください");
  if (!siteBuildUserValid(user)) throw new Error("ビルドは非rootの数値UID:GIDで実行してください");
  const [uid, gid] = user.split(":");
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--init",
    "--name",
    `siteoffer-site-${id}`,
    "--label",
    `siteoffer.site-build=${id}`,
    "--network",
    "none",
    "--cpus",
    "1",
    "--memory",
    "2048m",
    "--memory-swap",
    "2048m",
    "--pids-limit",
    "256",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    user,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=256m,uid=${uid},gid=${gid}`,
    "--tmpfs",
    `/app/templates/astro-site/.astro:rw,nosuid,size=64m,uid=${uid},gid=${gid}`,
    "--mount",
    `type=bind,source=${stage},target=/work`,
    "--workdir",
    "/work",
    "--env",
    "SITEOFFER_SITE_SANDBOX=1",
    "--env",
    "HOME=/tmp",
    "--env",
    "ASTRO_TELEMETRY_DISABLED=1",
    image,
    "node",
    "/app/templates/astro-site/build/container-entry.ts",
  ];
}
function inside(child: string, parent: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function images(input: SiteInput): SiteImage[] {
  return [
    input.company.logo,
    input.hero.image,
    ...(input.services?.items.map((i) => i.image) ?? []),
    ...(input.works?.items.map((i) => i.image) ?? []),
  ].filter((i): i is SiteImage => !!i);
}
async function stageInput(input: SiteInput, workDir: string, stage: string) {
  const selected = images(input);
  if (selected.length > 32) throw new Error("ビルドの画像点数が上限を超えています");
  let total = 0;
  if (selected.length) await mkdir(path.join(stage, "assets"));
  for (const [index, image] of selected.entries()) {
    const source = await realpath(path.resolve(workDir, image.src));
    if (!inside(source, workDir)) throw new Error("画像はこのビルドの作業ディレクトリ内に置いてください");
    const info = await stat(source);
    total += info.size;
    if (!info.isFile() || info.size > 12 * 1024 * 1024 || total > 64 * 1024 * 1024)
      throw new Error("ビルドの画像サイズが上限を超えています");
    const header = Buffer.alloc(12),
      handle = await open(source, "r");
    try {
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }
    const extension = path.extname(source).toLowerCase();
    const valid =
      extension === ".png"
        ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : [".jpg", ".jpeg"].includes(extension)
          ? header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
          : extension === ".webp" &&
            header.toString("ascii", 0, 4) === "RIFF" &&
            header.toString("ascii", 8, 12) === "WEBP";
    if (!valid) throw new Error("掲載画像の形式を確認してください");
    const name = `asset-${index + 1}${path.extname(source).toLowerCase()}`;
    await copyFile(source, path.join(stage, "assets", name));
    image.src = `assets/${name}`;
  }
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json) > 1024 * 1024) throw new Error("ビルド入力が1MBを超えています");
  await writeFile(path.join(stage, "site.json"), json);
}
async function verifyOutput(directory: string) {
  let count = 0,
    size = 0;
  async function walk(folder: string, depth = 0) {
    if (depth > 16) throw new Error("ビルド成果物の階層が上限を超えています");
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      count++;
      if (count > 500) throw new Error("ビルド成果物の点数が上限を超えています");
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error("ビルド成果物にリンクファイルが含まれています");
      if (entry.isDirectory()) await walk(file, depth + 1);
      else {
        const info = await stat(file);
        size += info.size;
        if (!info.isFile() || count > 500 || size > 128 * 1024 * 1024)
          throw new Error("ビルド成果物が上限を超えています");
      }
    }
  }
  await walk(directory);
  const index = await stat(path.join(directory, "index.html"));
  if (!index.isFile()) throw new Error("トップページを確認できません");
}
const failure = (reason: string, message: string, retryable = false): SiteBuildOutcome => ({
  ok: false,
  reason,
  message,
  retryable,
});

export function createDockerSiteBuilder(
  config: DockerSiteBuilderConfig,
  environment: NodeJS.ProcessEnv = process.env,
): SiteBuilder {
  const timeoutMs = config.timeoutMs ?? DEFAULT_SITE_BUILD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000)
    throw new Error("ビルドの制限時間は1000〜900000msです");
  const env = buildDockerClientEnv(environment),
    dockerPath = config.dockerPath ?? "docker";
  const user = config.user ?? `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  if (!siteBuildUserValid(user)) throw new Error("ビルドは非rootの数値UID:GIDで実行してください");
  async function build(mode: SiteMode, request: Parameters<SiteBuilder["buildDemo"]>[0]): Promise<SiteBuildOutcome> {
    if (request.signal?.aborted) return failure("aborted", "ビルドを中断しました");
    let stage: string | undefined,
      workDir: string | undefined,
      stopped = true;
    let runningName: string | undefined;
    try {
      mountPath(request.workDir);
      const parsed = validateSiteInput(request.siteInput);
      if (!parsed.ok) return failure("invalid-input", "サイトの構成を確認してください");
      await mkdir(request.workDir, { recursive: true });
      workDir = await realpath(request.workDir);
      mountPath(workDir);
      const id = randomUUID();
      stage = await mkdtemp(path.join(workDir, `.site-build-${id}-`));
      const args = siteBuildDockerArgs(config.image, stage, id, user);
      await stageInput(structuredClone(parsed.input), workDir, stage);
      await writeFile(
        path.join(stage, SITE_BUILD_REQUEST),
        JSON.stringify({ executionId: id, mode, timeoutMs: Math.max(1000, timeoutMs - 15_000) }),
      );
      runningName = `siteoffer-site-${id}`;
      stopped = false;
      const run = await runSiteContainer(dockerPath, args, `siteoffer-site-${id}`, env, timeoutMs, request.signal);
      stopped = run.stopped;
      if (!stopped)
        return failure(
          "container-stop-failed",
          `ビルドの停止を確認できません。Dockerの siteoffer-site-${id} を確認してください`,
        );
      if (run.aborted) return failure("aborted", "ビルドを中断しました");
      if (run.timedOut) return failure("timeout", "ビルドが制限時間を超えました", true);
      const resultFile = path.join(stage, SITE_BUILD_RESULT);
      const meta = await lstat(resultFile).catch(() => null);
      if (!meta?.isFile() || meta.size > 64 * 1024)
        return failure("container-failed", "ビルド結果を取得できません。Dockerとビルド用イメージを確認してください");
      const receipt = siteBuildResultSchema.safeParse(JSON.parse(await readFile(resultFile, "utf8")));
      if (!receipt.success || receipt.data.executionId !== id)
        return failure("invalid-result", "現在のビルドと一致する結果を確認できません");
      const result = receipt.data;
      if (!result.ok || run.code !== 0)
        return {
          ok: false,
          reason: result.reason ?? "container-failed",
          message: "サイトのビルド・検査に失敗しました。構成と素材を確認してください",
          retryable: result.reason === "astro-build-failed",
          ...(result.check ? { check: result.check } : {}),
        };
      if (!result.check?.ok || result.check.errors.length || !result.check.pages.includes("index.html"))
        return failure("invalid-result", "ビルド検査の結果を確認できません");
      if (request.signal?.aborted) return failure("aborted", "ビルドを中断しました");
      const source = path.join(stage, "dist");
      await verifyOutput(source);
      if (request.signal?.aborted) return failure("aborted", "ビルドを中断しました");
      const distDir = path.join(workDir, `dist-${id}`);
      await rename(source, distDir);
      if (request.signal?.aborted) return failure("aborted", "ビルドを中断しました");
      return { ok: true, distDir, check: result.check };
    } catch {
      if (!stopped)
        return failure(
          "container-stop-failed",
          `ビルドの停止を確認できません。Dockerの ${runningName ?? "ビルド用コンテナ"} を確認してください`,
        );
      return failure("build-input-error", "ビルド入力・画像のパスとサイズ、作業ディレクトリを確認してください");
    } finally {
      if (
        stage &&
        workDir &&
        stopped &&
        path.dirname(path.resolve(stage)) === path.resolve(workDir) &&
        path.basename(stage).startsWith(".site-build-")
      )
        await rm(stage, { recursive: true, force: true });
    }
  }
  return {
    kind: "docker",
    buildDemo: (input) => build("demo", input),
    buildDelivery: (input) => build("delivery", input),
  };
}
