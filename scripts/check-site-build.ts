import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDockerSiteBuilder, DEFAULT_SITE_BUILD_IMAGE } from "../apps/worker/src/site-builder-docker.ts";
import type { SiteGenerationOutput } from "../templates/astro-site/schema/site-generation.ts";
import { siteGenerationToSiteInput } from "../templates/astro-site/schema/site-generation.ts";

// Explicit offline check. This never connects to a database or a model and never publishes a site.
const root = await mkdtemp(path.join(tmpdir(), "siteoffer-site-check-"));
try {
  const workDir = path.join(root, "架空 site inputs");
  await mkdir(workDir);
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/codex/demo_site.json", import.meta.url), "utf8"),
  ) as SiteGenerationOutput;
  const input = siteGenerationToSiteInput(fixture);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUyNvCwMDAxMDAwMDAAAAOrgFGyLjQ8AAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(path.join(workDir, "fixture.png"), png);
  input.hero.image = { src: "fixture.png", alt: "架空の検査用画像" };
  const builder = createDockerSiteBuilder({
    image: process.env.SITEOFFER_SITE_BUILD_IMAGE || DEFAULT_SITE_BUILD_IMAGE,
  });
  const [demo, delivery] = await Promise.all([
    builder.buildDemo({ siteInput: input, workDir }),
    builder.buildDelivery({ siteInput: input, workDir }),
  ]);
  assert(demo.ok, JSON.stringify(demo));
  assert(delivery.ok, JSON.stringify(delivery));
  assert.notEqual(demo.distDir, delivery.distDir);
  assert((await readFile(path.join(demo.distDir, "index.html"), "utf8")).includes("非公式"));
  assert(!(await readFile(path.join(delivery.distDir, "index.html"), "utf8")).includes("data-demo-notice"));
  assert.deepEqual(await readFile(path.join(demo.distDir, "images/01-asset-1.png")), png);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await builder.buildDemo({ siteInput: input, workDir, signal: controller.signal })).ok, false);
  const timed = await createDockerSiteBuilder({
    image: process.env.SITEOFFER_SITE_BUILD_IMAGE || DEFAULT_SITE_BUILD_IMAGE,
    timeoutMs: 1000,
  }).buildDemo({ siteInput: input, workDir });
  assert(timed.ok || timed.reason === "timeout", JSON.stringify(timed));
  console.log(
    JSON.stringify({
      ok: true,
      mode: "offline-real-docker",
      network: "none",
      realModelCall: false,
      demo: true,
      delivery: true,
      distinctOutputDirectories: true,
      preCancelled: true,
      deadline: timed.ok ? "completed-within-limit" : "timeout-verified",
      mobile: "skipped",
    }),
  );
} finally {
  const resolved = path.resolve(root);
  assert(
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith("siteoffer-site-check-"),
  );
  // Keep diagnostic data if a container's stop could not be established; never remove its mount from underneath it.
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(path.join(root, "架空 site inputs")).catch(() => []);
  if (!names.some((n) => n.startsWith(".site-build-"))) await rm(resolved, { recursive: true, force: true });
}
