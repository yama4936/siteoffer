import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { demoShareKey } from "../demo/share-key.ts";

it("デモ鍵は同時初期化・再起動で保持し、破損しても交換しない", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "siteoffer-share-key-"));
  const file = path.join(directory, "share-token-key");
  try {
    const values = await Promise.all(Array.from({ length: 5 }, () => demoShareKey(directory)));
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await demoShareKey(directory)).toBe(values[0]);
    expect(await readdir(directory)).toEqual(["share-token-key"]);
    await writeFile(file, "broken");
    await expect(demoShareKey(directory)).rejects.toThrow("既存の鍵は変更していません");
    expect(await readFile(file, "utf8")).toBe("broken");
  } finally {
    await unlink(file);
    await rmdir(directory);
  }
});

it("通常開発の初期化は空欄の鍵だけを埋め、再実行時に他の値と鍵を保持する", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "siteoffer-share-setup-"));
  const scripts = path.join(directory, "scripts"),
    env = path.join(directory, ".env"),
    script = path.join(scripts, "setup-local.mjs");
  await mkdir(scripts);
  await writeFile(script, await readFile(new URL("../scripts/setup-local.mjs", import.meta.url), "utf8"));
  try {
    for (const initial of [
      "EXISTING_VALUE=keep\n",
      "EXISTING_VALUE=keep\nSITEOFFER_SHARE_TOKEN_KEY=\n",
      'EXISTING_VALUE=keep\nSITEOFFER_SHARE_TOKEN_KEY="" # blank\n',
    ]) {
      await writeFile(env, `${initial}# keep this comment\nAFTER_VALUE=also-keep\n`);
      const output = execFileSync(process.execPath, [script], { encoding: "utf8", windowsHide: true });
      const first = await readFile(env, "utf8"),
        key = first.match(/^SITEOFFER_SHARE_TOKEN_KEY=(.*)$/m)?.[1];
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first).toContain("EXISTING_VALUE=keep");
      expect(first).toContain("# keep this comment\nAFTER_VALUE=also-keep");
      expect(output).not.toContain(key!);
      execFileSync(process.execPath, [script], { stdio: "ignore", windowsHide: true });
      expect(await readFile(env, "utf8")).toBe(first);
    }
  } finally {
    await unlink(env);
    await unlink(script);
    for (const d of [scripts, path.join(directory, ".data"), path.join(directory, "reports")]) await rmdir(d);
    await rmdir(directory);
  }
});
