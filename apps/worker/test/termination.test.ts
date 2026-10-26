import { recordEvent } from "@siteoffer/core";
import { auditEvents, companies, discoveryJobs, proposalVersions, siteAudits, websites } from "@siteoffer/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeStep, PermanentError, PreconditionError, type StepDefinition } from "../src/execute.ts";
import { claimStep, finishStep, readStepState } from "../src/ledger.ts";
import { auditStep } from "../src/pipeline/audit.ts";
import { discoveryStep } from "../src/pipeline/discovery.ts";
import { ensureProposalVersion, proposalStep } from "../src/pipeline/proposal.ts";
import { QUEUES, stepKeys } from "../src/queues.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
const actor = { kind: "system", job: "termination-test" } as const;
beforeEach(async () => {
  e = await setupEnv({
    policies: {
      audit: { maxAttempts: 1, timeoutMs: 60000 },
      proposal: { maxAttempts: 1, timeoutMs: 60000 },
      discovery: { maxAttempts: 1, timeoutMs: 60000 },
    },
  });
});
afterEach(async () => {
  await e.cleanup();
});
async function seed() {
  const [c] = await e.db
    .insert(companies)
    .values({ name: "終了整合性試験", pipelineStatus: "site_confirmed", officialSiteStatus: "confirmed" })
    .returning();
  const [w] = await e.db
    .insert(websites)
    .values({
      companyId: c!.id,
      url: "https://finish.example/",
      normalizedUrl: "https://finish.example/",
      domain: "finish.example",
    })
    .returning();
  const [a] = await e.db
    .insert(siteAudits)
    .values({ companyId: c!.id, websiteId: w!.id, targetUrl: w!.url, status: "scoring" })
    .returning();
  return { c: c!, a: a! };
}
async function rejectTerminal() {
  await e.db.execute(
    sql`create function reject_terminal() returns trigger language plpgsql as $$ begin if NEW.action = 'worker.step_failed' then raise exception 'injected terminal persistence failure'; end if; return NEW; end $$`,
  );
  await e.db.execute(
    sql`create trigger reject_terminal before insert on audit_events for each row execute function reject_terminal()`,
  );
}
const base = { key: "termination", queue: QUEUES.audit, actor, maxAttempts: 1, staleAfterMs: 60000 };
describe("最終失敗と後始末の一括確定", () => {
  it.each(["audit", "proposal", "discovery"] as const)(
    "%sの後始末後に終了記録が失敗しても全体を戻し、期限切れ回復で一度だけ確定する",
    async (kind) => {
      const s = await seed();
      let payload: unknown;
      let def: StepDefinition<unknown, unknown>;
      let id: string;
      if (kind === "audit") {
        payload = { companyId: s.c.id, requestKey: "atomic" };
        def = auditStep;
        id = s.a.id;
        await recordEvent(e.db, e.clock, {
          actor,
          action: "site_audit.started",
          targetType: "site_audit",
          targetId: id,
          after: { workerStepKey: stepKeys.audit(payload as Parameters<typeof stepKeys.audit>[0]) },
        });
      } else if (kind === "proposal") {
        payload = { companyId: s.c.id, auditId: s.a.id, revision: "atomic" };
        def = proposalStep;
        const v = await ensureProposalVersion(e.db, e.clock, {
          ...(payload as Parameters<typeof ensureProposalVersion>[2]),
          idempotencyKey: def.key(payload),
        });
        id = v.id;
      } else {
        const [d] = await e.db
          .insert(discoveryJobs)
          .values({ provider: "fixture", criteria: {}, status: "running" })
          .returning();
        id = d!.id;
        payload = { discoveryJobId: id };
        def = discoveryStep;
      }
      const run = vi.fn(async () => {
        throw new PermanentError("stop test");
      });
      const failed = { ...def, run };
      await rejectTerminal();
      await expect(executeStep(e.deps, failed, payload)).rejects.toThrow();
      expect(await readStepState(e.db, def.key(payload))).toMatchObject({ running: true, gaveUp: false, attempts: 1 });
      expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe("site_confirmed");
      const status = async () =>
        kind === "audit"
          ? (await e.db.select().from(siteAudits).where(eq(siteAudits.id, id)))[0]!.status
          : kind === "proposal"
            ? (await e.db.select().from(proposalVersions).where(eq(proposalVersions.id, id)))[0]!.status
            : (await e.db.select().from(discoveryJobs).where(eq(discoveryJobs.id, id)))[0]!.status;
      expect(await status()).toBe(kind === "audit" ? "scoring" : kind === "proposal" ? "generating" : "running");
      await e.db.execute(sql`drop trigger reject_terminal on audit_events`);
      e.clock.advance(60001);
      expect(await executeStep(e.deps, failed, payload)).toMatchObject({
        status: "duplicate",
        state: "gave_up",
        attempts: 1,
      });
      expect(await status()).toBe("failed");
      expect(run).toHaveBeenCalledTimes(1);
      expect(await executeStep(e.deps, failed, payload)).toMatchObject({ status: "duplicate", state: "gave_up" });
      expect(await e.db.select().from(auditEvents).where(eq(auditEvents.action, "worker.step_failed"))).toHaveLength(1);
      expect(await readStepState(e.db, def.key(payload))).toMatchObject({ running: false, gaveUp: true });
    },
  );
  it("後始末自身が途中で失敗した場合も、先の業務更新と終了記録を確定しない", async () => {
    await claimStep(e.db, e.clock, base);
    await expect(
      finishStep(e.db, e.clock, {
        ...base,
        attempt: 1,
        outcome: { ok: false, reason: "stop", final: true },
        onFinalFailure: async (tx) => {
          await tx.insert(companies).values({ name: "rollback" });
          throw Error("cleanup unavailable");
        },
      }),
    ).rejects.toThrow("cleanup unavailable");
    expect(await e.db.select().from(companies)).toHaveLength(0);
    expect(await readStepState(e.db, base.key)).toMatchObject({ running: true, gaveUp: false });
  });
  it("期限切れ最後の試行の後始末失敗も台帳を閉じず、再実行で回復できる", async () => {
    await claimStep(e.db, e.clock, base);
    e.clock.advance(60001);
    await expect(
      claimStep(e.db, e.clock, {
        ...base,
        onFinalFailure: async (tx) => {
          await tx.insert(companies).values({ name: "rollback" });
          throw Error("cleanup unavailable");
        },
      }),
    ).rejects.toThrow("cleanup unavailable");
    expect(await e.db.select().from(companies)).toHaveLength(0);
    expect(await readStepState(e.db, base.key)).toMatchObject({ running: true, gaveUp: false });
    await claimStep(e.db, e.clock, {
      ...base,
      onFinalFailure: async (tx) => {
        await tx.insert(companies).values({ name: "complete" });
      },
    });
    expect(await e.db.select().from(companies)).toHaveLength(1);
    expect(await readStepState(e.db, base.key)).toMatchObject({ running: false, gaveUp: true });
  });
  it.each(["success", "retry", "precondition"])("%sでは最終失敗の後始末を呼ばない", async (mode) => {
    const onGiveUp = vi.fn();
    e.deps.policies.audit.maxAttempts = 3;
    const def: StepDefinition<null, string> = {
      kind: "audit",
      queue: QUEUES.audit,
      key: () => base.key,
      onGiveUp,
      async run() {
        if (mode === "success") return "done";
        if (mode === "precondition") throw new PreconditionError("skip");
        throw Error("retry");
      },
    };
    expect((await executeStep(e.deps, def, null)).status).toBe(
      mode === "success" ? "succeeded" : mode === "precondition" ? "failed" : "retry",
    );
    expect(onGiveUp).not.toHaveBeenCalled();
  });
  it("並行する同じ終了要求でも後始末と記録を一度だけ確定する", async () => {
    await claimStep(e.db, e.clock, base);
    const onFinalFailure = vi.fn(async (tx: typeof e.db) => {
      await tx.insert(companies).values({ name: "once" });
    });
    const end = { ...base, attempt: 1, outcome: { ok: false as const, reason: "stop", final: true }, onFinalFailure };
    const results = await Promise.all([finishStep(e.db, e.clock, end), finishStep(e.db, e.clock, end)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(onFinalFailure).toHaveBeenCalledTimes(1);
    expect(await e.db.select().from(companies)).toHaveLength(1);
  });
});
