import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb } from "../packages/db/src/testing.ts";
import {
  lastDemoGenerationMode,
  pendingGenerationWork,
  prepareDemoGenerationMode,
  type ReadQuery,
  recordDemoGenerationMode,
} from "./generation-pending.ts";
import { generationWorkReadiness } from "./generation-work-readiness.ts";

const fromDb = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { sql } = fromDb("drizzle-orm") as typeof import("../packages/db/node_modules/drizzle-orm/index.js");
let handle: Awaited<ReturnType<typeof createTestDb>>;
let query: ReadQuery;
beforeAll(async () => {
  handle = await createTestDb();
  query = async (text) => {
    const result = (await handle.db.execute(sql.raw(text))) as { rows: Record<string, unknown>[] };
    return { rows: result.rows };
  };
});
afterAll(async () => {
  await handle?.close();
});
const pending = async () => Object.fromEntries((await pendingGenerationWork(query)).map((row) => [row.kind, row.n]));
async function seed(text: string) {
  for (const statement of text.split(";").filter((part) => part.trim())) await query(statement);
}

it("accepts an empty migrated DB before pg-boss is initialized", async () => {
  expect(Object.values(await pending()).every((n) => n === 0)).toBe(true);
});
it("detects unfinished intake and stop confirmation even before a queue job exists", async () => {
  await seed(`insert into companies (id,name) values ('00000000-0000-4000-8000-000000000001','架空の事前確認会社');
    insert into websites (id,company_id,url,normalized_url,domain,kind) values ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','https://test.example/','https://test.example/','test.example','current');
    insert into site_audits (id,company_id,website_id,target_url,status) values
      ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','https://test.example/','queued');
    insert into audit_requests (id,company_id,website_id,target_url,status) values
      ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','https://test.example/','blocked');
    insert into generation_jobs (idempotency_key,purpose,generator,prompt_version,status) values ('preflight','demo_site','codex','test','needs_review');
    insert into discovery_jobs (provider,criteria,status) values ('fixture','{}','running');
    insert into design_versions (id,company_id,audit_id,version,request_key,status,brief,company_snapshot,prompt,source,build_requested_at) values
      ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',1,'preflight','approved','{}','{}','test','upload',now());
    insert into proposal_handoffs (source_step_key,company_id,audit_id) values ('preflight','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003');`);
  const counts = await pending();
  for (const kind of ["生成・停止確認", "企業収集", "サイト診断", "診断受付", "画像承認後の制作受付", "提案引き継ぎ"])
    expect(counts[kind], kind).toBe(1);
  await seed(`insert into proposals (id,company_id) values ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001');
    insert into proposal_versions (proposal_id,version,status,content) values ('00000000-0000-4000-8000-000000000006',1,'in_review','{"designVersionId":"00000000-0000-4000-8000-000000000005"}');`);
  expect((await pending()).画像承認後の制作受付).toBe(0);
});
it("counts pipeline jobs but excludes scheduled maintenance and finished jobs", async () => {
  await seed(`create schema pgboss; create table pgboss.job (name text,state text);
    insert into pgboss.job values ('pipeline.audit','retry'),('pipeline.proposal','created'),
      ('pipeline.discovery','active'),('maintenance.expire','created'),('pipeline.proposal','completed');`);
  expect((await pending()).制作キュー).toBe(3);
});
it("uses the latest step attempt and requires a terminal outcome", async () => {
  await query(`insert into audit_events (actor_kind,action,target_type,target_id,"after") values
    ('system','worker.step_started','worker_step','test-step','{"queue":"pipeline.audit","attempt":1}'),
    ('system','worker.step_failed','worker_step','test-step','{"queue":"pipeline.audit","attempt":1,"final":false}');`);
  expect((await pending()).未終了の工程).toBe(1);
  await query(`insert into audit_events (actor_kind,action,target_type,target_id,"after") values
    ('system','worker.step_started','worker_step','test-step','{"queue":"pipeline.audit","attempt":2}'),
    ('system','worker.step_succeeded','worker_step','test-step','{"queue":"pipeline.audit","attempt":2}');`);
  expect((await pending()).未終了の工程).toBe(0);
});
it("rejects invalid count responses rather than assuming no pending work", async () => {
  await expect(pendingGenerationWork(async () => ({ rows: [{ kind: "test", n: "invalid" }] }))).rejects.toThrow("件数");
});
it("blocks switching in either direction, while allowing recovery in the already selected mode", async () => {
  expect(await lastDemoGenerationMode(query)).toBeNull();
  await expect(prepareDemoGenerationMode(query, "codex")).rejects.toThrow("未完了処理");
  expect(await lastDemoGenerationMode(query)).toBeNull();
  await expect(prepareDemoGenerationMode(query, "mock")).resolves.toBeUndefined();
  await recordDemoGenerationMode(query, "codex");
  expect(await lastDemoGenerationMode(query)).toBe("codex");
  await expect(prepareDemoGenerationMode(query, "codex")).resolves.toBeUndefined();
  await expect(prepareDemoGenerationMode(query, "mock")).rejects.toThrow("未完了処理");
  expect(await lastDemoGenerationMode(query)).toBe("codex");
});
it("records a return to mock only after all intake, generation and queue work is terminal", async () => {
  await seed(`update generation_jobs set status='cancelled'; update discovery_jobs set status='failed';
    update site_audits set status='failed'; update audit_requests set status='cancelled',finished_at=now();
    update proposal_handoffs set sent_at=now(); update pgboss.job set state='completed';`);
  await prepareDemoGenerationMode(query, "mock");
  expect(await lastDemoGenerationMode(query)).toBe("mock");
  await prepareDemoGenerationMode(query, "codex");
  expect(await lastDemoGenerationMode(query)).toBe("codex");
});

it("業務0件でも新しい稼働通知がある間は方式切替を止め、通知の期限後に再確認する", async () => {
  const isolated = await createTestDb();
  const read: ReadQuery = async (text) => {
    const result = (await isolated.db.execute(sql.raw(text))) as { rows: Record<string, unknown>[] };
    return { rows: result.rows };
  };
  try {
    await read(
      `insert into worker_runtimes (id,providers,mode,heartbeat_at) values ('00000000-0000-4000-8000-000000000099','[]','demo',now())`,
    );
    expect(generationWorkReadiness(await pendingGenerationWork(read)).map((row) => row.ok)).toEqual([true, false]);
    await expect(prepareDemoGenerationMode(read, "codex")).rejects.toThrow("稼働通知");
    expect(await lastDemoGenerationMode(read)).toBeNull();
    await read(`update worker_runtimes set heartbeat_at=now()-interval '1 minute'`);
    expect(generationWorkReadiness(await pendingGenerationWork(read)).every((row) => row.ok)).toBe(true);
    await prepareDemoGenerationMode(read, "codex");
    expect(await lastDemoGenerationMode(read)).toBe("codex");
  } finally {
    await isolated.close();
  }
});
