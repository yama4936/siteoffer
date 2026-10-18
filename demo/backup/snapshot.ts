import { createHash, randomUUID } from "node:crypto";
import { constants, openAsBlob } from "node:fs";
import { copyFile, lstat, mkdir, open, opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertPlainDirectory,
  BackupError,
  type BackupManifest,
  type BackupSource,
  fileSource,
  readBundle,
  removeOwnedDirectory,
  writeBundle,
} from "./bundle.ts";

export interface SnapshotDb {
  query<T extends Record<string, unknown>>(text: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
  dumpDataDir(compression: "gzip"): Promise<Blob>;
  close(): Promise<void>;
}
export type SnapshotOptions = {
  dataRoot: string;
  backupRoot: string;
  artifactRoots: string[];
  engineVersion: string;
  password: string;
  signal?: AbortSignal;
  progress?: (phase: string, files: number) => void;
};
const REF = {
  proposal_versions: "demo_artifact_dir",
  delivery_versions: "artifact_dir",
  site_audits: "artifact_dir",
} as const;
async function* blobChunks(blob: Blob) {
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      yield Buffer.from(part.value);
    }
  } finally {
    reader.releaseLock();
  }
}
function inside(file: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function* files(directory: string, prefix: string): AsyncGenerator<{ name: string; file: string }> {
  await assertPlainDirectory(directory);
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const file = path.join(directory, entry.name),
      info = await lstat(file),
      name = `${prefix}/${entry.name}`;
    if (info.isSymbolicLink()) throw new BackupError("成果物にリンクがあります。保存対象を確認してください。");
    if (info.isDirectory()) yield* files(file, name);
    else if (info.isFile()) yield { name, file };
    else throw new BackupError("通常の成果物だけを保存できます。");
  }
}
export type DatabaseCapture = {
  dump: Blob;
  createdAt: string;
  serverVersion: string;
  tables: NonNullable<BackupManifest["tables"]>;
  references: { table: keyof typeof REF; id: string; original: string }[];
};
/** Only DB inventory and its native snapshot need the protocol session lock. */
export async function captureDatabase(db: SnapshotDb, signal?: AbortSignal): Promise<DatabaseCapture> {
  signal?.throwIfAborted();
  const version = await db.query<{ server_version: string }>("show server_version");
  const tables: NonNullable<BackupManifest["tables"]> = [];
  const catalog = await db.query<{ table_schema: string; table_name: string }>(
    "select table_schema,table_name from information_schema.tables where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema') and left(table_schema,8) <> 'pg_temp_' and left(table_schema,14) <> 'pg_toast_temp_' order by table_schema,table_name",
  );
  for (const table of catalog.rows) {
    signal?.throwIfAborted();
    const counted = await db.query<{ n: string }>(
      `select count(*)::text n from "${table.table_schema.replaceAll('"', '""')}"."${table.table_name.replaceAll('"', '""')}"`,
    );
    const rows = Number(counted.rows[0]!.n);
    if (!Number.isSafeInteger(rows)) throw new BackupError("DBの件数を照合できません。");
    tables.push({ schema: table.table_schema, name: table.table_name, rows });
  }
  const references: DatabaseCapture["references"] = [];
  for (const [table, column] of Object.entries(REF)) {
    const result = await db.query<{ id: string; directory: string }>(
      `select id, ${column} as directory from public.${table} where ${column} is not null order by id`,
    );
    references.push(
      ...result.rows.map((row) => ({ table: table as keyof typeof REF, id: row.id, original: row.directory })),
    );
  }
  signal?.throwIfAborted();
  const dump = await db.dumpDataDir("gzip");
  signal?.throwIfAborted();
  return {
    dump,
    tables,
    references,
    serverVersion: version.rows[0]!.server_version,
    createdAt: new Date().toISOString(),
  };
}
/** For offline use. A live host captures under its lock, then calls saveSnapshot outside it. */
export async function createSnapshot(db: SnapshotDb, options: SnapshotOptions) {
  options.progress?.("snapshot", 0);
  return saveSnapshot(await captureDatabase(db, options.signal), options);
}
/** Artifacts are immutable published directories. Hashes detect mutation while copying. No live DB calls here. */
export async function saveSnapshot(snapshot: DatabaseCapture, options: SnapshotOptions) {
  const { signal } = options;
  signal?.throwIfAborted();
  await assertPlainDirectory(options.dataRoot);
  await assertPlainDirectory(options.backupRoot);
  if (inside(options.backupRoot, options.dataRoot))
    throw new BackupError("バックアップは元のデータとは別の保存先を指定してください。");
  if (!/^\d+\.\d+\.\d+([-.][a-zA-Z0-9.-]+)?$/.test(options.engineVersion))
    throw new BackupError("DBの版を確認できません。");
  const roots = options.artifactRoots.map((root) => path.resolve(root));
  const references: BackupManifest["references"] = [],
    sources: BackupSource[] = [],
    directories = new Map<string, string>();
  const recoveryKey = (await readFile(path.join(options.dataRoot, "share-token-key"), "utf8")).trim();
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(recoveryKey) ||
    Buffer.from(recoveryKey, "base64url").toString("base64url") !== recoveryKey
  )
    throw new BackupError("共有リンクの復旧鍵を確認できません。元の鍵を確認してください。");
  const credentials = JSON.parse(await readFile(path.join(options.dataRoot, "users.json"), "utf8"));
  if (!Array.isArray(credentials) || credentials.some((value) => !value || typeof value.email !== "string"))
    throw new BackupError("デモ用アカウントの記録を確認できません。");
  for (const row of snapshot.references) {
    signal?.throwIfAborted();
    const resolved = path.resolve(row.original);
    if (!path.isAbsolute(row.original) || !roots.some((root) => inside(resolved, root)))
      throw new BackupError("保存対象外の場所に成果物があります。成果物の保存先を確認してください。");
    await assertPlainDirectory(resolved);
    const canonical = await realpath(resolved),
      key = process.platform === "win32" ? canonical.toUpperCase() : canonical;
    let directory = directories.get(key);
    if (!directory) {
      directory = `artifacts/${randomUUID()}`;
      directories.set(key, directory);
      for await (const entry of files(canonical, directory)) {
        signal?.throwIfAborted();
        sources.push(await fileSource(entry.name, entry.file));
        options.progress?.("files", sources.length);
      }
    }
    references.push({ table: row.table, id: row.id, original: row.original, directory });
  }
  for (const file of ["share-token-key", "users.json"]) {
    signal?.throwIfAborted();
    sources.push(await fileSource(`settings/${file}`, path.join(options.dataRoot, file)));
  }
  const dump = snapshot.dump;
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  for await (const chunk of blobChunks(dump)) hash.update(chunk);
  sources.unshift({
    name: "database.pglite.tgz",
    size: dump.size,
    sha256: hash.digest("hex"),
    read: () => blobChunks(dump),
  });
  const manifest: BackupManifest = {
    format: 1,
    createdAt: snapshot.createdAt,
    engine: "pglite",
    engineVersion: options.engineVersion,
    serverVersion: snapshot.serverVersion,
    records: sources.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    tables: snapshot.tables,
    references,
  };
  const directory = path.join(options.backupRoot, `backup-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  try {
    options.progress?.("encrypt", sources.length);
    const file = await writeBundle(directory, manifest, sources, options.password, signal);
    return { file, files: sources.length, bytes: (await stat(file)).size, createdAt: manifest.createdAt };
  } catch (e) {
    await removeOwnedDirectory(directory, options.backupRoot);
    throw e;
  }
}
export type RestoreOptions = {
  file: string;
  restoreRoot: string;
  password: string;
  engineVersion: string;
  create: (directory: string, data: Blob) => Promise<SnapshotDb>;
  signal?: AbortSignal;
};
/** A restore always creates a new directory and never opens or replaces the live data directory. */
export async function restoreSnapshot(options: RestoreOptions) {
  await assertPlainDirectory(options.restoreRoot);
  const directory = path.join(options.restoreRoot, `backup-${randomUUID()}`);
  let db: SnapshotDb | undefined,
    created = false;
  let archiveSha256 = "",
    archiveBytes = 0,
    archiveMtimeMs = 0;
  try {
    const manifest = await readBundle(
      options.file,
      directory,
      options.password,
      options.signal,
      () => {
        created = true;
      },
      (hash, bytes, mtime) => {
        archiveSha256 = hash;
        archiveBytes = bytes;
        archiveMtimeMs = mtime;
      },
    );
    if (manifest.engineVersion !== options.engineVersion)
      throw new BackupError("保存時と同じPGliteの版で復元してください。");
    if (
      manifest.records.filter((r) => r.name === "database.pglite.tgz").length !== 1 ||
      !["settings/share-token-key", "settings/users.json"].every((name) =>
        manifest.records.some((r) => r.name === name),
      ) ||
      manifest.records.some(
        (r) =>
          r.name !== "database.pglite.tgz" &&
          !["settings/share-token-key", "settings/users.json"].includes(r.name) &&
          !/^artifacts\/[a-f0-9-]{36}\//.test(r.name),
      )
    )
      throw new BackupError("必要なDB・復旧鍵・成果物の目録を確認してください。");
    options.signal?.throwIfAborted();
    if (!manifest.tables?.length) throw new BackupError("DBの照合目録がありません。");
    db = await options.create(
      path.join(directory, "pglite"),
      await openAsBlob(path.join(directory, "database.pglite.tgz")),
    );
    for (const table of manifest.tables) {
      options.signal?.throwIfAborted();
      const result = await db.query<{ n: string }>(
        `select count(*)::text n from "${table.schema.replaceAll('"', '""')}"."${table.name.replaceAll('"', '""')}"`,
      );
      if (Number(result.rows[0]!.n) !== table.rows) throw new BackupError("復元したDBの件数が保存時と一致しません。");
    }
    for (const reference of manifest.references) {
      options.signal?.throwIfAborted();
      const artifact = path.join(directory, ...reference.directory.split("/"));
      await mkdir(artifact, { recursive: true, mode: 0o700 });
      await assertPlainDirectory(artifact);
      const column = REF[reference.table];
      const result = await db.query<{ id: string }>(
        `update public.${reference.table} set ${column}=$1 where id=$2 and ${column}=$3 returning id`,
        [artifact, reference.id, reference.original],
      );
      if (result.rows.length !== 1) throw new BackupError("DBと成果物の参照が一致しません。");
    }
    for (const file of ["share-token-key", "users.json"])
      await copyFile(path.join(directory, "settings", file), path.join(directory, file), constants.COPYFILE_EXCL);
    await db.close();
    db = undefined;
    const receipt = {
      format: 1,
      restoredAt: new Date().toISOString(),
      backupCreatedAt: manifest.createdAt,
      engineVersion: manifest.engineVersion,
      files: manifest.records.length,
      references: manifest.references.length,
      tables: manifest.tables.length,
      archiveSha256,
      archiveBytes,
      archiveMtimeMs,
    };
    const out = path.join(directory, "restore-receipt.json"),
      handle = await open(out, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(receipt, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { directory, ...receipt };
  } catch (e) {
    await db?.close().catch(() => {});
    if (created) {
      try {
        await removeOwnedDirectory(directory, options.restoreRoot);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT")
          throw new BackupError("復元に失敗しました。隔離した一時データの後始末も確認してください。");
      }
    }
    throw e;
  }
}
