import { createHash } from "node:crypto";
import { createDesign, DEFAULT_DESIGN_BRIEF, recordEvent } from "@siteoffer/core";
import { auditEvents, companies, proposalHandoffs, proposalVersions, siteAudits, websites } from "@siteoffer/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeStep, type StepDefinition } from "../src/execute.ts";
import { claimStep, finishStep, readStepState, runOwnedStep, StepOwnershipLost } from "../src/ledger.ts";
import { ensureProposalVersion } from "../src/pipeline/proposal.ts";
import { recoverPipelineSteps } from "../src/pipeline-recovery.ts";
import type { QueueClaim } from "../src/queue-claim.ts";
import { QUEUES, stepKeys } from "../src/queues.ts";
import { setupEnv, type TestEnv } from "./helpers.ts";

let e: TestEnv;
const actor = { kind: "system", job: "recovery-test" } as const;
beforeEach(async () => {
  e = await setupEnv();
  // キューの状態遷移は制御するが、照合SQLと行ロックは実DBで実行する。
  await e.db.execute(sql`create schema pgboss`);
  await e.db.execute(sql`create table pgboss.job (id uuid primary key, name text not null, state text not null,
    retry_count integer not null, started_on timestamptz not null, expire_seconds integer not null,
    heartbeat_on timestamptz, heartbeat_seconds integer)`);
});
afterEach(async () => {
  await e.cleanup();
});

async function queueClaim(name: string = QUEUES.audit): Promise<QueueClaim> {
  const id = crypto.randomUUID();
  await e.db.execute(
    sql`insert into pgboss.job values (${id}::uuid, ${name}, 'active', 0, clock_timestamp(), 3600, clock_timestamp(), 120)`,
  );
  return { id, retryCount: 0 };
}
function claimInput(key: string, queue: string, claim?: QueueClaim, payload?: unknown) {
  return {
    key,
    queue,
    maxAttempts: 3,
    staleAfterMs: 3_600_000,
    actor,
    ...(claim ? { queueClaim: claim, payload } : {}),
  };
}
async function seedAudit() {
  const [c] = await e.db
    .insert(companies)
    .values({ name: "復旧試験", officialSiteStatus: "confirmed", pipelineStatus: "site_confirmed" })
    .returning();
  const [w] = await e.db
    .insert(websites)
    .values({
      companyId: c!.id,
      url: "https://recovery.example/",
      normalizedUrl: `https://${c!.id}.example/`,
      domain: "recovery.example",
    })
    .returning();
  const [a] = await e.db
    .insert(siteAudits)
    .values({ companyId: c!.id, websiteId: w!.id, targetUrl: w!.url, status: "scoring" })
    .returning();
  const payload = { companyId: c!.id, requestKey: "recover" };
  const key = stepKeys.audit(payload);
  await recordEvent(e.db, e.clock, {
    actor,
    action: "site_audit.started",
    targetType: "site_audit",
    targetId: a!.id,
    after: { workerStepKey: key, workerAttempt: 1 },
  });
  return { c: c!, a: a!, payload, key };
}

