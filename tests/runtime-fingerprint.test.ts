import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runtimeBuildOptions, runtimeBuildPlans } from "../scripts/build-runtime-images.ts";
import {
  RUNTIME_KIND_LABEL,
  RUNTIME_SOURCE_LABEL,
  RUNTIME_SOURCES,
  runtimeLabelsMatch,
  runtimeSourceFingerprint,
} from "../scripts/runtime-fingerprint.ts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "siteoffer-runtime-source-"));
  for (const source of new Set([...RUNTIME_SOURCES.codex, ...RUNTIME_SOURCES.site])) {
    if (path.extname(source)) {
      await mkdir(path.dirname(path.join(root, source)), { recursive: true });
      await writeFile(path.join(root, source), `source:${source}`);
    } else {
      await mkdir(path.join(root, source), { recursive: true });
      await writeFile(path.join(root, source, "fixture.ts"), `source:${source}`);
    }
  }
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("detects a changed template even when the image tag is unchanged, without invalidating the generator", async () => {
  const beforeSite = await runtimeSourceFingerprint("site", root);
  const beforeCodex = await runtimeSourceFingerprint("codex", root);
  const css = path.join(root, "templates/astro-site/src/changed.css");
  await writeFile(css, "body { color: #123456; }");
  expect(await runtimeSourceFingerprint("site", root)).not.toBe(beforeSite);
  expect(await runtimeSourceFingerprint("codex", root)).toBe(beforeCodex);
  await rm(css);
  expect(await runtimeSourceFingerprint("site", root)).toBe(beforeSite);
});
it("includes dependency locks and the Docker build definition but does not read unrelated app data", async () => {
  const before = await runtimeSourceFingerprint("codex", root);
  const lock = path.join(root, "packages/generation/src/sandbox/runtime/package-lock.json");
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, '{"fixture":true}');
  expect(await runtimeSourceFingerprint("codex", root)).not.toBe(before);
  await rm(lock);
  const unrelated = path.join(root, ".data");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "auth.json"), "private fixture must not be read");
  expect(await runtimeSourceFingerprint("codex", root)).toBe(before);
  const dockerfile = path.join(root, "Dockerfile.codex");
  await writeFile(dockerfile, "changed Docker definition");
  expect(await runtimeSourceFingerprint("codex", root)).not.toBe(before);
  await writeFile(dockerfile, "source:Dockerfile.codex");
});
it("matches across Windows line endings and ignores files excluded from the Docker context", async () => {
  const file = path.join(root, "templates/astro-site/src/fixture.ts");
  const before = await runtimeSourceFingerprint("site", root);
  await writeFile(file, "source:templates/astro-site/src\r\nsecond line\r\n");
  const windows = await runtimeSourceFingerprint("site", root);
  await writeFile(file, "source:templates/astro-site/src\nsecond line\n");
  expect(await runtimeSourceFingerprint("site", root)).toBe(windows);
  await writeFile(file, "source:templates/astro-site/src");
  const privateFile = path.join(root, "templates/astro-site/src/auth.json");
  await writeFile(privateFile, "must not be included");
  expect(await runtimeSourceFingerprint("site", root)).toBe(before);
  await rm(privateFile);
});
it("accepts only the current fingerprint for the intended runtime, including previously unstamped images", () => {
  const sha = "a".repeat(64);
  const labels = { [RUNTIME_SOURCE_LABEL]: sha, [RUNTIME_KIND_LABEL]: "site" };
  expect(runtimeLabelsMatch(labels, "site", sha)).toBe(true);
  expect(runtimeLabelsMatch(labels, "codex", sha)).toBe(false);
  expect(runtimeLabelsMatch(labels, "site", "b".repeat(64))).toBe(false);
  for (const value of [null, [], {}, "private error"]) expect(runtimeLabelsMatch(value, "site", sha)).toBe(false);
  expect(runtimeLabelsMatch(labels, "site", "invalid")).toBe(false);
});
it("builds only the requested runtime and passes its computed source hash as a literal argument", async () => {
  const options = runtimeBuildOptions(["--kind", "site", "--site-tag", "siteoffer-site:qa-test"]);
  const plans = await runtimeBuildPlans(options, root);
  expect(plans).toHaveLength(1);
  expect(plans[0]?.kind).toBe("site");
  expect(plans[0]?.tag).toBe("siteoffer-site:qa-test");
  expect(plans[0]?.args).toContain(`SITEOFFER_SOURCE_SHA256=${await runtimeSourceFingerprint("site", root)}`);
  expect(plans[0]?.args).toContain("--pull=false");
  expect((await runtimeBuildPlans(runtimeBuildOptions([]), root)).map((plan) => plan.kind)).toEqual(["codex", "site"]);
});
it.each(
  [
    ["--kind", "other"],
    ["--site-tag", "-option"],
    ["--site-tag", "bad\nvalue"],
    ["--site-tag", "x;command"],
    ["--site-tag"],
    ["--unknown", "value"],
    ["--kind", "site", "--kind", "codex"],
  ].map((args) => ({ args })),
)("rejects invalid or ambiguous build options: %j", ({ args }) => {
  expect(() => runtimeBuildOptions(args)).toThrow();
});
