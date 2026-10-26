import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const MAGIC = Buffer.from("SiteOffer encrypted backup v1\n");
const HEADER_SIZE = MAGIC.length + 16 + 12;
const MAX_MANIFEST = 8 * 1024 * 1024;
const MAX_BYTES = 128 * 1024 ** 3;
export class BackupError extends Error {}
export type BackupRecord = { name: string; size: number; sha256: string };
export type BackupManifest = {
  format: 1;
  createdAt: string;
  engine: "pglite";
  engineVersion: string;
  serverVersion: string;
  records: BackupRecord[];
  tables?: { schema: string; name: string; rows: number }[];
  references: {
    table: "proposal_versions" | "delivery_versions" | "site_audits";
    id: string;
    original: string;
    directory: string;
  }[];
};
export type BackupSource = { name: string; size: number; sha256: string; read: () => AsyncIterable<Uint8Array> };

async function key(password: string, salt: Buffer) {
  if (password.length < 12 || password.length > 1024)
    throw new BackupError("保存用パスフレーズは12〜1024文字で指定してください。");
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (error, derived) =>
      error ? reject(error) : resolve(derived),
    ),
  );
}
function validNames(records: BackupRecord[]) {
  if (!Array.isArray(records) || records.length > 100000) throw new BackupError("バックアップの目録を確認できません。");
  const names = new Set<string>();
  let total = 0;
  for (const r of records) {
    if (
      !r ||
      typeof r.name !== "string" ||
      /[\\:<>"|?*]/.test(r.name) ||
      r.name.length > 1024 ||
      Array.from(r.name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      r.name
        .split("/")
        .some(
          (s) =>
            !s || s === "." || s === ".." || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s),
        ) ||
      !Number.isSafeInteger(r.size) ||
      r.size < 0 ||
      !/^[a-f0-9]{64}$/.test(r.sha256)
    )
      throw new BackupError("バックアップに利用できないファイル指定があります。");
    const normalized = r.name.normalize("NFC").toUpperCase();
    if (names.has(normalized)) throw new BackupError("バックアップに重複したファイルがあります。");
    names.add(normalized);
    total += r.size;
    if (!Number.isSafeInteger(total) || total > MAX_BYTES)
      throw new BackupError("バックアップの容量が上限を超えています。");
  }
  for (const name of names) {
    const parts = name.split("/");
    parts.pop();
    while (parts.length) {
      if (names.has(parts.join("/"))) throw new BackupError("ファイルとフォルダーの指定が重なっています。");
      parts.pop();
    }
  }
}
export function validateManifest(value: unknown): BackupManifest {
  const m = value as BackupManifest;
  if (
    m?.format !== 1 ||
    m.engine !== "pglite" ||
    typeof m.engineVersion !== "string" ||
    typeof m.serverVersion !== "string" ||
    typeof m.createdAt !== "string" ||
    !Number.isFinite(Date.parse(m.createdAt)) ||
    new Date(m.createdAt).toISOString() !== m.createdAt ||
    !Array.isArray(m.references)
  )
    throw new BackupError("対応するバックアップではありません。");
  validNames(m.records);
  if (
    m.tables !== undefined &&
    (!Array.isArray(m.tables) ||
      m.tables.length > 10000 ||
      m.tables.some(
        (t) =>
          !t ||
          typeof t.schema !== "string" ||
          typeof t.name !== "string" ||
          !t.schema ||
          !t.name ||
          t.schema.length > 128 ||
          t.name.length > 128 ||
          t.schema.includes("\0") ||
          t.name.includes("\0") ||
          !Number.isSafeInteger(t.rows) ||
          t.rows < 0,
      ))
  )
    throw new BackupError("DBの照合目録を確認できません。");
  if (
    m.references.length > 100000 ||
    m.references.some(
      (r) =>
        !r ||
        !["proposal_versions", "delivery_versions", "site_audits"].includes(r.table) ||
        !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(r.id) ||
        typeof r.original !== "string" ||
        !/^artifacts\/[a-f0-9-]{36}$/.test(r.directory),
    )
  )
    throw new BackupError("成果物の参照を確認できません。");
  return m;
}
export async function assertPlainDirectory(directory: string) {
  const absolute = path.resolve(directory),
    parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new BackupError("リンクを含まない保存先を指定してください。");
  }
  if (path.resolve(await realpath(absolute)).toLowerCase() !== absolute.toLowerCase())
    throw new BackupError("保存先を確認できません。");
}
export async function ensurePlainDirectory(directory: string) {
  const absolute = path.resolve(directory),
    parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new BackupError("リンクを含まない保存先を指定してください。");
  }
  await assertPlainDirectory(absolute);
  return absolute;
}
export async function fileSource(name: string, file: string): Promise<BackupSource> {
  await assertPlainDirectory(path.dirname(file));
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new BackupError("通常のファイルだけを保存できます。");
  const sha = createHash("sha256");
  for await (const chunk of createReadStream(file)) sha.update(chunk);
  const hash = sha.digest("hex");
  return {
    name,
    size: before.size,
    sha256: hash,
    read: async function* () {
      const current = await lstat(file);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs ||
        current.ino !== before.ino
      )
        throw new BackupError("保存中にファイルが変わりました。もう一度実行してください。");
      yield* createReadStream(file);
    },
  };
}
/** Write only to a new, caller-owned directory; the completion name appears after authentication data is flushed. */
export async function writeBundle(
  directory: string,
  manifest: BackupManifest,
  sources: BackupSource[],
  password: string,
  signal?: AbortSignal,
) {
  validateManifest(manifest);
  await assertPlainDirectory(directory);
  if (
    sources.length !== manifest.records.length ||
    sources.some(
      (s, i) =>
        s.name !== manifest.records[i]?.name ||
        s.size !== manifest.records[i]?.size ||
        s.sha256 !== manifest.records[i]?.sha256,
    )
  )
    throw new BackupError("目録と保存対象が一致しません。");
  const encoded = Buffer.from(JSON.stringify(manifest));
  if (encoded.length > MAX_MANIFEST) throw new BackupError("バックアップの目録が大きすぎます。");
  const salt = randomBytes(16),
    iv = randomBytes(12),
    header = Buffer.concat([MAGIC, salt, iv]),
    secret = await key(password, salt);
  const temporary = path.join(directory, "backup.partial"),
    target = path.join(directory, "backup.sob");
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(header);
    await handle.close();
    const cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(header);
    const frames = async function* () {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(encoded.length);
      yield length;
      yield encoded;
      for (const source of sources) {
        signal?.throwIfAborted();
        let size = 0;
        const hash = createHash("sha256");
        for await (const chunk of source.read()) {
          signal?.throwIfAborted();
          size += chunk.length;
          if (size > source.size) throw new BackupError("保存対象の容量が変わりました。");
          hash.update(chunk);
          yield chunk;
        }
        if (size !== source.size || hash.digest("hex") !== source.sha256)
          throw new BackupError("保存中にファイルが変わりました。もう一度実行してください。");
      }
    };
    await pipeline(
      Readable.from(frames()),
      createGzip(),
      cipher,
      createWriteStream(temporary, { flags: "a", mode: 0o600 }),
      { signal },
    );
    const end = await open(temporary, "a");
    try {
      await end.writeFile(cipher.getAuthTag());
      await end.sync();
    } finally {
      await end.close();
    }
    signal?.throwIfAborted();
    try {
      await lstat(target);
      throw new BackupError("同じ保存先には上書きできません。");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await rename(temporary, target);
    return target;
  } finally {
    secret.fill(0);
    await handle.close().catch(() => {});
  }
}
/** Extract into a new isolated directory. Callers must not load the database before this authenticates successfully. */
export async function readBundle(
  file: string,
  directory: string,
  password: string,
  signal?: AbortSignal,
  created?: () => void,
  verified?: (sha256: string, bytes: number, mtimeMs: number) => void,
): Promise<BackupManifest> {
  await assertPlainDirectory(path.dirname(file));
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < HEADER_SIZE + 16 || stat.size > MAX_BYTES)
    throw new BackupError("バックアップファイルを確認してください。");
  await mkdir(directory, { recursive: false, mode: 0o700 });
  created?.();
  await assertPlainDirectory(directory);
  const header = Buffer.alloc(HEADER_SIZE),
    tag = Buffer.alloc(16),
    handle = await open(file, "r");
  try {
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, 16, stat.size - 16);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError("対応するバックアップではありません。");
  const secret = await key(password, header.subarray(MAGIC.length, MAGIC.length + 16)),
    decipher = createDecipheriv("aes-256-gcm", secret, header.subarray(MAGIC.length + 16));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const input = createReadStream(file, { start: HEADER_SIZE, end: stat.size - 17 });
  const archiveHash = createHash("sha256").update(header),
    counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        archiveHash.update(chunk);
        callback(null, chunk);
      },
    });
  let manifest: BackupManifest | undefined,
    buffer = Buffer.alloc(0),
    length: number | undefined,
    index = 0,
    remaining = 0,
    hash = createHash("sha256"),
    output: Awaited<ReturnType<typeof open>> | undefined;
  // pipeline owns error propagation across all stages, including a late GCM authentication failure.
  try {
    await pipeline(
      input,
      counted,
      decipher,
      createGunzip(),
      async (stream: AsyncIterable<Uint8Array>) => {
        for await (const raw of stream) {
          signal?.throwIfAborted();
          let chunk = Buffer.from(raw);
          if (!manifest) {
            buffer = Buffer.concat([buffer, chunk]);
            chunk = Buffer.alloc(0);
            if (length === undefined && buffer.length >= 4) {
              length = buffer.readUInt32BE();
              buffer = buffer.subarray(4);
              if (length > MAX_MANIFEST) throw new BackupError("バックアップの目録が大きすぎます。");
            }
            if (length === undefined || buffer.length < length) continue;
            manifest = validateManifest(JSON.parse(buffer.subarray(0, length).toString("utf8")));
            chunk = buffer.subarray(length);
            buffer = Buffer.alloc(0);
          }
          while (chunk.length || (manifest && index < manifest.records.length && manifest.records[index]!.size === 0)) {
            if (!output) {
              const record = manifest!.records[index];
              if (!record) throw new BackupError("バックアップの末尾に不正なデータがあります。");
              const target = path.join(directory, ...record.name.split("/"));
              await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
              await assertPlainDirectory(path.dirname(target));
              output = await open(target, "wx", 0o600);
              remaining = record.size;
              hash = createHash("sha256");
            }
            const used = Math.min(remaining, chunk.length),
              part = chunk.subarray(0, used);
            await output.writeFile(part);
            hash.update(part);
            remaining -= used;
            chunk = chunk.subarray(used);
            if (!remaining) {
              await output.close();
              output = undefined;
              if (hash.digest("hex") !== manifest!.records[index]!.sha256)
                throw new BackupError("バックアップのファイル照合に失敗しました。");
              index++;
            } else break;
          }
        }
      },
      { signal },
    );
    if (!manifest || output || index !== manifest.records.length)
      throw new BackupError("バックアップが途中で切れています。");
    verified?.(archiveHash.update(tag).digest("hex"), stat.size, stat.mtimeMs);
    return manifest;
  } catch (e) {
    input.destroy();
    decipher.destroy();
    if (e instanceof BackupError) throw e;
    throw new BackupError("パスフレーズが異なるか、バックアップが破損しています。");
  } finally {
    await output?.close().catch(() => {});
    secret.fill(0);
  }
}
export async function removeOwnedDirectory(directory: string, parent: string) {
  const resolved = path.resolve(directory),
    root = path.resolve(parent);
  if (path.dirname(resolved) !== root || !/^backup-[a-f0-9-]{36}$/.test(path.basename(resolved)))
    throw new BackupError("後始末の対象を確認できません。");
  await assertPlainDirectory(resolved);
  await rm(resolved, { recursive: true, force: false });
}
