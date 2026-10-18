import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { buildSite } from "../build/build-site.ts";

let work: string | undefined;
afterAll(async () => {
  if (!work) return;
  expect(path.dirname(path.resolve(work))).toBe(path.resolve(tmpdir()));
  expect(path.basename(work)).toMatch(/^siteoffer-parallel-test-/);
  await rm(work, { recursive: true, force: true });
});
it("builds different sites concurrently outside the template without mixing or deleting their prerender bundles", async () => {
  work = await mkdtemp(path.join(tmpdir(), "siteoffer-parallel-test-"));
  const inputs = ["full", "no-works"].map((name) =>
    fileURLToPath(new URL(`../fixtures/${name}/site.json`, import.meta.url)),
  );
  const results = await Promise.all(
    inputs.map((inputPath, i) => buildSite({ inputPath, outDir: path.join(work!, String(i)), env: {} })),
  );
  for (const [i, result] of results.entries()) {
    if (!result.ok) throw Error(`${result.reason}: ${result.message}\n${result.log ?? ""}`);
    const source = JSON.parse(await readFile(inputs[i]!, "utf8")) as { company: { name: string } };
    const html = await readFile(path.join(result.outDir, "index.html"), "utf8");
    expect(html).toContain(source.company.name);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html.includes('data-demo-notice="top"')).toBe(i === 0);
    expect(result.mode).toBe(i === 0 ? "demo" : "delivery");
  }
}, 120_000);
