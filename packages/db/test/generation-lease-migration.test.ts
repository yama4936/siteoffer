import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("旧DBの未完了ジョブだけに移行時からの猶予を与え、既存の結果と時刻を維持する", async () => {
  const client = new PGlite();
  const root = fileURLToPath(new URL("../drizzle/", import.meta.url));
  try {
    // このテストは0020までの実スキーマから0021へ移行する。将来の変更を混ぜない。
    for (const name of (await readdir(root))
      .filter((n) => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= 20)
      .sort()) {
      await client.exec(await readFile(path.join(root, name), "utf8"));
    }
    for (const status of ["queued", "running", "succeeded", "failed", "cancelled", "needs_review"]) {
      await client.query(
        `insert into generation_jobs (idempotency_key,purpose,status,generator,prompt_version,created_at,started_at,finished_at,output)
        values ($1,'faq',$2::text::generation_job_status,'mock','migration-test','2026-01-01','2026-01-02',case when $2::text in ('queued','running') then null else '2026-01-03'::timestamptz end,'{"preserved":true}')`,
        [status, status],
      );
    }
    const before = (
      await client.query<Record<string, unknown>>("select * from generation_jobs order by idempotency_key")
    ).rows;
    const start = Date.now();
    await client.exec(await readFile(path.join(root, "0021_lean_black_queen.sql"), "utf8"));
    const end = Date.now();
    const after = (
      await client.query<Record<string, unknown>>("select * from generation_jobs order by idempotency_key")
    ).rows;
    expect(after.map(({ lease_until, ...r }) => r)).toEqual(before);
    for (const row of after) {
      if (row.status === "queued" || row.status === "running") {
        const deadline = (row.lease_until as Date).getTime();
        expect(deadline).toBeGreaterThanOrEqual(start + 120000);
        expect(deadline).toBeLessThanOrEqual(end + 120000);
      } else expect(row.lease_until).toBeNull();
    }
    expect(
      (await client.query("select indexname from pg_indexes where indexname='generation_jobs_lease'")).rows,
    ).toHaveLength(1);
  } finally {
    await client.close();
  }
});
