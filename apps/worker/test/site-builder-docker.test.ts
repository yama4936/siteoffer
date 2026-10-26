import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { siteGenerationToSiteInput } from "@siteoffer/astro-site";
import { loadCodexFixture } from "@siteoffer/generation";
import type { SiteGenerationOutput } from "@siteoffer/schemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/site-docker-process.ts", () => ({ runSiteContainer: mock.run }));

import { createDockerSiteBuilder, siteBuildDockerArgs } from "../src/site-builder-docker.ts";

let root: string, workDir: string, mode: "ok" | "stale" | "nonzero" | "unsafe-output" | "missing-index" | "stop-failed";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUyNvCwMDAxMDAwMDAAAAOrgFGyLjQ8AAAAABJRU5ErkJggg==",
  "base64",
);
const input = () => siteGenerationToSiteInput(loadCodexFixture("demo_site") as SiteGenerationOutput);
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "siteoffer-site-builder-"));
  workDir = path.join(root, "作業 files");
  await mkdir(workDir);
  mode = "ok";
  mock.run.mockReset().mockImplementation(async (_dockerPath: string, args: string[]) => {
    const mount = args[args.indexOf("--mount") + 1]!;
    const stage = mount.slice("type=bind,source=".length, -",target=/work".length);
    const request = JSON.parse(await readFile(path.join(stage, "build-request.json"), "utf8"));
    await mkdir(path.join(stage, "dist"));
    if (mode !== "missing-index")
      await writeFile(path.join(stage, "dist/index.html"), "<!doctype html><title>test fixture</title>");
    if (mode === "unsafe-output") await symlink(root, path.join(stage, "dist/escape"), "junction");
    await writeFile(
      path.join(stage, "build-result.json"),
      JSON.stringify({
        executionId: mode === "stale" ? "11111111-1111-4111-8111-111111111111" : request.executionId,
        ok: true,
        reason: null,
        check: { ok: true, pages: ["index.html"], counts: {}, errors: [], mobile: "skipped" },
      }),
    );
    return { code: mode === "nonzero" ? 42 : 0, stopped: mode !== "stop-failed", aborted: false, timedOut: false };
  });
});
afterEach(async () => {
  const resolved = path.resolve(root);
  if (
    !resolved.startsWith(path.resolve(tmpdir()) + path.sep) ||
    !path.basename(resolved).startsWith("siteoffer-site-builder-")
  )
    throw new Error("Unexpected test directory");
  await rm(resolved, { recursive: true, force: true });
});
it("publishes concurrent builds to different directories and never overwrites an older site", async () => {
  const builder = createDockerSiteBuilder({ image: "test-only" }, {});
  const results = await Promise.all([
    builder.buildDemo({ siteInput: input(), workDir }),
    builder.buildDelivery({ siteInput: input(), workDir }),
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  const dirs = results.map((r) => (r.ok ? r.distDir : ""));
  expect(new Set(dirs).size).toBe(2);
  for (const dir of dirs) expect(await readFile(path.join(dir, "index.html"), "utf8")).toContain("test fixture");
  expect((await readdir(workDir)).filter((n) => n.startsWith(".site-build-"))).toEqual([]);
});
it("stages only selected safe images and JSON, with no unrelated job files or application secrets", async () => {
  await writeFile(path.join(workDir, "photo.png"), png);
  await writeFile(path.join(workDir, "private.txt"), "unrelated fixture");
  const site = input();
  site.hero.image = { src: "photo.png", alt: "架空画像" };
  const simulate = mock.run.getMockImplementation()!;
  mock.run.mockImplementationOnce(async (...args) => {
    const argv = args[1] as string[];
    const mount = argv[argv.indexOf("--mount") + 1]!;
    const stage = mount.slice("type=bind,source=".length, -",target=/work".length);
    expect((await readdir(stage)).sort()).toEqual(["assets", "build-request.json", "site.json"]);
    const staged = JSON.parse(await readFile(path.join(stage, "site.json"), "utf8"));
    expect(await readFile(path.join(stage, staged.hero.image.src))).toEqual(png);
    return simulate(...args);
  });
  const result = await createDockerSiteBuilder(
    { image: "test-only" },
    { DATABASE_URL: "test-only", OPENAI_API_KEY: "test-only", USERPROFILE: "test-user-profile" },
  ).buildDemo({ siteInput: site, workDir });
  expect(result.ok).toBe(true);
  expect(site.hero.image.src).toBe("photo.png");
  const call = mock.run.mock.calls[0]!;
  expect(call[3]).toEqual({ USERPROFILE: "test-user-profile" });
  const args = call[1] as string[];
  expect(args.filter((a) => a === "--mount")).toHaveLength(1);
  expect(args).toContain("none");
  expect(args).not.toContain("/run/siteoffer-auth.json");
  expect(args).not.toContain("--privileged");
  expect(args).toContain("--read-only");
  expect(args).toContain("never");
  expect(args.join(" ")).not.toContain("DATABASE_URL");
});
it.each(["stale", "nonzero", "unsafe-output", "missing-index"] as const)(
  "rejects %s results instead of publishing",
  async (value) => {
    mode = value;
    expect(
      (await createDockerSiteBuilder({ image: "test-only" }, {}).buildDemo({ siteInput: input(), workDir })).ok,
    ).toBe(false);
    expect(await readdir(workDir)).toEqual([]);
  },
);
it("keeps a possibly mounted staging directory and stops retries when Docker cleanup cannot be confirmed", async () => {
  mode = "stop-failed";
  const result = await createDockerSiteBuilder({ image: "test-only" }, {}).buildDemo({ siteInput: input(), workDir });
  expect(result).toMatchObject({ ok: false, reason: "container-stop-failed", retryable: false });
  expect((await readdir(workDir)).filter((n) => n.startsWith(".site-build-"))).toHaveLength(1);
});
it("does not start a container for an already cancelled build, bad image format, or a directory escape", async () => {
  const controller = new AbortController();
  controller.abort();
  const builder = createDockerSiteBuilder({ image: "test-only" }, {});
  expect(await builder.buildDemo({ siteInput: input(), workDir, signal: controller.signal })).toMatchObject({
    ok: false,
    reason: "aborted",
  });
  await writeFile(path.join(workDir, "data.json"), "{}");
  const invalid = input();
  invalid.hero.image = { src: "data.json", alt: "not an image" };
  expect((await builder.buildDemo({ siteInput: invalid, workDir })).ok).toBe(false);
  await mkdir(path.join(root, "outside"));
  await writeFile(path.join(root, "outside/photo.png"), png);
  await symlink(path.join(root, "outside"), path.join(workDir, "linked"), "junction");
  const escaped = input();
  escaped.hero.image = { src: "linked/photo.png", alt: "outside" };
  expect((await builder.buildDemo({ siteInput: escaped, workDir })).ok).toBe(false);
  expect(mock.run).not.toHaveBeenCalled();
});
it("rejects mount syntax and unsafe images but accepts native Windows paths with spaces", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(siteBuildDockerArgs("test-only", workDir, id)).toContain(`type=bind,source=${workDir},target=/work`);
  for (const value of ["relative", `${workDir},readonly`, `${workDir}"`, `${workDir}\n`])
    expect(() => siteBuildDockerArgs("test-only", value, id)).toThrow();
  expect(() => siteBuildDockerArgs("--privileged", workDir, id)).toThrow();
  expect(() => siteBuildDockerArgs("test-only", workDir, id, "0:0")).toThrow();
  expect(() => siteBuildDockerArgs("test-only", workDir, id, "nobody")).toThrow();
  expect(siteBuildDockerArgs("test-only", workDir, id, "501:20")).toContain(
    "/tmp:rw,noexec,nosuid,size=256m,uid=501,gid=20",
  );
});
it("locks exactly the template's published production dependencies", async () => {
  const runtime = JSON.parse(
    await readFile(new URL("../../../templates/astro-site/runtime/package.json", import.meta.url), "utf8"),
  );
  const template = JSON.parse(
    await readFile(new URL("../../../templates/astro-site/package.json", import.meta.url), "utf8"),
  );
  expect(runtime.dependencies).toEqual(template.dependencies);
});
