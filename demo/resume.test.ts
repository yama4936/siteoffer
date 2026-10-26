import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertResumeProfile } from "./resume.ts";

let root: string | undefined;
afterEach(async () => {
  if (!root) return;
  const resolved = path.resolve(root);
  expect(path.dirname(resolved)).toBe(path.resolve(tmpdir()));
  expect(path.basename(resolved)).toMatch(/^siteoffer-resume-/);
  await rm(resolved, { recursive: true, force: true });
});
async function profile() {
  root = await mkdtemp(path.join(tmpdir(), "siteoffer-resume-"));
  const paths = { data: root, pglite: path.join(root, "pglite") };
  await mkdir(paths.pglite);
  return paths;
}
it("accepts an existing database and key without requiring a saved password list", async () => {
  const paths = await profile();
  await writeFile(path.join(paths.pglite, "PG_VERSION"), "test-only");
  await writeFile(path.join(paths.data, "share-token-key"), "test-only");
  await expect(assertResumeProfile(paths)).resolves.toBeUndefined();
});
it("refuses an empty database or missing recovery key without creating either file", async () => {
  const paths = await profile();
  await expect(assertResumeProfile(paths)).rejects.toThrow("初期化はしていません");
  await writeFile(path.join(paths.pglite, "PG_VERSION"), "test-only");
  await expect(assertResumeProfile(paths)).rejects.toThrow("初期化はしていません");
});
it("explains a missing profile without creating a replacement directory", async () => {
  const paths = await profile();
  const missing = path.join(paths.data, "missing");
  await expect(assertResumeProfile({ data: missing, pglite: path.join(missing, "pglite") })).rejects.toThrow(
    "初期化はしていません",
  );
  expect(existsSync(missing)).toBe(false);
});
