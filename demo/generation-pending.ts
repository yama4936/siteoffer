import { createRequire } from "node:module";

export interface PendingWork {
  kind: string;
  n: number;
}
export type ReadQuery = (text: string) => Promise<{ rows: Record<string, unknown>[] }>;

/** Only counts leave the DB. Check intake/outbox sources as well as already queued jobs. */
export async function pendingGenerationWork(query: ReadQuery): Promise<PendingWork[]> {
  const result = await query(`
    select '生成・停止確認' as kind, count(*)::int as n from generation_jobs where status in ('queued','running','needs_review')
    union all select '企業収集',count(*)::int from discovery_jobs where status in ('queued','running')
    union all select 'サイト診断',count(*)::int from site_audits where status in ('queued','collecting','scoring')
    union all select '診断受付',count(*)::int from audit_requests where finished_at is null
    union all select 'デザイン生成',count(*)::int from design_versions where status in ('queued','generating')
    union all select '画像承認後の制作受付',count(*)::int from design_versions d
      where d.status='approved' and d.build_requested_at is not null
        and not exists (select 1 from proposal_versions p where p.content->>'designVersionId'=d.id::text)
    union all select '提案引き継ぎ',count(*)::int from proposal_handoffs where sent_at is null
    union all select '提案制作',count(*)::int from proposal_versions where status='generating'
    union all select '納品制作',count(*)::int from deliveries where status='building'
    union all select '納品の制作回',count(*)::int from delivery_builds where status in ('queued','running')
    union all select '稼働通知（停止後45秒まで残ります）',count(*)::int from worker_runtimes
      where heartbeat_at > now()-interval '45 seconds'
  `);
  const steps = await query(`with latest as (
    select distinct on (target_id) target_id, "after" as detail from audit_events
    where target_type='worker_step' and action='worker.step_started'
      and "after"->>'queue' in ('pipeline.discovery','pipeline.audit','pipeline.proposal')
    order by target_id, case when "after"->>'attempt' ~ '^[0-9]{1,9}$'
      then ("after"->>'attempt')::integer else 0 end desc
  ) select '未終了の工程' as kind,count(*)::int as n from latest l where not exists (
    select 1 from audit_events e where e.target_type='worker_step' and e.target_id=l.target_id
      and e."after"->>'attempt'=l.detail->>'attempt'
      and (e.action='worker.step_succeeded' or (e.action='worker.step_failed' and e."after"->>'final'='true'))
  )`);
  const tables = await query("select to_regclass('pgboss.job') is not null as present");
  const queue =
    tables.rows[0]?.present === true
      ? await query(`select '制作キュー' as kind,count(*)::int as n from pgboss.job
        where name in ('pipeline.discovery','pipeline.audit','pipeline.proposal') and state in ('created','retry','active')`)
      : { rows: [] };
  return [...result.rows, ...steps.rows, ...queue.rows].map((row) => {
    const n = Number(row.n);
    if (typeof row.kind !== "string" || !Number.isSafeInteger(n) || n < 0)
      throw new Error("未完了処理の件数を確認できません。");
    return { kind: row.kind, n };
  });
}

type GenerationMode = "mock" | "codex";

export async function lastDemoGenerationMode(query: ReadQuery): Promise<GenerationMode | null> {
  const { rows } = await query(`select "after"->>'generator' as generator from audit_events
    where actor_kind='system' and action='demo.generation_mode_selected' and target_type='demo_runtime'
      and target_id='local' order by created_at desc,id desc limit 1`);
  if (!rows.length) return null;
  const mode = rows[0]?.generator;
  if (mode !== "codex" && mode !== "mock") throw new Error("前回の生成方式を確認できません。");
  return mode;
}

/** The marker lives in the existing audit trail, so backup/restore keeps the switch boundary. */
export async function recordDemoGenerationMode(query: ReadQuery, mode: GenerationMode): Promise<void> {
  if (mode !== "codex" && mode !== "mock") throw new Error("生成方式を確認できません。");
  // Only these two fixed literals are ever interpolated; no shell or environment value enters SQL.
  const detail = mode === "codex" ? '{"generator":"codex"}' : '{"generator":"mock"}';
  await query(`insert into audit_events (actor_kind,action,target_type,target_id,"after",created_at)
    values ('system','demo.generation_mode_selected','demo_runtime','local','${detail}'::jsonb,
      greatest(clock_timestamp(), (select max(created_at)+interval '1 microsecond' from audit_events
        where actor_kind='system' and action='demo.generation_mode_selected' and target_type='demo_runtime' and target_id='local')))`);
}

async function withLaunchDb<T>(databaseUrl: string, use: (query: ReadQuery) => Promise<T>): Promise<T> {
  const fromDb = createRequire(new URL("../packages/db/package.json", import.meta.url));
  const { Pool } = fromDb("pg") as {
    Pool: new (
      options: Record<string, unknown>,
    ) => {
      connect(): Promise<{ query: ReadQuery; release(): void }>;
      end(): Promise<void>;
    };
  };
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000 });
  try {
    const client = await pool.connect();
    try {
      return await use((text) => client.query(text));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** Connect only to the launcher's local DB, without migrations, locks, enqueueing or updates. */
export async function inspectPendingGenerationWork(databaseUrl: string): Promise<PendingWork[]> {
  return withLaunchDb(databaseUrl, async (query) => {
    await query("begin transaction isolation level repeatable read read only");
    try {
      return await pendingGenerationWork(query);
    } finally {
      await query("rollback");
    }
  });
}

/** Gate both directions. Ordinary mock resumes keep their existing recovery behavior. */
export async function prepareDemoGenerationMode(query: ReadQuery, mode: GenerationMode): Promise<void> {
  const previous = await lastDemoGenerationMode(query);
  if (previous === mode || (mode === "mock" && previous === null)) return;
  const pending = (await pendingGenerationWork(query)).filter((row) => row.n > 0);
  if (pending.length)
    throw new Error(
      `未完了処理・稼働通知があります：${pending.map((row) => `${row.kind} ${row.n}件`).join("、")}。元の生成方式で処理状況を確認してください。ワーカーは起動していません。`,
    );
  await recordDemoGenerationMode(query, mode);
}

export async function selectDemoGenerationMode(databaseUrl: string, mode: GenerationMode): Promise<void> {
  await withLaunchDb(databaseUrl, async (query) => {
    await query("begin transaction isolation level repeatable read");
    try {
      await prepareDemoGenerationMode(query, mode);
      await query("commit");
    } catch (error) {
      await query("rollback");
      throw error;
    }
  });
}