describe("キューと親試行の所有権", () => {
  it.each(["finish", "stale"])("%sの後始末中に実行期限を失った場合は業務更新と終了記録を戻す", async (mode) => {
    const claim = await queueClaim();
    const input = { ...claimInput("audit:cleanup-lease", QUEUES.audit, claim), maxAttempts: 1 };
    await claimStep(e.db, e.clock, input);
    const onFinalFailure = async (tx: typeof e.db) => {
      await tx.insert(companies).values({ name: "保存しない後始末" });
      await tx.execute(sql`update pgboss.job set heartbeat_on = clock_timestamp() - interval '121 seconds'`);
    };
    if (mode === "finish") {
      expect(
        await finishStep(e.db, e.clock, {
          ...input,
          attempt: 1,
          outcome: { ok: false, reason: "stop", final: true },
          onFinalFailure,
        }),
      ).toBe(false);
    } else {
      e.clock.advance(3_600_001);
      expect(await claimStep(e.db, e.clock, { ...input, onFinalFailure })).toMatchObject({ kind: "superseded" });
    }
    expect(await e.db.select().from(companies)).toHaveLength(0);
    expect(await readStepState(e.db, input.key)).toMatchObject({ running: true, gaveUp: false });
  });

  it("キューの再取得を確認した場合だけ、1時間を待たず次の親試行を開始する", async () => {
    const claim = await queueClaim();
    const input = claimInput("audit:takeover", QUEUES.audit, claim);
    expect(await claimStep(e.db, e.clock, input)).toMatchObject({ attempt: 1 });
    expect(await claimStep(e.db, e.clock, input)).toMatchObject({ kind: "duplicate", state: "running" });
    const other = await queueClaim();
    expect(await claimStep(e.db, e.clock, { ...input, queueClaim: other })).toMatchObject({ kind: "duplicate" });
    await e.db.execute(sql`update pgboss.job set retry_count = 1 where id = ${claim.id}::uuid`);
    expect(await claimStep(e.db, e.clock, { ...input, queueClaim: { ...claim, retryCount: 1 } })).toMatchObject({
      attempt: 2,
      recoveredStale: true,
    });
    expect(await claimStep(e.db, e.clock, input)).toEqual({ kind: "superseded" });
    expect(await finishStep(e.db, e.clock, { ...input, attempt: 1, outcome: { ok: true } })).toBe(false);
    expect(await readStepState(e.db, input.key)).toMatchObject({ attempts: 2, running: true });
  });

  it("監視処理がまだactiveを閉じていなくても期限切れの保存を拒否する", async () => {
    const claim = await queueClaim();
    const input = claimInput("audit:expired", QUEUES.audit, claim);
    await claimStep(e.db, e.clock, input);
    await e.db.execute(sql`update pgboss.job set heartbeat_on = clock_timestamp() - interval '121 seconds'`);
    await expect(
      runOwnedStep(
        e.db,
        input.key,
        1,
        new AbortController().signal,
        async (tx) => {
          await tx.insert(companies).values({ name: "保存してはいけない" });
        },
        { queue: QUEUES.audit, claim },
      ),
    ).rejects.toBeInstanceOf(StepOwnershipLost);
    expect(await e.db.select().from(companies)).toHaveLength(0);
    expect(await finishStep(e.db, e.clock, { ...input, attempt: 1, outcome: { ok: true } })).toBe(false);
  });

  it("更新中にキューの期限が切れた場合は業務更新をロールバックする", async () => {
    const claim = await queueClaim();
    const input = claimInput("audit:commit-expired", QUEUES.audit, claim);
    await claimStep(e.db, e.clock, input);
    await expect(
      runOwnedStep(
        e.db,
        input.key,
        1,
        new AbortController().signal,
        async (tx) => {
          await tx.insert(companies).values({ name: "ロールバック" });
          await tx.execute(sql`update pgboss.job set started_on = clock_timestamp() - interval '2 hours'`);
        },
        { queue: QUEUES.audit, claim },
      ),
    ).rejects.toBeInstanceOf(StepOwnershipLost);
    expect(await e.db.select().from(companies)).toHaveLength(0);
  });

  it("キューからの中断は待機中の親と子の信号へ伝わり、所有権喪失後は終了を確定しない", async () => {
    const claim = await queueClaim();
    const controller = new AbortController();
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let childSignal: AbortSignal | undefined;
    const def: StepDefinition<null, never> = {
      kind: "audit",
      queue: QUEUES.audit,
      key: () => "audit:signal",
      async run(_deps, _payload, ctx) {
        childSignal = ctx.signal;
        ready();
        return new Promise(() => {});
      },
    };
    const running = executeStep(e.deps, def, null, { queueClaim: claim, signal: controller.signal });
    await entered;
    await e.db.execute(sql`update pgboss.job set state = 'retry'`);
    controller.abort();
    expect(await running).toMatchObject({ status: "superseded", attempt: 1 });
    expect(childSignal?.aborted).toBe(true);
    expect(await readStepState(e.db, "audit:signal")).toMatchObject({ running: true });
  });
});

