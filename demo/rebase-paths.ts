/**
 * 別の場所から複製したデモデータの、DBに保存された成果物の絶対パスを付け替える。
 *
 *   node --import tsx demo/rebase-paths.ts <複製元のリポジトリのルート>
 *
 * 対象は proposal_versions.demo_artifact_dir・delivery_versions.artifact_dir・site_audits.artifact_dir の、
 * 複製元のルートの下を指す値だけ。ルート直下の同じ相対位置（.data/demo/…・reports/…）へ置き換える。
 * DBを停止した状態で実行する（利用記録を取得し、稼働中なら失敗する）。1トランザクションで更新する。
 */
import path from "node:path";
import { acquireOwner } from "./backup/owner.ts";
import { pgliteRuntime } from "./backup/runtime.ts";
import { DEMO_PATHS, REPO_ROOT } from "./paths.ts";

const REF = [
  ["proposal_versions", "demo_artifact_dir"],
  ["delivery_versions", "artifact_dir"],
  ["site_audits", "artifact_dir"],
] as const;

/** value が from の下なら to の下の同じ相対位置を返す。外・同じ場所なら null */
export function rebasePath(value: string, from: string, to: string): string | null {
  const relative = path.relative(path.resolve(from), path.resolve(value));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  const next = path.join(path.resolve(to), relative);
  return next === value ? null : next;
}

async function main() {
  if (process.argv.length !== 3) throw new Error("使い方：demo/rebase-paths.ts <複製元のリポジトリのルート>");
  const from = path.resolve(process.argv[2]!);
  const to = path.resolve(REPO_ROOT);
  if (from === to) throw new Error("複製元と現在のリポジトリが同じです。");

  const lease = await acquireOwner(DEMO_PATHS.data);
  const { PGlite } = pgliteRuntime();
  const db = await PGlite.create(DEMO_PATHS.pglite);
  try {
    await db.query("begin");
    let changed = 0;
    for (const [table, column] of REF) {
      const rows = await db.query<{ id: string; dir: string }>(
        `select id::text id, ${column} dir from public.${table} where ${column} is not null`,
      );
      for (const row of rows.rows) {
        const next = rebasePath(row.dir, from, to);
        if (!next) continue;
        await db.query(`update public.${table} set ${column}=$1 where id=$2 and ${column}=$3`, [next, row.id, row.dir]);
        changed++;
      }
    }
    await db.query("commit");
    console.log(`[rebase] 成果物の参照 ${changed} 件を ${to} の下へ付け替えた`);
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    await db.close();
    await lease.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
