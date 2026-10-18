import { randomUUID } from "node:crypto";
import { attachDesignImage, createDesign, DEFAULT_DESIGN_BRIEF, switchDesignToImport } from "@siteoffer/core";
import { auditEvents, companies, designVersions, siteAudits, users, websites } from "@siteoffer/db";
import { normalizeDesignImage } from "@siteoffer/generation/images";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { processDesignJobs } from "../src/design.ts";
import { deferred, setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});
async function seed() {
  env = await setupEnv();
  const [operator] = await env.db
    .insert(users)
    .values({
      email: "image-switch@example.test",
      displayName: "架空の担当",
      passwordHash: "not-a-login",
      role: "ops",
    })
    .returning();
  const actor = { kind: "ops", userId: operator!.id } as const;
  const [company] = await env.db.insert(companies).values({ name: "架空の画像切り替え検証" }).returning();
  const [website] = await env.db
    .insert(websites)
    .values({
      companyId: company!.id,
      url: "https://image-switch.example.test",
      normalizedUrl: "https://image-switch.example.test",
      domain: "image-switch.example.test",
    })
    .returning();
  const [audit] = await env.db
    .insert(siteAudits)
    .values({
      companyId: company!.id,
      websiteId: website!.id,
      targetUrl: "https://image-switch.example.test",
      status: "evaluated",
      decision: "create",
    })
    .returning();
  const design = await createDesign(env.db, env.clock, actor, {
    companyId: company!.id,
    auditId: audit!.id,
    source: "openai",
    model: "fixture-image-model",
    requestKey: randomUUID(),
    brief: DEFAULT_DESIGN_BRIEF,
  });
  return { actor, design, input: { companyId: company!.id, designId: design.id } };
}
async function image() {
  return normalizeDesignImage(
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#e9edf3" } })
      .png()
      .toBuffer(),
  );
}
it("cancels an unclaimed request without a provider call, preserves the version and continues through image import", async () => {
  const s = await seed();
  const changed = await switchDesignToImport(env.db, env.clock, s.actor, s.input);
  expect(changed).toMatchObject({
    id: s.design.id,
    version: s.design.version,
    auditId: s.design.auditId,
    brief: s.design.brief,
    companySnapshot: s.design.companySnapshot,
    prompt: s.design.prompt,
    status: "draft",
    source: "import",
    model: null,
    startedAt: null,
    requestId: null,
    usage: null,
  });
  await switchDesignToImport(env.db, env.clock, s.actor, s.input);
  const generate = vi.fn(async () => {
    throw new Error("unexpected provider call");
  });
  await processDesignJobs(env.deps, { generate });
  expect(generate).not.toHaveBeenCalled();
  const events = await env.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "design.switch_to_import"), eq(auditEvents.targetId, s.design.id)));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actorId: s.actor.userId,
    before: { source: "openai", model: "fixture-image-model" },
    after: { source: "import" },
  });
  await attachDesignImage(env.db, env.clock, s.actor, s.design.id, await image());
  expect((await env.db.select().from(designVersions))[0]).toMatchObject({ status: "in_review", source: "import" });
});
it("refuses another company, a sales actor, a suspended operator, and a missing operator without modifying the request", async () => {
  const s = await seed();
  await expect(
    switchDesignToImport(env.db, env.clock, s.actor, { ...s.input, companyId: randomUUID() }),
  ).rejects.toThrow("この企業");
  await expect(
    switchDesignToImport(env.db, env.clock, { kind: "sales", userId: s.actor.userId }, s.input),
  ).rejects.toThrow("運営権限");
  await env.db.update(users).set({ status: "suspended" }).where(eq(users.id, s.actor.userId));
  await expect(switchDesignToImport(env.db, env.clock, s.actor, s.input)).rejects.toThrow("有効な運営");
  await expect(switchDesignToImport(env.db, env.clock, { kind: "ops", userId: randomUUID() }, s.input)).rejects.toThrow(
    "有効な運営",
  );
  expect((await env.db.select().from(designVersions))[0]).toMatchObject({ status: "queued", source: "openai" });
});
it("does not cancel a request already claimed by a worker, even while the provider has not returned", async () => {
  const s = await seed();
  const generated = await image();
  const started = deferred();
  const result = deferred<{ bytes: Buffer; requestId: string; usage: unknown }>();
  const work = processDesignJobs(env.deps, {
    generate: async () => {
      started.resolve();
      return result.promise;
    },
  });
  await started.promise;
  try {
    await expect(switchDesignToImport(env.db, env.clock, s.actor, s.input)).rejects.toThrow("開始済み");
  } finally {
    result.resolve({ bytes: generated.png, requestId: "fixture-request", usage: { images: 1 } });
    await work;
  }
  expect((await env.db.select().from(designVersions))[0]).toMatchObject({
    status: "in_review",
    source: "openai",
    requestId: "fixture-request",
  });
});
it.each(["in_review", "approved", "failed"] as const)("preserves a version in %s", async (status) => {
  const s = await seed();
  await env.db.update(designVersions).set({ status }).where(eq(designVersions.id, s.design.id));
  await expect(switchDesignToImport(env.db, env.clock, s.actor, s.input)).rejects.toThrow("状態が変わった");
  expect((await env.db.select().from(designVersions))[0]?.status).toBe(status);
});
it("refuses inconsistent queued data with evidence of an API start", async () => {
  const s = await seed();
  await env.db.update(designVersions).set({ startedAt: env.clock.now() }).where(eq(designVersions.id, s.design.id));
  await expect(switchDesignToImport(env.db, env.clock, s.actor, s.input)).rejects.toThrow("開始済み");
  expect((await env.db.select().from(designVersions))[0]?.source).toBe("openai");
});
