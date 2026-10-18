import { randomUUID } from "node:crypto";
import { DEFAULT_DESIGN_BRIEF, fixedClock } from "@siteoffer/core";
import { type Db, designVersions, generationJobs, siteAudits, users, workerRuntimes } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDesignFromDraft, loadDesignDraft, saveDesignDraft } from "./design-drafts";
import { getProductionStatusForOps, imageRequestReadiness } from "./production-status";
import { seedCandidate, seedUser } from "./test-seed";

const clock = fixedClock("2026-10-19T00:00:00Z");
let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});
function worker() {
  return {
    id: randomUUID(),
    providers: [],
    mode: "standard",
    heartbeatAt: clock.now(),
    capabilities: {
      version: 1 as const,
      generator: "codex" as const,
      discoveryOnly: false,
      imageConfigured: true,
      intakeIntervalMs: 5000,
      privateValue: "test-only-hidden-capability",
    },
    progress: {
      phase: "idle" as const,
      since: clock.now().toISOString(),
      completedAt: clock.now().toISOString(),
      lastErrorAt: null,
    },
  };
}
async function ready() {
  const ops = await seedUser(db, "ops");
  const runtime = worker();
  await db.insert(workerRuntimes).values(runtime);
  return { ...ops, runtime };
}
async function draft() {
  const context = await ready();
  const { company, audit } = await seedCandidate(db);
  await db.update(siteAudits).set({ decision: "create" }).where(eq(siteAudits.id, audit.id));
  const scope = { companyId: company.id, designId: null, auditId: audit.id };
  await saveDesignDraft(db, clock, context.actor, scope, 0, DEFAULT_DESIGN_BRIEF);
  const input = {
    revision: 1,
    brief: DEFAULT_DESIGN_BRIEF,
    requestKey: randomUUID(),
    source: "openai" as const,
    model: "test-image-model",
  };
  return { ...context, scope, input };
}
it("uses public worker notifications even when the Web process has no API key", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  const { actor, runtime } = await ready();
  const result = await getProductionStatusForOps(db, clock, actor);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.site.label).toContain("実AI");
  expect(imageRequestReadiness("test-image-model", result.value.image).ready).toBe(true);
  const encoded = JSON.stringify(result.value);
  for (const secret of [runtime.id, "test-only-hidden-capability", "providers", "capabilities", "OPENAI_API_KEY"])
    expect(encoded).not.toContain(secret);
});
it("a Web API key alone cannot claim that an image worker is available", async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-only-unused-web-key");
  const { actor } = await seedUser(db, "ops");
  const result = await getProductionStatusForOps(db, clock, actor);
  if (!result.ok) throw Error("Expected public readiness");
  expect(imageRequestReadiness("test-image-model", result.value.image).ready).toBe(false);
  expect(result.value.image.status).toBe("unavailable");
});
it("rejects stale, future, legacy and collection-only notifications", async () => {
  const { actor, runtime } = await ready();
  for (const patch of [
    { heartbeatAt: new Date(clock.now().getTime() - 45001) },
    { heartbeatAt: new Date(clock.now().getTime() + 6000) },
    { heartbeatAt: clock.now(), capabilities: null },
    { capabilities: { ...runtime.capabilities, discoveryOnly: true } },
  ]) {
    await db.update(workerRuntimes).set(patch).where(eq(workerRuntimes.id, runtime.id));
    const result = await getProductionStatusForOps(db, clock, actor);
    if (!result.ok) throw Error("Expected public readiness");
    expect(imageRequestReadiness("test-image-model", result.value.image).ready).toBe(false);
  }
});
it("keeps image availability independent from a site's stop confirmation", async () => {
  const { actor } = await ready();
  await db.insert(generationJobs).values({
    idempotencyKey: "status-stop",
    purpose: "demo_site",
    generator: "codex",
    promptVersion: "test",
    status: "needs_review",
    errorCode: "sandbox_stop_unconfirmed",
    output: { secret: "test-only-output" },
  });
  const result = await getProductionStatusForOps(db, clock, actor);
  if (!result.ok) throw Error("Expected public readiness");
  expect(result.value.site.label).toBe("生成の停止確認待ち");
  expect(result.value.image.status).toBe("ready");
  expect(JSON.stringify(result.value)).not.toContain("test-only-output");
});
it("never describes an unknown site generator as real AI", async () => {
  const { actor, runtime } = await ready();
  await db
    .update(workerRuntimes)
    .set({ capabilities: { ...runtime.capabilities, generator: "unknown" } })
    .where(eq(workerRuntimes.id, runtime.id));
  const result = await getProductionStatusForOps(db, clock, actor);
  if (!result.ok) throw Error("Expected public readiness");
  expect(result.value.site).toMatchObject({ status: "unknown", label: "生成方式を確認できません" });
  expect(result.value.image.status).toBe("ready");
});
it("requires an active operator before reading operational state", async () => {
  const { actor, user } = await ready();
  const sales = await seedUser(db, "sales");
  for (const denied of [
    null,
    sales.actor,
    { kind: "ops" as const, userId: "invalid" },
    { kind: "ops" as const, userId: randomUUID() },
  ])
    expect(await getProductionStatusForOps(db, clock, denied)).toMatchObject({ ok: false });
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
  expect(await getProductionStatusForOps(db, clock, actor)).toMatchObject({ ok: false });
});
it("does not consume a saved draft when its image worker stopped after the page was opened", async () => {
  const d = await draft();
  await db.delete(workerRuntimes).where(eq(workerRuntimes.id, d.runtime.id));
  await expect(createDesignFromDraft(db, clock, d.actor, d.scope, d.input)).rejects.toThrow("稼働を確認できません");
  expect(await db.select().from(designVersions)).toHaveLength(0);
  expect(await loadDesignDraft(db, d.actor, d.scope)).toMatchObject({ revision: 1, values: DEFAULT_DESIGN_BRIEF });
  const imported = await createDesignFromDraft(db, clock, d.actor, d.scope, { ...d.input, source: "import" });
  expect(imported).toBeTruthy();
});
it("accepts an image request without a Web API key, and replays a lost response after the worker went offline", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  const d = await draft();
  const id = await createDesignFromDraft(db, clock, d.actor, d.scope, d.input);
  expect(await loadDesignDraft(db, d.actor, d.scope)).toMatchObject({ revision: 2, values: null });
  await db.delete(workerRuntimes).where(eq(workerRuntimes.id, d.runtime.id));
  const later = { ...DEFAULT_DESIGN_BRIEF, objective: "次の画像案の下書き" };
  await saveDesignDraft(db, clock, d.actor, d.scope, 2, later);
  expect(await createDesignFromDraft(db, clock, d.actor, d.scope, d.input)).toBe(id);
  expect((await loadDesignDraft(db, d.actor, d.scope)).values).toEqual(later);
  const rows = await db.select().from(designVersions);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "queued", source: "openai", model: "test-image-model", imageBase64: null });
});
it("requires an explicitly selected model without returning its invalid value", async () => {
  const { actor } = await ready();
  const result = await getProductionStatusForOps(db, clock, actor);
  if (!result.ok) throw Error("Expected public readiness");
  for (const model of [undefined, "", " ", "test-only-private\nvalue", "x".repeat(201)]) {
    const request = imageRequestReadiness(model, result.value.image);
    expect(request.ready).toBe(false);
    expect(request.message).not.toContain("test-only-private");
  }
});
