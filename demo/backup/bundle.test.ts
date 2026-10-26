import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  BackupError,
  type BackupManifest,
  type BackupSource,
  fileSource,
  readBundle,
  removeOwnedDirectory,
  validateManifest,
  writeBundle,
} from "./bundle.ts";

const parent = path.resolve(".data/local-run/backup-unit");
let home: string;
const password = "fixture backup password 2026";
beforeEach(async () => {
  await mkdir(parent, { recursive: true });
  home = path.join(parent, `backup-${randomUUID()}`);
  await mkdir(home);
});
afterEach(async () => removeOwnedDirectory(home, parent));
function source(name: string, bytes: Buffer): BackupSource {
  return {
    name,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    read: async function* () {
      yield bytes.subarray(0, 2);
      yield bytes.subarray(2);
    },
  };
}
function manifest(sources: BackupSource[]): BackupManifest {
  return {
    format: 1,
    createdAt: new Date().toISOString(),
    engine: "pglite",
    engineVersion: "0.5.9",
    serverVersion: "18.6",
    records: sources.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    references: [],
  };
}
async function fixture() {
  const bytes = Buffer.from("秘密の本文と写真\n".repeat(3000)),
    sources = [
      source("画像/店内.png", bytes),
      source("empty.txt", Buffer.alloc(0)),
      source("data/test.json", Buffer.from('{"revision":12}')),
    ];
  const file = await writeBundle(home, manifest(sources), sources, password);
  return { file, bytes, sources };
}
it("encrypts all names and bytes and restores Japanese names, empty files and exact binary content", async () => {
  const f = await fixture(),
    encrypted = await readFile(f.file);
  expect(encrypted.includes(Buffer.from("秘密の本文"))).toBe(false);
  expect(encrypted.includes(Buffer.from("店内.png"))).toBe(false);
  const target = path.join(home, "restored"),
    result = await readBundle(f.file, target, password);
  expect(result.records).toHaveLength(3);
  expect(await readFile(path.join(target, "画像/店内.png"))).toEqual(f.bytes);
  expect((await readFile(path.join(target, "empty.txt"))).length).toBe(0);
});
it.each(["password", "changed", "truncated", "trailing"])(
  "rejects %s without replacing any destination",
  async (kind) => {
    const f = await fixture();
    if (kind !== "password") {
      let bytes = await readFile(f.file);
      if (kind === "changed") bytes[Math.floor(bytes.length / 2)]! ^= 1;
      if (kind === "truncated") bytes = bytes.subarray(0, bytes.length - 7);
      if (kind === "trailing") bytes = Buffer.concat([bytes, Buffer.from("extra")]);
      await writeFile(f.file, bytes);
    }
    await expect(
      readBundle(f.file, path.join(home, "failed"), kind === "password" ? "wrong backup password" : password),
    ).rejects.toBeInstanceOf(BackupError);
    const existing = path.join(home, "existing");
    await mkdir(existing);
    await writeFile(path.join(existing, "kept.txt"), "keep");
    await expect(readBundle(f.file, existing, password)).rejects.toBeDefined();
    expect(await readFile(path.join(existing, "kept.txt"), "utf8")).toBe("keep");
  },
);
it.each(["../escape", "/absolute", "C:/file", "a\\b", "a/../b", "a//b", "NUL.txt", "aux/test", "a.", "a ", "a:stream"])(
  "rejects unsafe archive name %s",
  (name) => {
    const s = source(name, Buffer.from("x"));
    expect(() => validateManifest(manifest([s]))).toThrow(BackupError);
  },
);
it("rejects case and directory collisions before touching a file", () => {
  expect(() =>
    validateManifest(manifest([source("A.txt", Buffer.alloc(0)), source("a.txt", Buffer.alloc(0))])),
  ).toThrow(BackupError);
  expect(() => validateManifest(manifest([source("a", Buffer.alloc(0)), source("a/file", Buffer.alloc(0))]))).toThrow(
    BackupError,
  );
});
it("does not complete an archive when a source changes after inventory", async () => {
  const original = path.join(home, "source.txt");
  await writeFile(original, "before");
  const s = await fileSource("source.txt", original);
  await writeFile(original, "changed");
  await expect(writeBundle(home, manifest([s]), [s], password)).rejects.toBeInstanceOf(BackupError);
  expect(await readdir(home)).not.toContain("backup.sob");
});
it("bounds source size and content against the authenticated inventory", async () => {
  const s = source("source.txt", Buffer.from("before"));
  s.read = async function* () {
    yield Buffer.from("after!");
  };
  await expect(writeBundle(home, manifest([s]), [s], password)).rejects.toBeInstanceOf(BackupError);
  expect(await readdir(home)).not.toContain("backup.sob");
});
it("cancels an export without a completed backup and leaves the source intact", async () => {
  const controller = new AbortController(),
    s = source("source.txt", Buffer.from("preserved"));
  controller.abort();
  await expect(writeBundle(home, manifest([s]), [s], password, controller.signal)).rejects.toBeDefined();
  expect(await readdir(home)).not.toContain("backup.sob");
});
it("never overwrites an existing completed archive", async () => {
  await writeFile(path.join(home, "backup.sob"), "kept");
  const s = source("file", Buffer.from("value"));
  await expect(writeBundle(home, manifest([s]), [s], password)).rejects.toBeDefined();
  expect(await readFile(path.join(home, "backup.sob"), "utf8")).toBe("kept");
});