describe("再試行終了後の後始末", () => {
  it.each(["failed", "cancelled", "completed", "missing"])(
    "キューが%sなら未完了診断と親を一度だけ閉じる",
    async (state) => {
      const s = await seedAudit();
      const claim = await queueClaim();
      await claimStep(e.db, e.clock, claimInput(s.key, QUEUES.audit, claim, s.payload));
      if (state === "missing") await e.db.execute(sql`delete from pgboss.job`);
      else await e.db.execute(sql`update pgboss.job set state = ${state}`);
      expect(await recoverPipelineSteps(e.deps)).toEqual([s.key]);
      expect(await recoverPipelineSteps(e.deps)).toEqual([]);
      expect((await e.db.select().from(siteAudits))[0]!.status).toBe("failed");
      expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe("failed");
      expect(await readStepState(e.db, s.key)).toMatchObject({ running: false, gaveUp: true });
      const events = await e.db.select().from(auditEvents);
      expect(events.filter((r) => r.action === "site_audit.failed")).toHaveLength(1);
    },
  );

  it("稼働中・再試行待ちと旧形式の試行は推測で閉じない", async () => {
    const s = await seedAudit();
    const claim = await queueClaim();
    await claimStep(e.db, e.clock, claimInput(s.key, QUEUES.audit, claim, s.payload));
    e.clock.advance(10_000_000);
    expect(await recoverPipelineSteps(e.deps)).toEqual([]);
    await e.db.execute(sql`update pgboss.job set state = 'retry'`);
    expect(await recoverPipelineSteps(e.deps)).toEqual([]);
    await claimStep(e.db, e.clock, claimInput("audit:legacy", QUEUES.audit));
    expect(await recoverPipelineSteps(e.deps)).toEqual([]);
    expect(await readStepState(e.db, "audit:legacy")).toMatchObject({ running: true });
  });

  it("監査保存失敗では後始末全体を戻し、後の実行で回復する", async () => {
    const s = await seedAudit();
    const claim = await queueClaim();
    await claimStep(e.db, e.clock, claimInput(s.key, QUEUES.audit, claim, s.payload));
    await e.db.execute(sql`update pgboss.job set state = 'failed'`);
    await e.db.execute(
      sql`create function reject_recovery() returns trigger language plpgsql as $$ begin if NEW.action = 'worker.step_failed' then raise exception 'test rollback'; end if; return NEW; end $$`,
    );
    await e.db.execute(
      sql`create trigger reject_recovery before insert on audit_events for each row execute function reject_recovery()`,
    );
    await expect(recoverPipelineSteps(e.deps)).rejects.toThrow();
    expect((await e.db.select().from(siteAudits))[0]!.status).toBe("scoring");
    expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe("site_confirmed");
    await e.db.execute(sql`drop trigger reject_recovery on audit_events`);
    expect(await recoverPipelineSteps(e.deps)).toEqual([s.key]);
  });

  it.each([
    ["evaluated", "create", "audited", true],
    ["evaluated", "hold", "on_hold", false],
    ["evaluated", "skip", "audited", false],
    ["unevaluable", "hold", "on_hold", false],
  ] as const)(
    "最後の試行が結果保存直後に停止した%s/%sを再採点せず回復する",
    async (status, decision, companyStatus, queued) => {
      const s = await seedAudit();
      const claim = await queueClaim();
      await claimStep(e.db, e.clock, claimInput(s.key, QUEUES.audit, claim, s.payload));
      await e.db.update(siteAudits).set({ status, decision });
      await e.db.execute(sql`update pgboss.job set state = 'failed'`);
      expect(await recoverPipelineSteps(e.deps)).toEqual([s.key]);
      expect(await readStepState(e.db, s.key)).toMatchObject({ succeeded: true, gaveUp: false });
      expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe(companyStatus);
      expect(await e.db.select().from(proposalHandoffs)).toHaveLength(queued ? 1 : 0);
      expect(e.generator.calls).toHaveLength(0);
      expect(await recoverPipelineSteps(e.deps)).toEqual([]);
    },
  );

  it("引き継ぎ保存済みの診断は成功を回復し、企業を失敗へ戻さない", async () => {
    const s = await seedAudit();
    const claim = await queueClaim();
    await claimStep(e.db, e.clock, claimInput(s.key, QUEUES.audit, claim, s.payload));
    await e.db.update(siteAudits).set({ status: "evaluated", decision: "create" });
    await e.db.update(companies).set({ pipelineStatus: "audited" });
    await e.db.insert(proposalHandoffs).values({ sourceStepKey: s.key, companyId: s.c.id, auditId: s.a.id });
    await e.db.execute(sql`update pgboss.job set state = 'failed'`);
    expect(await recoverPipelineSteps(e.deps)).toEqual([s.key]);
    expect(await readStepState(e.db, s.key)).toMatchObject({ succeeded: true, gaveUp: false });
    expect((await e.db.select().from(companies))[0]!.pipelineStatus).toBe("audited");
  });

  it.each(["generating", "in_review", "design"])(
    "提案の%s状態に合わせて停止または保存済みの成功を回復する",
    async (status) => {
      const s = await seedAudit();
      await e.db.update(siteAudits).set({ status: "evaluated", decision: "create" });
      const payload = { companyId: s.c.id, auditId: s.a.id, revision: "initial" };
      const key = stepKeys.proposal(payload);
      const claim = await queueClaim(QUEUES.proposal);
      await claimStep(e.db, e.clock, claimInput(key, QUEUES.proposal, claim, payload));
      if (status === "design") {
        await createDesign(e.db, e.clock, actor, {
          companyId: s.c.id,
          auditId: s.a.id,
          requestKey: `initial:${createHash("sha256").update(key).digest("hex")}`,
          brief: DEFAULT_DESIGN_BRIEF,
          source: "import",
        });
      } else {
        const version = await ensureProposalVersion(e.db, e.clock, { ...payload, idempotencyKey: key });
        if (status === "in_review") {
          await e.db.update(proposalVersions).set({ status: "in_review" }).where(eq(proposalVersions.id, version.id));
          await e.db.update(companies).set({ pipelineStatus: "in_review" });
        }
      }
      await e.db.execute(sql`update pgboss.job set state = 'failed'`);
      expect(await recoverPipelineSteps(e.deps)).toEqual([key]);
      expect(await readStepState(e.db, key)).toMatchObject({
        succeeded: status !== "generating",
        gaveUp: status === "generating",
      });
      if (status !== "design")
        expect((await e.db.select().from(proposalVersions))[0]!.status).toBe(
          status === "generating" ? "failed" : "in_review",
        );
    },
  );
});
