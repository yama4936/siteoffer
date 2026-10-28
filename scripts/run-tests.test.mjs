import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const runnerPath = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const posixOnly = { skip: process.platform === "win32", timeout: 10_000 };

async function waitFor(callback) {
  let lastError;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw lastError;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "siteoffer-test-lock-qa-"));
  const lock = join(directory, "tests.lock");
  const info = join(directory, "child.json");
  const release = join(directory, "release");
  const mock = join(directory, "mock.mjs");
  const processes = [];
  const groups = new Set();
  await writeFile(
    mock,
    `import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const [mode, info, release, ...args] = process.argv.slice(2);
writeFileSync(info, JSON.stringify({ pid: process.pid, ppid: process.ppid, args }));
if (mode === "exit") process.exit(Number(args[0]));
if (mode === "orphan" || mode === "orphan-exit") {
  const child = spawn(process.execPath, [import.meta.filename, "hold", info + ".child", release], { stdio: "ignore" });
  if (mode === "orphan-exit") { child.unref(); process.exit(0); }
}
const timer = setInterval(() => { if (existsSync(release)) clearInterval(timer); }, 10);
`,
  );
  t.after(async () => {
    for (const child of processes) child.kill("SIGKILL");
    for (const pid of groups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await Promise.all(processes.map((child) => child.done));
    await rm(directory, { recursive: true, force: true });
  });
  function launch(mode = "hold", options = {}) {
    const command = options.command ?? process.execPath;
    const args = options.command ? [] : [mock, mode, options.info ?? info, release, ...(options.args ?? [])];
    const settings = options.defaultLock ? {} : { lockDirectory: lock };
    const moduleUrl = pathToFileURL(options.runnerPath ?? runnerPath).href;
    const source = `const { runLockedCommand } = await import(${JSON.stringify(moduleUrl)});
const result = await runLockedCommand(${JSON.stringify(command)}, ${JSON.stringify(args)}, ${JSON.stringify(settings)});
process.exitCode = result.code;`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: directory },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    processes.push(child);
    return child;
  }
  async function owner(directory = lock) {
    const names = await readdir(directory);
    const value = JSON.parse(await readFile(join(directory, names[0]), "utf8"));
    groups.add(value.pid);
    return value;
  }
  async function started(path = info) {
    return waitFor(async () => JSON.parse(await readFile(path, "utf8")));
  }
  async function finishGroup(pid) {
    await writeFile(release, "");
    await waitFor(() => assert.equal(groupExists(pid), false));
  }
  return { directory, lock, info, release, launch, owner, started, finishGroup };
}

test("command arguments and nonzero exit code propagate and release the lock", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const child = f.launch("exit", { args: ["7", "space arg", "日本語"] });
  assert.equal((await child.done).code, 7);
  assert.deepEqual((await f.started()).args, ["7", "space arg", "日本語"]);
  assert.equal(await exists(f.lock), false);
});

test("spawn failure releases the lock", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const child = f.launch("exit", { command: join(f.directory, "missing-command") });
  assert.equal((await child.done).code, 1);
  assert.equal(await exists(f.lock), false);
});

test("a second command is refused while the first command runs", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const first = f.launch();
  await f.started();
  const owner = await f.owner();
  const second = await f.launch("exit", { info: join(f.directory, "second.json"), args: ["0"] }).done;
  assert.equal(second.code, 1);
  assert.match(second.stderr, /別のSiteOfferテスト/);
  assert.equal(await exists(join(f.directory, "second.json")), false);
  await f.finishGroup(owner.pid);
  assert.equal((await first.done).code, 0);
});

test("SIGTERM reaches the command and releases its lock", posixOnly, async (t) => {
  const f = await fixture(t);
  const child = f.launch();
  await f.started();
  await f.owner();
  child.kill("SIGTERM");
  assert.equal((await child.done).code, 143);
  assert.equal(await exists(f.lock), false);
});

