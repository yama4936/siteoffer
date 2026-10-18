import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rmdir, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { assertPlainDirectory, BackupError, ensurePlainDirectory } from "./bundle.ts";
import { BACKUP_ID } from "./catalog.ts";
import { retentionPolicy } from "./retention-request.ts";
import { latestVerification } from "./verification-receipt.ts";

export type RetentionPolicy = { keepCount: number; ageDays: number };
type Stamp = { name: string; bytes: number; ino: string; mtime: string; ctime: string; links: number };
type Entry = {
  id: string;
  bytes: number;
  files: Stamp[];
  newest: number;
  savedAt: string;
  verified: boolean;
  pinned: boolean;
  blocked: boolean;
  ino: string;
};
type JournalItem = {
  entry: Entry;
  state: "pending" | "moved" | "restored" | "purged" | "failed";
  purging?: boolean;
  intents?: string[];
};
type Journal = {
  kind: "siteoffer-retention-v1";
  id: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  state: "partial" | "moved" | "restored" | "purged" | "closed";
  items: JournalItem[];
};
const PIN = "retention-pin.json",
  JOURNAL = "journal.json",
  LIMIT = 100;
const allowedFile = (name: string) =>
  ["backup.sob", "backup.partial", PIN].includes(name) || /^verification(?:-[a-f0-9-]{36})?\.json$/.test(name);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function child(root: string, id: string) {
  if (!BACKUP_ID.test(id)) throw new BackupError("整理する保存データを選び直してください。");
  const target = path.resolve(root, id);
  if (path.dirname(target) !== path.resolve(root)) throw new BackupError("保存先の範囲を確認できません。");
  return target;
}
async function json(file: string, max = 1024 * 1024) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max)
    throw new BackupError("保管記録を確認できません。");
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}
async function stamp(file: string): Promise<Stamp> {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new BackupError("通常の保存ファイルだけを整理できます。");
  return {
    name: path.basename(file),
    bytes: Number(info.size),
    ino: info.ino.toString(),
    mtime: info.mtimeNs.toString(),
    ctime: info.ctimeNs.toString(),
    links: Number(info.nlink),
  };
}
async function inspect(root: string, id: string): Promise<Entry> {
  const directory = child(root, id);
  await assertPlainDirectory(directory);
  const dir = await lstat(directory, { bigint: true }),
    names = (await readdir(directory)).sort();
  if (names.length > 1024) throw new BackupError("保存記録が多すぎます。対象を個別に確認してください。");
  const files: Stamp[] = [];
  let blocked = false,
    pinned = false;
  for (const name of names) {
    if (!allowedFile(name)) {
      blocked = true;
      continue;
    }
    try {
      files.push(await stamp(path.join(directory, name)));
    } catch {
      blocked = true;
    }
  }
  try {
    const value = (await json(path.join(directory, PIN), 4096)) as { kind?: unknown; pinned?: unknown };
    if (value?.kind !== "siteoffer-backup-pin-v1" || typeof value.pinned !== "boolean") blocked = true;
    else pinned = value.pinned;
  } catch (error) {
    if (!missing(error)) blocked = true;
  }
  const archive = files.find((file) => file.name === "backup.sob");
  let verified = false;
  if (archive) {
    const receipt = await latestVerification(directory),
      current = await lstat(path.join(directory, "backup.sob"));
    verified = !!receipt && receipt.archiveBytes === current.size && receipt.archiveMtimeMs === current.mtimeMs;
  }
  const newest = Math.max(
    Number(dir.birthtimeNs) / 1e6,
    ...files
      .filter((file) => ["backup.sob", "backup.partial"].includes(file.name))
      .map((file) => Number(file.mtime) / 1e6),
  );
  return {
    id,
    files,
    newest,
    savedAt: new Date(newest).toISOString(),
    ino: dir.ino.toString(),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    verified,
    pinned,
    blocked: blocked || files.some((file) => file.links !== 1),
  };
}
async function ids(root: string) {
  try {
    await assertPlainDirectory(root);
    const names = (await readdir(root)).filter((name) => BACKUP_ID.test(name)).sort();
    if (names.length > 5000) throw new BackupError("保存先が多すぎます。運用担当者へ確認してください。");
    return names;
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}
function stateOf(items: JournalItem[]): Journal["state"] {
  if (items.every((item) => item.state === "purged")) return "purged";
  if (items.every((item) => item.state === "restored")) return "restored";
  if (items.every((item) => item.state === "moved")) return "moved";
  if (items.every((item) => ["purged", "restored", "failed"].includes(item.state))) return "closed";
  return "partial";
}
async function journal(root: string, id: string): Promise<Journal & { needsCommit: boolean }> {
  const directory = child(path.join(root, "trash"), id);
  await assertPlainDirectory(directory);
  const value = (await json(path.join(directory, JOURNAL))) as Journal;
  if (
    value?.kind !== "siteoffer-retention-v1" ||
    value.id !== id ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !["partial", "moved", "restored", "purged", "closed"].includes(value.state) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > LIMIT
  )
    throw new BackupError("退避した保存データの記録を確認できません。");
  const used = new Set<string>();
  const previous = hash([value.state, value.items.map((item) => item?.state)]);
  for (const item of value.items) {
    const entry = item?.entry;
    if (
      !entry ||
      !BACKUP_ID.test(entry.id) ||
      used.has(entry.id) ||
      !Array.isArray(entry.files) ||
      entry.files.length > 1024 ||
      !["pending", "moved", "restored", "purged", "failed"].includes(item.state) ||
      !/^\d+$/.test(entry.ino)
    )
      throw new BackupError("退避記録を確認できません。");
    used.add(entry.id);
    const names = new Set<string>();
    for (const file of entry.files) {
      if (
        !allowedFile(file.name) ||
        names.has(file.name) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.links !== 1 ||
        !/^\d+$/.test(file.ino) ||
        !/^\d+$/.test(file.mtime) ||
        !/^\d+$/.test(file.ctime)
      )
        throw new BackupError("退避ファイルの記録を確認できません。");
      names.add(file.name);
    }
    if (entry.bytes !== entry.files.reduce((sum, file) => sum + file.bytes, 0))
      throw new BackupError("退避容量を照合できません。");
    if (
      (item.purging !== undefined && typeof item.purging !== "boolean") ||
      (item.intents !== undefined &&
        (!Array.isArray(item.intents) ||
          new Set(item.intents).size !== item.intents.length ||
          item.intents.some((name) => !names.has(name))))
    )
      throw new BackupError("削除の途中経過を確認できません。");
    // A crash may happen between rename/unlink and the journal update. Locations are authoritative.
    const source = child(root, entry.id),
      target = child(directory, entry.id);
    // Committed history is independent of subsequent moves/deletions of the original backup.
    if (["restored", "purged", "failed"].includes(item.state)) {
      let exists = true;
      try {
        await lstat(target);
      } catch (error) {
        if (!missing(error)) throw error;
        exists = false;
      }
      if (!exists) continue;
      if (item.state !== "failed")
        throw new BackupError("完了した退避先に別のデータがあります。削除せず確認してください。");
    }
    const location = async (file: string) => {
      try {
        const info = await lstat(file, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink() || info.ino.toString() !== entry.ino)
          throw new BackupError("保管場所が変わっています。");
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    };
    const atSource = await location(source),
      atTarget = await location(target);
    if (atSource && atTarget) throw new BackupError("同じ保存データが複数の保管場所にあります。");
    if (atTarget) item.state = "moved";
    else if (atSource) item.state = item.state === "pending" || item.state === "failed" ? "failed" : "restored";
    else if (!atSource && !atTarget && item.purging && entry.files.every((file) => item.intents?.includes(file.name)))
      item.state = "purged";
    else if (!atSource && !atTarget) throw new BackupError("退避した保存データの保管場所を確認してください。");
  }
  value.state = stateOf(value.items);
  return { ...value, needsCommit: previous !== hash([value.state, value.items.map((item) => item.state)]) };
}
async function remaining(directory: string, item: JournalItem) {
  const target = child(directory, item.entry.id);
  await assertPlainDirectory(target);
  const info = await lstat(target, { bigint: true });
  if (info.ino.toString() !== item.entry.ino) throw new BackupError("退避先の保存データが変わりました。");
  const names = await readdir(target),
    expected = new Map(item.entry.files.map((file) => [file.name, file]));
  if (names.some((name) => !expected.has(name))) throw new BackupError("退避先に記録外のファイルがあります。");
  let bytes = 0;
  for (const file of item.entry.files) {
    try {
      const current = await stamp(path.join(target, file.name));
      if (hash(current) !== hash(file)) throw new BackupError("退避ファイルが変わりました。");
      bytes += current.bytes;
    } catch (error) {
      if (!missing(error) || !item.purging || !item.intents?.includes(file.name)) throw error;
    }
  }
  return bytes;
}
async function atomicRecord(directory: string, name: typeof PIN | typeof JOURNAL, value: unknown) {
  await assertPlainDirectory(directory);
  const temporary = path.join(directory, `${name === PIN ? "pin" : "journal"}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined,
    owned = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    owned = true;
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path.join(directory, name));
  } finally {
    try {
      await handle?.close();
    } finally {
      if (owned) {
        await assertPlainDirectory(directory);
        await unlink(temporary).catch((error) => {
          if (!missing(error)) throw error;
        });
      }
    }
  }
}
async function saveJournal(root: string, value: Journal) {
  const directory = child(path.join(root, "trash"), value.id);
  value.updatedAt = new Date().toISOString();
  const { kind, id, token, createdAt, updatedAt, state, items } = value;
  await atomicRecord(directory, JOURNAL, { kind, id, token, createdAt, updatedAt, state, items });
}
export async function backupStorage(root: string, signal?: AbortSignal) {
  const entries: Entry[] = [],
    batches: (Journal & { needsCommit: boolean; remainingBytes: number; restorable: boolean })[] = [];
  let blocked = 0;
  class InventoryLimitError extends BackupError {}
  let metadataBytes = 0;
  function reserve(value: unknown) {
    metadataBytes += Buffer.byteLength(JSON.stringify(value));
    if (metadataBytes > 64 * 1024 * 1024)
      throw new InventoryLimitError(
        "保管記録が一度に確認できる量を超えました。保管先を分ける運用を確認してください。未確認の保存は整理しません。",
      );
  }
  for (const id of await ids(root)) {
    signal?.throwIfAborted();
    try {
      const entry = await inspect(root, id);
      reserve(entry);
      entries.push(entry);
    } catch (error) {
      if (error instanceof InventoryLimitError) throw error;
      blocked++;
    }
  }
  for (const id of await ids(path.join(root, "trash"))) {
    signal?.throwIfAborted();
    try {
      const value = await journal(root, id);
      reserve(value);
      let remainingBytes = 0;
      for (const item of value.items.filter((item) => item.state === "moved"))
        remainingBytes += await remaining(child(path.join(root, "trash"), id), item);
      batches.push({ ...value, remainingBytes, restorable: !value.items.some((item) => item.purging) });
    } catch (error) {
      if (error instanceof InventoryLimitError) throw error;
      blocked++;
    }
  }
  entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id));
  batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  let freeBytes: number | null = null;
  try {
    const disk = await statfs(root);
    freeBytes = disk.bavail * disk.bsize;
  } catch {
    /* Missing storage is shown separately. */
  }
  return {
    entries,
    batches,
    blocked: blocked + entries.filter((entry) => entry.blocked).length,
    freeBytes,
    activeBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    trashBytes: batches.reduce((sum, batch) => sum + batch.remainingBytes, 0),
  };
}
export type StorageData = Awaited<ReturnType<typeof backupStorage>>;
export async function planRetention(root: string, raw: unknown, now = new Date(), signal?: AbortSignal) {
  const policy = retentionPolicy(raw),
    storage = await backupStorage(root, signal);
  const keep = new Set(
    storage.entries
      .filter((entry) => entry.files.some((file) => file.name === "backup.sob"))
      .slice(0, policy.keepCount)
      .map((entry) => entry.id),
  );
  const verified = storage.entries.find((entry) => entry.verified && !entry.blocked);
  if (verified) keep.add(verified.id);
  const eligible = storage.entries.filter(
    (entry) =>
      !entry.pinned &&
      !entry.blocked &&
      !keep.has(entry.id) &&
      (policy.ageDays === 0 || entry.newest < now.getTime() - policy.ageDays * 86400000),
  );
  const candidates: Entry[] = [];
  let journalBytes = 0;
  for (const entry of eligible) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 100;
    if (candidates.length === LIMIT || journalBytes + size > 512 * 1024) break;
    candidates.push(entry);
    journalBytes += size;
  }
  const token = hash({
    policy,
    entries: storage.entries,
    batches: storage.batches.map((batch) => [batch.id, batch.updatedAt, batch.state]),
    candidates: candidates.map((entry) => entry.id),
  });
  return {
    policy,
    token,
    candidates,
    eligible: eligible.length,
    preserved: storage.entries.length - candidates.length,
    bytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0),
    root: path.resolve(root),
    keeper: verified?.id ?? null,
    storage,
  };
}
function same(actual: Entry, expected: Entry) {
  return (
    actual.ino === expected.ino && !actual.blocked && !actual.pinned && hash(actual.files) === hash(expected.files)
  );
}
export async function pinBackup(root: string, id: string, pinned: boolean, authorize?: () => Promise<void>) {
  if (typeof pinned !== "boolean") throw new BackupError("保護指定を確認してください。");
  const directory = child(root, id);
  await assertPlainDirectory(directory);
  const old = await inspect(root, id);
  if (old.blocked) throw new BackupError("この保存データの構成を先に確認してください。");
  await authorize?.();
  await atomicRecord(directory, PIN, { kind: "siteoffer-backup-pin-v1", pinned });
}
export async function moveRetention(
  root: string,
  raw: unknown,
  token: string,
  now = new Date(),
  signal?: AbortSignal,
  authorize?: () => Promise<void>,
) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new BackupError("整理候補を確認し直してください。");
  const id = `backup-${token.slice(0, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}-${token.slice(16, 20)}-${token.slice(20, 32)}`;
  try {
    const old = await journal(root, id);
    if (old.token === token) return old;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const plan = await planRetention(root, raw, now, signal);
  if (plan.token !== token) throw new BackupError("保存データが変わりました。整理候補を確認し直してください。");
  if (!plan.candidates.length) throw new BackupError("この条件の整理候補はありません。");
  await authorize?.();
  signal?.throwIfAborted();
  for (const previous of plan.storage.batches.filter((batch) => batch.needsCommit)) await saveJournal(root, previous);
  await ensurePlainDirectory(path.join(root, "trash"));
  const directory = child(path.join(root, "trash"), id);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertPlainDirectory(directory);
    if ((await readdir(directory)).length !== 0)
      throw new BackupError("退避先が使用中です。保管一覧で操作結果を確認してください。");
  }
  const value: Journal = {
    kind: "siteoffer-retention-v1",
    id,
    token,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    state: "partial",
    items: plan.candidates.map((entry) => ({ entry, state: "pending" })),
  };
  await saveJournal(root, value);
  for (const item of value.items) {
    signal?.throwIfAborted();
    try {
      if (!same(await inspect(root, item.entry.id), item.entry)) throw new BackupError("保存データが変わりました。");
      await assertPlainDirectory(directory);
      const target = child(directory, item.entry.id);
      try {
        await lstat(target);
        throw new BackupError("退避先が使用中です。");
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await authorize?.();
      signal?.throwIfAborted();
      await rename(child(root, item.entry.id), target);
      item.state = "moved";
    } catch {
      item.state = "failed";
    }
    await saveJournal(root, value);
  }
  value.state = stateOf(value.items);
  await saveJournal(root, value);
  return value;
}
export async function restoreRetention(
  root: string,
  id: string,
  signal?: AbortSignal,
  authorize?: () => Promise<void>,
) {
  const value = await journal(root, id),
    directory = child(path.join(root, "trash"), id);
  if (value.state === "purged") throw new BackupError("完全削除した保存データは戻せません。");
  if (value.items.some((item) => item.purging))
    throw new BackupError("完全削除を開始した保存データは戻せません。完全削除を再開してください。");
  for (const item of value.items) {
    signal?.throwIfAborted();
    if (item.state !== "moved") continue;
    const source = child(directory, item.entry.id),
      target = child(root, item.entry.id);
    await assertPlainDirectory(root);
    await assertPlainDirectory(directory);
    if (!same(await inspect(directory, item.entry.id), item.entry))
      throw new BackupError("退避したファイルが変わりました。上書きせず停止しました。");
    try {
      await lstat(target);
      throw new BackupError("同じ名前の保存データがあります。上書きせず停止しました。");
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await authorize?.();
    signal?.throwIfAborted();
    await rename(source, target);
    item.state = "restored";
    await saveJournal(root, value);
  }
  value.state = stateOf(value.items);
  await saveJournal(root, value);
  return value;
}
/** The caller serializes this with backup/verify/move and supplies an actual native restore verification. */
export async function purgeRetention(
  root: string,
  id: string,
  keeper: string,
  password: string,
  verify: (file: string, password: string, signal?: AbortSignal) => Promise<{ archiveSha256: string }>,
  signal?: AbortSignal,
  authorize?: () => Promise<void>,
) {
  const value = await journal(root, id),
    directory = child(path.join(root, "trash"), id);
  if (value.state === "purged") {
    if (value.needsCommit) await saveJournal(root, value);
    return { batch: value, removedBytes: 0, freeBefore: null, freeAfter: null };
  }
  if (!value.items.some((item) => item.state === "moved"))
    throw new BackupError("退避先に完全削除する保存データはありません。");
  const keep = await inspect(root, keeper);
  if (!keep.verified || keep.blocked || !keep.files.some((file) => file.name === "backup.sob"))
    throw new BackupError("残すバックアップを先に復元確認してください。");
  for (const item of value.items.filter((item) => item.state === "moved")) await remaining(directory, item);
  signal?.throwIfAborted();
  const verified = await verify(path.join(child(root, keeper), "backup.sob"), password, signal);
  await authorize?.();
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(verified.archiveSha256))
    throw new BackupError("残すバックアップの復元結果を確認できません。");
  const before = await inspect(root, keeper);
  const archive = keep.files.find((file) => file.name === "backup.sob"),
    current = before.files.find((file) => file.name === "backup.sob");
  if (!before.verified || before.blocked || hash(archive) !== hash(current))
    throw new BackupError("残すバックアップが変わりました。削除せず停止しました。");
  const disk = await statfs(root),
    freeBefore = disk.bavail * disk.bsize;
  let removedBytes = 0;
  for (const item of value.items) {
    signal?.throwIfAborted();
    if (item.state !== "moved") continue;
    await remaining(directory, item);
    const target = child(directory, item.entry.id);
    item.purging = true;
    await saveJournal(root, value);
    for (const file of item.entry.files) {
      signal?.throwIfAborted();
      await authorize?.();
      const filePath = path.join(target, file.name);
      await assertPlainDirectory(target);
      try {
        if (hash(await stamp(filePath)) !== hash(file))
          throw new BackupError("削除対象が変わりました。削除を停止しました。");
      } catch (error) {
        if (missing(error) && item.intents?.includes(file.name)) continue;
        throw error;
      }
      item.intents ??= [];
      if (!item.intents.includes(file.name)) {
        item.intents.push(file.name);
        await saveJournal(root, value);
      }
      signal?.throwIfAborted();
      await unlink(filePath);
      removedBytes += file.bytes;
    }
    await rmdir(target);
    item.state = "purged";
    await saveJournal(root, value);
  }
  value.state = stateOf(value.items);
  await saveJournal(root, value);
  const after = await statfs(root);
  return { batch: value, removedBytes, freeBefore, freeAfter: after.bavail * after.bsize };
}

export { retentionPolicy } from "./retention-request.ts";
