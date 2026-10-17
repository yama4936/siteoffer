import { randomUUID } from "node:crypto";
import { fixedClock } from "@siteoffer/core";
import {
  type Db,
  designVersions,
  discoveryJobs,
  proposalHandoffs,
  proposalVersions,
  users,
  type workerRuntimes,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { assessWorkers, getProcessingOverview } from "./processing";
import { seedCandidate, seedUser } from "./test-seed";

const clock = fixedClock(new Date("2026-10-16T00:00:00Z"));
function worker(patch: Partial<typeof workerRuntimes.$inferSelect> = {}) {
  return {
    id: randomUUID(),
    providers: ["fixture"],
    mode: "demo",
    heartbeatAt: clock.now(),
    capabilities: {
      version: 1 as const,
      discoveryOnly: false,
      imageConfigured: true,
      generator: "mock" as const,
      intakeIntervalMs: 5000,
    },
    progress: {
      phase: "idle" as const,
      since: clock.now().toISOString(),
      completedAt: clock.now().toISOString(),
      lastErrorAt: null,
    },
    ...patch,
  };
}
describe("processing assessment", () => {
  function parallel() {
    const w = worker();
    return worker({
      progress: {
        ...w.progress!,
        lanes: {
          dispatch: { ...w.progress! },
          images: { ...w.progress! },
          deliveries: { ...w.progress! },
        },
      },
    });
  }
  it("処理別のエラーを分け、長い画像生成で受付の更新遅れを隠さない", () => {
    const w = parallel();
    w.progress!.phase = "images";
    w.progress!.lanes!.images!.phase = "images";
    w.progress!.lanes!.dispatch!.since = new Date(clock.now().getTime() - 61_000).toISOString();
    let state = assessWorkers([w], clock.now());
    expect(state.image.status).toBe("ready");
    expect(state.site.status).toBe("attention");
    expect(state.workers[0]?.lanes?.find((l) => l.key === "dispatch")?.intakeOverdue).toBe(true);
    w.progress!.lanes!.dispatch!.since = clock.now().toISOString();
    w.progress!.phase = "error";
    w.progress!.lanes!.images!.phase = "error";
    state = assessWorkers([w], clock.now());
    expect(state.image.status).toBe("attention");
    expect(state.site.status).toBe("ready");
    w.progress!.lanes!.images!.phase = "idle";
    w.progress!.lanes!.deliveries!.phase = "error";
    state = assessWorkers([w], clock.now());
    expect(state.site.status).toBe("attention");
    expect(state.image.status).toBe("ready");
  });
  it("欠けた処理通知、不正な処理と日時は稼働の証拠にしない", () => {
    const w = parallel();
    delete w.progress!.lanes!.images;
    expect(assessWorkers([w], clock.now()).image.status).toBe("attention");
    expect(assessWorkers([w], clock.now()).site.status).toBe("ready");
    w.progress!.lanes!.images = { ...w.progress!, phase: "discovery" };
    expect(assessWorkers([w], clock.now()).image.status).toBe("attention");
    w.progress!.lanes!.images = { ...w.progress!, phase: "idle", since: "not-a-date" };
    expect(assessWorkers([w], clock.now()).image.status).toBe("attention");
  });
  it("detects an intake loop that stopped while its heartbeat timer remains alive", () => {
    const w = worker();
    w.progress!.since = new Date(clock.now().getTime() - 61000).toISOString();
    const state = assessWorkers([w], clock.now());
    expect(state.workers[0]).toMatchObject({ live: true, intakeOverdue: true });
    expect(state.site.status).toBe("attention");
    expect(
      assessWorkers([{ ...w, heartbeatAt: new Date(clock.now().getTime() - 60000) }], clock.now()).workers[0]
        ?.intakeOverdue,
    ).toBe(false);

    w.progress!.phase = "deliveries";
    expect(assessWorkers([w], clock.now()).site.status).toBe("ready");
  });

  it("expired or future heartbeats do not claim readiness", () => {
    for (const offset of [-45001, 6000])
      expect(
        assessWorkers([worker({ heartbeatAt: new Date(clock.now().getTime() + offset) })], clock.now()).site.status,
      ).toBe("unavailable");
    expect(
      assessWorkers([worker({ heartbeatAt: new Date(clock.now().getTime() - 45000) })], clock.now()).site.status,
    ).toBe("ready");
  });
  it("legacy workers are unknown and collection-only workers cannot build", () => {
    expect(assessWorkers([worker({ capabilities: null })], clock.now()).image.status).toBe("unknown");
    const c = worker();
    c.capabilities!.discoveryOnly = true;
    expect(assessWorkers([c], clock.now()).site.status).toBe("unavailable");
    expect(assessWorkers([c], clock.now()).image.status).toBe("unavailable");
  });
  it("separates process heartbeat, intake failure, image settings and mock output", () => {
    const c = worker();
    c.capabilities!.imageConfigured = false;
    expect(assessWorkers([c], clock.now()).image.status).toBe("unavailable");
    expect(assessWorkers([c], clock.now()).site.label).toContain("動作確認用");
    c.progress!.phase = "error";
    expect(assessWorkers([c], clock.now()).site.status).toBe("attention");
  });
  it("a capable worker handles images but mixed site generators need attention", () => {
    const c = worker();
    c.capabilities!.imageConfigured = false;
    expect(assessWorkers([c, worker()], clock.now()).image.status).toBe("ready");
    const real = worker({ capabilities: { ...c.capabilities!, generator: "codex" } });
    expect(assessWorkers([c, real], clock.now()).site.status).toBe("attention");
  });
});
let db: Db, close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

it("shows pending handoffs by company, paginates, hides sent rows and never returns lease tokens", async () => {
  ({ db, close } = await createTestDb());
  const ops = await seedUser(db, "ops");
  const a = await seedCandidate(db, { versionStatus: null });
  const b = await seedCandidate(db, { versionStatus: null });
  const token = randomUUID();
  await db.insert(proposalHandoffs).values(
    Array.from({ length: 23 }, (_, i) => ({
      sourceStepKey: `handoff-${i}`,
      companyId: i === 22 ? b.company.id : a.company.id,
      auditId: i === 22 ? b.audit.id : a.audit.id,
      sentAt: i === 21 ? clock.now() : null,
      attempts: i === 1 ? 2 : 0,
      leaseToken: i === 0 ? token : null,
      leaseUntil: i === 0 ? new Date(clock.now().getTime() + 60_000) : null,
      createdAt: new Date(clock.now().getTime() + i * 1000),
      nextAttemptAt: clock.now(),
    })),
  );
  const first = await getProcessingOverview(db, clock, ops.actor, a.company.id);
  if (!first.ok) throw new Error(first.error);
  expect(first.value.paging.handoffs).toEqual({ page: 1, pages: 2, total: 21 });
  expect(first.value.handoffs).toHaveLength(20);
  expect(first.value.handoffs.slice(0, 3).map((r) => r.state)).toEqual(["sending", "retry", "pending"]);
  expect(JSON.stringify(first.value)).not.toContain(token);
  expect(JSON.stringify(first.value)).not.toContain("leaseToken");
  const second = await getProcessingOverview(db, clock, ops.actor, a.company.id, { handoffs: 999 });
  expect(second.ok && second.value.handoffs.map((r) => r.id)).toEqual(["handoff-20"]);
  const other = await getProcessingOverview(db, clock, ops.actor, b.company.id);
  expect(other.ok && other.value.handoffs.map((r) => r.id)).toEqual(["handoff-22"]);
});
it("restricts processing records to active ops and rejects invalid filters", async () => {
  ({ db, close } = await createTestDb());
  const ops = await seedUser(db, "ops"),
    sales = await seedUser(db, "sales");
  expect((await getProcessingOverview(db, clock, null)).ok).toBe(false);
  expect((await getProcessingOverview(db, clock, sales.actor)).ok).toBe(false);
  expect((await getProcessingOverview(db, clock, ops.actor, "invalid")).ok).toBe(false);
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, ops.user.id));
  expect((await getProcessingOverview(db, clock, ops.actor)).ok).toBe(false);
});
it("counts all pending jobs, returns oldest first and filters exact companies", async () => {
  ({ db, close } = await createTestDb());
  const ops = await seedUser(db, "ops");
  const a = await seedCandidate(db, { versionStatus: null });
  const b = await seedCandidate(db, { versionStatus: null });
  const drafts = await db
    .insert(designVersions)
    .values(
      Array.from({ length: 24 }, (_, i) => ({
        companyId: a.company.id,
        auditId: a.audit.id,
        version: i + 1,
        requestKey: `monitor-${i}`,
        status: "queued" as const,
        brief: {},
        companySnapshot: {},
        prompt: "fixture",
        source: "openai",
        createdAt: new Date(clock.now().getTime() + i * 1000),
      })),
    )
    .returning();
  await db
    .insert(discoveryJobs)
    .values({ provider: "fixture", criteria: {}, status: "running", createdAt: clock.now() });
  const all = await getProcessingOverview(db, clock, ops.actor);
  expect(all.ok).toBe(true);
  if (!all.ok) return;
  expect(all.value.images).toHaveLength(20);
  expect(all.value.images[0]?.total).toBe(24);
  expect(all.value.images[0]?.id).toBe(drafts[0]!.id);
  expect(all.value.discovery).toHaveLength(1);
  const second = await getProcessingOverview(db, clock, ops.actor, a.company.id, { images: 999 });
  expect(second.ok && second.value.paging.images).toEqual({ page: 2, pages: 2, total: 24 });
  expect(second.ok && second.value.images.map((j) => j.id)).toEqual(drafts.slice(20).map((j) => j.id));

  const other = await getProcessingOverview(db, clock, ops.actor, b.company.id);
  expect(other.ok && other.value.images).toEqual([]);
  expect(other.ok && other.value.discovery).toEqual([]);
  await db
    .update(designVersions)
    .set({ status: "approved", buildRequestedAt: clock.now() })
    .where(eq(designVersions.id, drafts[0]!.id));
  let current = await getProcessingOverview(db, clock, ops.actor, a.company.id);
  expect(current.ok && current.value.sites[0]?.status).toBe(null);
  const [v] = await db
    .insert(proposalVersions)
    .values({
      proposalId: a.proposal.id,
      version: 1,
      status: "generating",
      content: { designVersionId: drafts[0]!.id },
    })
    .returning();
  current = await getProcessingOverview(db, clock, ops.actor, a.company.id);
  expect(current.ok && current.value.sites[0]?.status).toBe("generating");
  await db.update(proposalVersions).set({ status: "in_review" }).where(eq(proposalVersions.id, v!.id));
  current = await getProcessingOverview(db, clock, ops.actor, a.company.id);
  expect(current.ok && current.value.sites).toEqual([]);
});