test("wrapper SIGKILL keeps the running command locked and recovers after completion", posixOnly, async (t) => {
  const f = await fixture(t);
  const child = f.launch();
  await f.started();
  const owner = await f.owner();
  child.kill("SIGKILL");
  await child.done;
  assert.equal((await f.launch("exit", { args: ["0"] }).done).code, 1);
  await f.finishGroup(owner.pid);
  assert.equal((await f.launch("exit", { args: ["0"] }).done).code, 0);
  assert.equal(await exists(f.lock), false);
});

test("runner SIGKILL keeps surviving command processes locked", posixOnly, async (t) => {
  const f = await fixture(t);
  const child = f.launch();
  await f.started();
  const owner = await f.owner();
  process.kill(owner.pid, "SIGKILL");
  await child.done;
  assert.equal((await f.launch("exit", { args: ["0"] }).done).code, 1);
  await f.finishGroup(owner.pid);
  assert.equal((await f.launch("exit", { args: ["0"] }).done).code, 0);
});

test("command SIGKILL preserves the lock while its descendants run", posixOnly, async (t) => {
  const f = await fixture(t);
  const child = f.launch("orphan");
  const command = await f.started();
  await f.started(`${f.info}.child`);
  const owner = await f.owner();
  process.kill(command.pid, "SIGKILL");
  assert.equal((await child.done).code, 137);
  assert.equal((await f.launch("exit", { args: ["0"] }).done).code, 1);
  await f.finishGroup(owner.pid);
  assert.equal((await f.launch("exit", { args: ["0"] }).done).code, 0);
});

test("normal command exit preserves the lock while descendants remain", posixOnly, async (t) => {
  const f = await fixture(t);
  const child = f.launch("orphan-exit");
  await f.started(`${f.info}.child`);
  const owner = await f.owner();
  assert.equal((await child.done).code, 0);
  assert.equal((await f.launch("exit", { args: ["0"] }).done).code, 1);
  await f.finishGroup(owner.pid);
  assert.equal((await f.launch("exit", { args: ["0"] }).done).code, 0);
});

test("stale owner recovery keeps simultaneous commands exclusive", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(f.lock);
  await writeFile(join(f.lock, "owner-aaaa.json"), JSON.stringify({ pid: 2_147_483_647, processGroup: true }));
  const children = Array.from({ length: 4 }, (_, index) =>
    f.launch("hold", { info: join(f.directory, `${index}.json`) }),
  );
  const owner = await waitFor(async () => {
    const current = await f.owner();
    assert.notEqual(current.pid, 2_147_483_647);
    return current;
  });
  await waitFor(async () => {
    const files = await readdir(f.directory);
    assert.equal(files.filter((name) => /^\d\.json$/.test(name)).length, 1);
  });
  await waitFor(() => assert.equal(children.filter((child) => child.exitCode !== null).length, 3));
  await f.finishGroup(owner.pid);
  const results = await Promise.all(children.map((child) => child.done));
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.equal(results.filter((result) => result.code === 1).length, 3);
});

test("unrecognised lock files are retained and block execution", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(f.lock);
  const unknown = join(f.lock, "unknown.txt");
  await writeFile(unknown, "leave this file alone");
  assert.equal((await f.launch("exit", { args: ["0"] }).done).code, 1);
  assert.equal(await readFile(unknown, "utf8"), "leave this file alone");
});

test("separate project copies use the same default temporary lock", posixOnly, async (t) => {
  const f = await fixture(t);
  const paths = [];
  for (const name of ["copy-one", "copy-two"]) {
    const scripts = join(f.directory, name, "scripts");
    await mkdir(scripts, { recursive: true });
    const path = join(scripts, "run-tests.mjs");
    await copyFile(runnerPath, path);
    paths.push(path);
  }
  const first = f.launch("hold", { runnerPath: paths[0], defaultLock: true });
  await f.started();
  await f.owner(join(f.directory, `siteoffer-tests-${process.getuid()}.lock`));
  const second = await f.launch("exit", { runnerPath: paths[1], defaultLock: true, args: ["0"] }).done;
  assert.equal(second.code, 1);
  assert.match(second.stderr, /別のSiteOfferテスト/);
  await writeFile(f.release, "");
  assert.equal((await first.done).code, 0);
});
