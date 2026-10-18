import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** リポジトリのルート */
export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** 通常は .data/demo。復元確認時だけ .data/restores の検証済みフォルダーを使う（Git対象外）。 */
const RESTORES = path.join(REPO_ROOT, ".data/restores");
const restored = process.env.DEMO_RESTORE_DIR;
const DATA = restored ? path.resolve(restored) : path.join(REPO_ROOT, ".data/demo");
if (restored) {
  if (
    path.dirname(DATA) !== RESTORES ||
    !/^backup-[a-f0-9-]{36}$/.test(path.basename(DATA)) ||
    lstatSync(DATA).isSymbolicLink() ||
    realpathSync(DATA).toLowerCase() !== DATA.toLowerCase()
  )
    throw new Error("完了した復元フォルダーを指定してください。");
  const file = path.join(DATA, "restore-receipt.json"),
    info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("復元の照合記録を確認できません。");
  const receipt = JSON.parse(readFileSync(file, "utf8")) as {
    format: number;
    engineVersion: string;
    restoredAt: string;
  };
  if (
    receipt.format !== 1 ||
    typeof receipt.engineVersion !== "string" ||
    !Number.isFinite(Date.parse(receipt.restoredAt))
  )
    throw new Error("復元の照合記録を確認できません。");
}

export const DEMO_PATHS = {
  data: DATA,
  backups: restored
    ? path.join(REPO_ROOT, ".data/backups/restored", path.basename(DATA))
    : path.join(REPO_ROOT, ".data/backups"),
  restores: RESTORES,
  pglite: path.join(DATA, "pglite"),
  /** デモ用アカウントのログイン情報（自分の端末でだけ見る。権限 600） */
  users: path.join(DATA, "users.json"),
  /** プレビューが配信する成果物（デモサイト・納品サイト）の基点 */
  artifacts: path.join(DATA, "artifacts"),
  demos: path.join(DATA, "artifacts/demos"),
  deliveries: path.join(DATA, "artifacts/deliveries"),
  /** 診断の成果物（collected.json・evaluation.json 等） */
  audits: path.join(DATA, "audits"),
  migrations: path.join(REPO_ROOT, "packages/db/drizzle"),
  evalConfig: "config/site-evaluation.demo.json",
} as const;

export const DEMO_PORTS = {
  db: Number(process.env.DEMO_DB_PORT ?? 54329),
  web: Number(process.env.DEMO_WEB_PORT ?? 3100),
  preview: Number(process.env.DEMO_PREVIEW_PORT ?? 3200),
} as const;

export const DEMO_DATABASE_URL = `postgres://postgres@127.0.0.1:${DEMO_PORTS.db}/postgres`;
