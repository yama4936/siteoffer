import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { constants, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const ownerNamePattern = /^owner-[a-f0-9-]+\.json$/;
const userId = process.getuid?.() ?? Buffer.from(userInfo().username).toString("hex");
const defaultLockDirectory = join(tmpdir(), `siteoffer-tests-${userId}.lock`);
const supportsProcessGroups = process.platform !== "win32";

function isRunning(owner) {
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.processGroup !== "boolean") {
    throw new Error("テストのロック情報を確認できません。ロックを自動削除せず停止します。");
  }
  try {
    // 実行役だけが強制終了されても、残ったVitestワーカーが同じグループにいれば保持する。
    process.kill(owner.processGroup && supportsProcessGroups ? -owner.pid : owner.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function removeOwner(directory, ownerName) {
  try {
    await unlink(join(directory, ownerName));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    // 再取得されたロックのマーカーを消さないよう、空のディレクトリだけを除去する。
    await rmdir(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

async function recoverStaleLock(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const name of entries) {
    if (!ownerNamePattern.test(name)) {
      throw new Error("テストのロックに不明なファイルがあります。自動削除せず停止します。");
    }
    let owner;
    try {
      owner = JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error("テストのロック情報が読めません。自動削除せず停止します。", { cause: error });
    }
    if (isRunning(owner)) {
      throw new Error(
        "別のSiteOfferテストが実行中です。終了後にもう一度実行してください（同じユーザーのworktree間でも共通）。",
      );
    }
  }
  for (const name of entries) await removeOwner(directory, name);
  if (entries.length === 0) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    }
  }
}

async function acquireLock(directory, ownerName) {
  const candidate = `${directory}.${process.pid}.${randomUUID()}`;
  await mkdir(candidate, { mode: 0o700 });
  try {
    await writeFile(
      join(candidate, ownerName),
      JSON.stringify({ pid: process.pid, processGroup: supportsProcessGroups }),
      { flag: "wx", mode: 0o600 },
    );
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // 所有情報を先に書いてから公開するので、空の新規ロックをstaleと誤認しない。
        await rename(candidate, directory);
        return;
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
        await recoverStaleLock(directory);
      }
    }
    throw new Error("テストのロックが競合しました。少し待ってから再実行してください。");
  } finally {
    await removeOwner(candidate, ownerName);
  }
}

function waitForChild(child, signalGroup) {
  return new Promise((resolve) => {
    const handlers = new Map();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => {
        try {
          if (signalGroup && supportsProcessGroups) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const finish = (result) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(result);
    };
    child.once("error", (error) => finish({ error, code: 1 }));
    child.once("close", (code, signal) => finish({ code: code ?? 128 + (constants.signals[signal] ?? 0), signal }));
  });
}

// 軽量な検証でも同じ排他・シグナル処理を使える。CLIは必ずVitestをこの経路で起動する。
export async function runLockedCommand(command, args, { lockDirectory = defaultLockDirectory } = {}) {
  const ownerName = `owner-${randomUUID()}.json`;
  const runner = spawn(process.execPath, [scriptPath, "--locked-run", lockDirectory, ownerName, command, ...args], {
    cwd: projectRoot,
    stdio: "inherit",
    detached: supportsProcessGroups,
  });
  const result = await waitForChild(runner, true);
  // 実行役が終了してもワーカーが残っていればロックを保持し、後続のstale確認に任せる。
  if (runner.pid && !isRunning({ pid: runner.pid, processGroup: supportsProcessGroups })) {
    await removeOwner(lockDirectory, ownerName);
  }
  return result;
}

async function main() {
  if (process.argv[2] === "--locked-run") {
    const [, , , directory, ownerName, command, ...args] = process.argv;
    if (!ownerNamePattern.test(ownerName)) throw new Error("テストのロック名が不正です。");
    await acquireLock(directory, ownerName);
    const result = await waitForChild(spawn(command, args, { cwd: projectRoot, stdio: "inherit" }), false);
    if (result.error) throw result.error;
    return result.code;
  }
  const vitestPath = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
  const result = await runLockedCommand(process.execPath, [vitestPath, ...process.argv.slice(2)]);
  if (result.error) throw result.error;
  return result.code;
}

if (process.argv[1] === scriptPath) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
