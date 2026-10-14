/**
 * パイプラインを、デモの実ビルド（templates/astro-site の astro build ＋ checkDist）まで通す。
 * Astroのビルドは時間とメモリを使うため、ワーカーのテスト全体でこの1回だけにする。
 * 生成はモック（fixtures/codex の固定応答）。モックでの成功は実生成の成功ではない（24.3）。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { companies, proposalVersions } from "@siteoffer/db";
import { createDiscoveryJob } from "@siteoffer/discovery";
import { eq } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import type { ProposalContent } from "../src/content.ts";
import { QUEUES } from "../src/queues.ts";
import { createAstroSiteBuilder } from "../src/site-builder.ts";
import { ONE_COMPANY_CRITERIA, setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv | undefined;
afterAll(async () => {
  await env?.cleanup();
});

it("収集 → 診断（create）→ 生成 → Astroでデモをビルド・検査 → 提案版を in_review で保存", async () => {
  env = await setupEnv({ threshold: 100, siteBuilder: createAstroSiteBuilder({ timeoutMs: 240_000 }) });
  const job = await createDiscoveryJob(env.db, env.clock, { provider: "fixture", criteria: ONE_COMPANY_CRITERIA });
  if (!job.ok) throw new Error(job.error);
  await env.queue.send(QUEUES.discovery, { discoveryJobId: job.value.jobId }, { singletonKey: "d" });
  const results = await env.queue.drain(env.runtime);
  const last = results.at(-1)!;
  if (last.outcome.status !== "succeeded") throw new Error(JSON.stringify(last.outcome));
  expect(results.map((r) => r.outcome.status)).toEqual(["succeeded", "succeeded", "succeeded"]);

  const [c] = await env.db.select().from(companies).where(eq(companies.name, "株式会社あおば印刷"));
  expect(c!.pipelineStatus).toBe("in_review");
  const [v] = await env.db.select().from(proposalVersions);
  expect(v!.status).toBe("in_review");
  const content = v!.content as ProposalContent;
  expect(content.demoCheck).toMatchObject({ ok: true, errors: [] });
  expect(content.demoCheck!.pages).toContain("index.html");

  const dist = v!.demoArtifactDir!;
  expect(dist.startsWith(env.deps.demoArtifactRoot)).toBe(true);
  expect(existsSync(path.join(path.dirname(dist), "site.json"))).toBe(true);
  const page = await readFile(path.join(dist, "index.html"), "utf8");
  // デモには非公式の提案である表示と noindex が入る（11章）
  expect(page).toContain("非公式");
  expect(page).toContain("noindex");
}, 300_000);
