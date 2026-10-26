/**
 * デモ専用のDB。PGliteをPostgreSQLのプロトコルで公開し、起動時にマイグレーションを当てる。
 * データは .data/demo/pglite に置く（Gitに入れない。pnpm demo:reset で消す）。
 * 開発用の pnpm dev:db（.data/pglite）とはデータを分ける。本番・実PostgreSQLの検証の代わりにはならない。
 *
 * demo/ はワークスペースのパッケージではないため、PGlite・drizzle は packages/db の依存から読み込む
 * （packages/db/src/dev-server.ts と同じ版）。接続の受け口は pglite-socket ではなく packages/db/src/pglite-server.ts を使う。
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { type PGliteLike, startPGliteServer } from "../packages/db/src/pglite-server.ts";
import { ensurePlainDirectory } from "./backup/bundle.ts";
import { startBackupControl } from "./backup/control.ts";
import { acquireOwner } from "./backup/owner.ts";
import { pgliteRuntime } from "./backup/runtime.ts";
import { verifySnapshot } from "./backup/verify.ts";
import { DEMO_PATHS, DEMO_PORTS, REPO_ROOT } from "./paths.ts";

interface DrizzleModule {
  drizzle(db: PGliteLike): unknown;
}
interface MigratorModule {
  migrate(db: unknown, opts: { migrationsFolder: string }): Promise<void>;
}

const fromDb = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { PGlite, version: engineVersion } = pgliteRuntime();
const { drizzle } = fromDb("drizzle-orm/pglite") as DrizzleModule;
const { migrate } = fromDb("drizzle-orm/pglite/migrator") as MigratorModule;

if (process.env.DEMO_RESTORE_DIR) {
  const receipt = JSON.parse(await readFile(path.join(DEMO_PATHS.data, "restore-receipt.json"), "utf8"));
  if (receipt.engineVersion !== engineVersion) throw new Error("保存時と同じPGliteの版で復元デモを起動してください。");
}

const lease = await acquireOwner(DEMO_PATHS.data);
await ensurePlainDirectory(DEMO_PATHS.pglite);
console.log("[db] PGliteのデータを開いています");
const db = await PGlite.create(DEMO_PATHS.pglite);
console.log("[db] マイグレーションを適用しています");
await migrate(drizzle(db), { migrationsFolder: DEMO_PATHS.migrations });
// web・プレビュー・ワーカー（pg-boss を含む）の接続を受ける。PGlite は1セッションで、
// 問い合わせの単位（Syncまで）・トランザクションの単位で1つの接続に専有させる（pglite-server.ts）
const server = await startPGliteServer(db, { port: DEMO_PORTS.db, host: "127.0.0.1" });
console.log(`[db] デモ用DB（PGlite）を起動した：127.0.0.1:${DEMO_PORTS.db}（マイグレーション済み）`);

let stopping = false;
let control: Awaited<ReturnType<typeof startBackupControl>> | undefined;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await control?.stop();
  await server.stop();
  await db.close();
  await lease.release();
  console.log("[db] 停止した");
  process.exit(0);
};
control = await startBackupControl({
  db,
  server,
  dataRoot: DEMO_PATHS.data,
  backupRoot: DEMO_PATHS.backups,
  artifactRoots: [DEMO_PATHS.artifacts, DEMO_PATHS.audits, path.join(REPO_ROOT, "reports")],
  engineVersion,
  ownerNonce: lease.owner.nonce,
  verify: async (file, password, signal) => {
    const restoreRoot = await ensurePlainDirectory(path.join(DEMO_PATHS.backups, "verification"));
    return verifySnapshot({
      file,
      restoreRoot,
      password,
      signal,
      engineVersion,
      create: (dataDir, loadDataDir) => PGlite.create({ dataDir, loadDataDir }),
    });
  },
  stop: () => {
    if (process.connected && process.send) process.send({ type: "siteoffer.stop.requested" });
    else void stop();
  },
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("disconnect", () => {
  void stop();
});
process.on("message", (message) => {
  if (message && typeof message === "object" && "type" in message && message.type === "siteoffer.stop") void stop();
});
