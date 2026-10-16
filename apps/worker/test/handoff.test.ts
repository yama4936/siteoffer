import {
  auditEvents,
  companies,
  designVersions,
  generationJobs,
  proposalHandoffs,
  siteAudits,
  websites,
} from "@siteoffer/db";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "../src/execute.ts";
import {
  dispatchProposalHandoffs,
  findProposalHandoff,
  HANDOFF_LEASE_MS,
  HANDOFF_RETRY_MESSAGE,
  HANDOFF_SEND_TIMEOUT_MS,
  recordProposalHandoff,
} from "../src/handoff.ts";
import { auditStep } from "../src/pipeline/audit.ts";
import { QUEUES, stepKeys } from "../src/queues.ts";
import { createWorkerRuntime } from "../src/runtime.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(async () => {
  env = await setupEnv({ threshold: 100 });
});
afterEach(async () => {
  vi.useRealTimers();
  await env.cleanup();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function seed(key = "audit:handoff:test") {
  const [c] = await env.db
    .insert(companies)
    .values({ name: "引き継ぎ試験", officialSiteStatus: "confirmed", pipelineStatus: "site_confirmed" })
    .returning();
  const [w] = await env.db
    .insert(websites)
    .values({
      companyId: c!.id,
      url: "https://handoff.example/",
      normalizedUrl: `https://${c!.id}.example/`,
      domain: "handoff.example",
      kind: "current",
      isPrimary: true,
    })
    .returning();
  const [a] = await env.db
    .insert(siteAudits)
    .values({ companyId: c!.id, websiteId: w!.id, targetUrl: w!.url, status: "evaluated", decision: "create" })
    .returning();
  const input = { sourceStepKey: key, companyId: c!.id, auditId: a!.id };
  await env.db.transaction((tx) => recordProposalHandoff(tx, env.clock, input));
  return input;
}

describe("診断から制作への永続的な引き継ぎ", () => {
  it("業務更新・引き継ぎ・監査記録は一緒にロールバックする", async () => {
    const input = await seed();
    await env.db.delete(proposalHandoffs);
    await env.db.delete(auditEvents);
    await expect(
      env.db.transaction(async (tx) => {
        await tx.update(companies).set({ pipelineStatus: "audited" });
        await recordProposalHandoff(tx, env.clock, input);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await env.db.select().from(proposalHandoffs)).toHaveLength(0);
    expect(await env.db.select().from(auditEvents)).toHaveLength(0);
    expect((await env.db.select().from(companies))[0]!.pipelineStatus).toBe("site_confirmed");
  });

  it("同じ依頼の再保存は重複せず、別の診断への差し替えを拒否する", async () => {
    const input = await seed();
    await env.db.transaction((tx) => recordProposalHandoff(tx, env.clock, input));
    await expect(
      env.db.transaction((tx) => recordProposalHandoff(tx, env.clock, { ...input, auditId: crypto.randomUUID() })),
    ).rejects.toThrow();
    expect(await env.db.select().from(proposalHandoffs)).toHaveLength(1);
    expect(await env.db.select().from(auditEvents)).toHaveLength(1);
  });

  it("並行する送信担当は一つだけ取得し、期限切れの担当は再取得できる", async () => {
    const input = await seed();
    const entered = deferred(),
      gate = deferred();
    let calls = 0;
    env.deps.queue = {
      async send() {
        if (++calls === 1) {
          entered.resolve();
          await gate.promise;
        }
      },
    };
    const first = dispatchProposalHandoffs(env.deps);
    try {
      await entered.promise;
      expect(await dispatchProposalHandoffs(env.deps)).toEqual({ sent: 0, deferred: 0 });
      env.clock.advance(HANDOFF_LEASE_MS);
      expect(await dispatchProposalHandoffs(env.deps)).toEqual({ sent: 1, deferred: 0 });
      gate.resolve();
      expect(await first).toEqual({ sent: 0, deferred: 1 });
      expect(await findProposalHandoff(env.db, input.sourceStepKey)).toMatchObject({
        attempts: 2,
        sentAt: env.clock.now(),
        leaseToken: null,
      });
      const events = await env.db.select().from(auditEvents);
      expect(events.filter((e) => e.action === "pipeline.handoff_sent")).toHaveLength(1);
    } finally {
      gate.resolve();
      await first;
    }
  });

  it("送信済みで応答だけ失われても、同じキーの再送で制作を二重に作らない", async () => {
    const input = await seed();
    env.deps.queue = {
      async send(...args) {
        await env.queue.send(...args);
        throw new Error("private-connection-detail");
      },
    };
    expect(await dispatchProposalHandoffs(env.deps)).toEqual({ sent: 0, deferred: 1 });
    expect(await findProposalHandoff(env.db, input.sourceStepKey)).toMatchObject({
      sentAt: null,
      lastError: HANDOFF_RETRY_MESSAGE,
      attempts: 1,
    });
    await env.queue.drain(env.runtime);
    expect(await env.db.select().from(designVersions)).toHaveLength(1);
    expect(await dispatchProposalHandoffs(env.deps)).toEqual({ sent: 0, deferred: 0 });
    env.clock.advance(30_000);
    env.deps.queue = env.queue;
    const restarted = createWorkerRuntime(env.deps);
    expect(await restarted.run(QUEUES.dispatchHandoffs, {})).toMatchObject({ result: { sent: 1 } });
    const results = await env.queue.drain(restarted);
    expect(results.at(-1)!.outcome).toMatchObject({ status: "duplicate", state: "succeeded" });
    expect(await env.db.select().from(designVersions)).toHaveLength(1);
    expect(env.queue.sent[0]!.singletonKey).toBe(env.queue.sent[1]!.singletonKey);
  });

  it("送信応答が来ない場合も期限付きで待機を閉じる", async () => {
    const input = await seed();
    const entered = deferred();
    env.deps.queue = {
      async send() {
        entered.resolve();
        return new Promise(() => {});
      },
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = dispatchProposalHandoffs(env.deps);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(HANDOFF_SEND_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ sent: 0, deferred: 1 });
    expect(await findProposalHandoff(env.db, input.sourceStepKey)).toMatchObject({
      leaseUntil: null,
      lastError: HANDOFF_RETRY_MESSAGE,
    });
  });

  it("送信確定の監査保存に失敗したら送信済みにせず、期限切れ後に復旧する", async () => {
    const input = await seed();
    await env.db.execute(
      sql`create function reject_handoff_sent() returns trigger language plpgsql as $$ begin if NEW.action = 'pipeline.handoff_sent' then raise exception 'audit unavailable'; end if; return NEW; end $$`,
    );
    await env.db.execute(
      sql`create trigger reject_handoff_sent before insert on audit_events for each row execute function reject_handoff_sent()`,
    );
    await expect(dispatchProposalHandoffs(env.deps)).rejects.toThrow();
    expect((await findProposalHandoff(env.db, input.sourceStepKey))!.sentAt).toBeNull();
    await env.db.execute(sql`drop trigger reject_handoff_sent on audit_events`);
    env.clock.advance(HANDOFF_LEASE_MS);
    expect(await dispatchProposalHandoffs(env.deps)).toEqual({ sent: 1, deferred: 0 });
    expect(env.queue.size).toBe(1);
  });

  it("保存後の親試行の失敗では診断をやり直さず、定期処理が引き継ぐ", async () => {
    const seeded = await seed();
    await env.db.delete(proposalHandoffs);
    await env.db.delete(siteAudits);
    const payload = { companyId: seeded.companyId, requestKey: "durable" };
    env.deps.queue = {
      async send() {
        throw new Error("queue unavailable");
      },
    };
    const interrupted = {
      ...auditStep,
      async run(...args: Parameters<typeof auditStep.run>) {
        await auditStep.run(...args);
        throw new Error("after handoff commit");
      },
    };
    expect(await executeStep(env.deps, interrupted, payload)).toMatchObject({ status: "retry" });
    expect(await executeStep(env.deps, auditStep, payload)).toMatchObject({
      status: "succeeded",
      attempt: 2,
      result: { proposalQueued: true },
    });
    expect(await env.db.select().from(siteAudits)).toHaveLength(1);
    expect(await env.db.select().from(generationJobs)).toHaveLength(1);
    expect(await findProposalHandoff(env.db, stepKeys.audit(payload))).toMatchObject({ attempts: 1, sentAt: null });
    await auditStep.onGiveUp!(env.deps, payload, "late error");
    expect((await env.db.select().from(companies))[0]!.pipelineStatus).toBe("audited");
    env.clock.advance(30_000);
    env.deps.queue = env.queue;
    expect(await env.runtime.run(QUEUES.dispatchHandoffs, {})).toMatchObject({ result: { sent: 1 } });
  });

  it("一回20件に制限し、収集専用ワーカーは制作を送らない", async () => {
    const input = await seed();
    for (let i = 1; i < 21; i++)
      await env.db.transaction((tx) =>
        recordProposalHandoff(tx, env.clock, { ...input, sourceStepKey: `audit:batch:${i}` }),
      );
    env.deps.discoveryOnly = true;
    expect(await dispatchProposalHandoffs(env.deps)).toEqual({ sent: 0, deferred: 0 });
    env.deps.discoveryOnly = false;
    expect(await dispatchProposalHandoffs(env.deps)).toEqual({ sent: 20, deferred: 0 });
    expect(await dispatchProposalHandoffs(env.deps)).toEqual({ sent: 1, deferred: 0 });
  });
});
