import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { PGliteLike } from "../../packages/db/src/pglite-server.ts";
import { BackupError } from "./bundle.ts";
import type { SnapshotDb } from "./snapshot.ts";

export function pgliteRuntime() {
  const fromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const metadata = JSON.parse(
    readFileSync(path.resolve(path.dirname(fromDb.resolve("@electric-sql/pglite")), "../package.json"), "utf8"),
  ) as { name: string; version: string };
  if (metadata.name !== "@electric-sql/pglite" || !/^\d+\.\d+\.\d+([-.][a-zA-Z0-9.-]+)?$/.test(metadata.version))
    throw new BackupError("インストール済みのDBの版を確認できません。");
  const { PGlite } = fromDb("@electric-sql/pglite") as {
    PGlite: { create(input?: string | { dataDir?: string; loadDataDir?: Blob }): Promise<PGliteLike & SnapshotDb> };
  };
  return { PGlite, version: metadata.version };
}
