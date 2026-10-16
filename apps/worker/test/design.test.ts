import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  attachDesignImage,
  createDesign,
  DEFAULT_DESIGN_BRIEF,
  requestDesignBuild,
  retryDesignBuild,
  reviewDesign,
} from "@siteoffer/core";
import {
  companies,
  designVersions,
  generationJobs,
  proposalVersions,
  siteAudits,
  users,
  websites,
} from "@siteoffer/db";
import { createOpenAIImageGenerator, normalizeDesignImage } from "@siteoffer/generation/images";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { intakeDesignBuilds, processDesignJobs } from "../src/design.ts";
import { executeStep } from "../src/execute.ts";
import { proposalStep } from "../src/pipeline/proposal.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
  env = undefined!;
});
async function seed() {
  env = await setupEnv();
  const [user] = await env.db
    .insert(users)
    .values({
      email: "design-operator@example.test",
      displayName: "確認担当",
      passwordHash: "fixture-not-a-login",
      role: "ops",
    })
    .returning();
  const [company] = await env.db.insert(companies).values({ name: "デザイン検証株式会社" }).returning();
  const [website] = await env.db
    .insert(websites)
    .values({
      companyId: company!.id,
      url: "https://design.example.test",
      normalizedUrl: "https://design.example.test",
      domain: "design.example.test",
      kind: "current",
    })
    .returning();
  const [audit] = await env.db
    .insert(siteAudits)
    .values({
      companyId: company!.id,
      websiteId: website!.id,
      targetUrl: "https://design.example.test",
      status: "evaluated",
      decision: "create",
    })
    .returning();
  const actor = { kind: "ops", userId: user!.id } as const;
  const image = await normalizeDesignImage(
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#f0eee8" } })
      .png()
      .toBuffer(),
  );
  return { company: company!, audit: audit!, actor, image };
}
describe("画像を先に承認する制作フロー", () => {
  it("画像未承認ではHTMLを生成せず、承認・二重依頼後に同じ画像を1回だけ制作に渡す", async () => {
    const s = await seed();
    const first = await executeStep(env.deps, proposalStep, {
      companyId: s.company.id,
      auditId: s.audit.id,
      revision: "initial",
    });
    expect(first).toMatchObject({ status: "succeeded", result: { status: "awaiting_design" } });
    expect(await env.db.select().from(generationJobs)).toHaveLength(0);
    expect(await env.db.select().from(proposalVersions)).toHaveLength(0);
    const [d] = await env.db.select().from(designVersions);
    await expect(requestDesignBuild(env.db, env.clock, s.actor, d!.id)).rejects.toThrow("承認済み");
    await attachDesignImage(env.db, env.clock, s.actor, d!.id, s.image);
    await expect(
      reviewDesign(env.db, env.clock, s.actor, {
        id: d!.id,
        approve: true,
        note: "",
        factsChecked: true,
        rightsChecked: false,
        layoutChecked: true,
      }),
    ).rejects.toThrow("3項目");
    await reviewDesign(env.db, env.clock, s.actor, {
      id: d!.id,
      approve: true,
      note: "fixture",
      factsChecked: true,
      rightsChecked: true,
      layoutChecked: true,
    });
    await expect(attachDesignImage(env.db, env.clock, s.actor, d!.id, s.image)).rejects.toThrow("状態が変わりました");
    await requestDesignBuild(env.db, env.clock, s.actor, d!.id);
    await requestDesignBuild(env.db, env.clock, s.actor, d!.id);
    await intakeDesignBuilds(env.deps);
    await intakeDesignBuilds(env.deps);
    expect(env.queue.size).toBe(1);
    const result = await env.queue.drain(env.runtime);
    expect(result.at(-1)?.outcome.status).toBe("succeeded");
    const [v] = await env.db.select().from(proposalVersions);
    expect(v).toMatchObject({
      status: "in_review",
      content: { designVersionId: d!.id, designSha256: expect.any(String) },
    });
    expect(await readFile(path.join(path.dirname(v!.demoArtifactDir!), "reference", `design-${d!.id}.png`))).toEqual(
      s.image.png,
    );
    await intakeDesignBuilds(env.deps);
    expect(env.queue.size).toBe(0);
    await expect(retryDesignBuild(env.db, env.clock, s.actor, d!.id)).rejects.toThrow("制作失敗");
    await env.db.update(proposalVersions).set({ status: "failed" }).where(eq(proposalVersions.id, v!.id));
    const retry = await retryDesignBuild(env.db, env.clock, s.actor, d!.id);
    expect(retry.imageSha256).toBe(v!.content && (v!.content as { designSha256: string }).designSha256);
    expect(retry.status).toBe("approved");
    expect((await retryDesignBuild(env.db, env.clock, s.actor, d!.id)).id).toBe(retry.id);
    await intakeDesignBuilds(env.deps);
    expect(env.queue.size).toBe(1);
    expect((await env.queue.drain(env.runtime)).at(-1)?.outcome.status).toBe("succeeded");
    expect(await env.db.select().from(proposalVersions)).toHaveLength(2);
  });
  it("営業権限・別企業のデザイン・未承認の直指定を拒否する", async () => {
    const s = await seed();
    const input = {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: "access",
      brief: DEFAULT_DESIGN_BRIEF,
      source: "import" as const,
    };
    await expect(createDesign(env.db, env.clock, { kind: "sales", userId: s.actor.userId }, input)).rejects.toThrow(
      "運営権限",
    );
    const d = await createDesign(env.db, env.clock, s.actor, input);
    const r = await executeStep(env.deps, proposalStep, {
      companyId: s.company.id,
      auditId: s.audit.id,
      revision: "bypass",
      designVersionId: d.id,
    });
    expect(r.status).toBe("failed");
    expect(await env.db.select().from(generationJobs)).toHaveLength(0);
    await expect(
      reviewDesign(env.db, env.clock, s.actor, {
        id: d.id,
        approve: false,
        note: "",
        factsChecked: false,
        rightsChecked: false,
        layoutChecked: false,
      }),
    ).rejects.toThrow("修正内容");
  });
  it("API処理を永続化して重複実行を防ぎ、失敗と中断を可視化する", async () => {
    const s = await seed();
    const d = await createDesign(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: "api",
      brief: DEFAULT_DESIGN_BRIEF,
      source: "openai",
      model: "configured-image-model",
    });
    const generate = vi.fn(async () => ({ bytes: s.image.png, requestId: "request-fixture", usage: { images: 1 } }));
    await processDesignJobs(env.deps, { generate });
    await processDesignJobs(env.deps, { generate });
    expect(generate).toHaveBeenCalledTimes(1);
    const [stored] = await env.db.select().from(designVersions).where(eq(designVersions.id, d.id));
    expect(stored).toMatchObject({
      status: "in_review",
      requestId: "request-fixture",
      imageSha256: expect.any(String),
    });
    const failed = await createDesign(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: "failure",
      brief: DEFAULT_DESIGN_BRIEF,
      source: "openai",
      model: "configured-image-model",
    });
    await processDesignJobs(env.deps, {
      generate: async () => {
        throw new Error("sensitive-provider-body");
      },
    });
    const [error] = await env.db.select().from(designVersions).where(eq(designVersions.id, failed.id));
    expect(error?.status).toBe("failed");
    expect(error?.error).not.toContain("sensitive");
  });
});
it("画像APIのリクエスト・失敗・不正ファイルを検証する", async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from("fixture").toString("base64") }], usage: { total_tokens: 1 } }),
        { headers: { "x-request-id": "fixture-id" } },
      ),
  );
  const provider = createOpenAIImageGenerator("fixture", transport as typeof fetch);
  const r = await provider.generate("design", "configured-model");
  expect(r.requestId).toBe("fixture-id");
  expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toMatchObject({
    model: "configured-model",
    n: 1,
    output_format: "png",
  });
  const failed = createOpenAIImageGenerator("fixture", async () => new Response("private error", { status: 429 }));
  await expect(failed.generate("design", "model")).rejects.toThrow("HTTP 429");
  await expect(normalizeDesignImage(Buffer.from("<svg>unsafe</svg>"))).rejects.toThrow();
});

it("an image worker without credentials leaves queued work for a configured worker", async () => {
  const { company, audit, actor } = await seed();
  const d = await createDesign(env.db, env.clock, actor, {
    companyId: company.id,
    auditId: audit.id,
    brief: DEFAULT_DESIGN_BRIEF,
    requestKey: "missing-image-key",
    source: "openai",
    model: "test-model",
  });
  vi.stubEnv("OPENAI_API_KEY", "");
  try {
    await processDesignJobs(env.deps);
    expect((await env.db.select().from(designVersions).where(eq(designVersions.id, d.id)))[0]?.status).toBe("queued");
  } finally {
    vi.unstubAllEnvs();
  }
});
