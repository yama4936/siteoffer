import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { pnpmCommand } from "./pnpm-command.ts";

const run = promisify(execFile);

describe("demo pnpm child command", () => {
  it.each(["pnpm.js", "pnpm.cjs", "pnpm.mjs", "PNPM.CJS"])("runs %s with Node", (name) => {
    const cli = `C:\\Program Files\\日本語\\${name}`;
    expect(pnpmCommand(["--filter", "@siteoffer/web", "exec", "next"], cli, "node.exe")).toEqual({
      command: "node.exe",
      args: [cli, "--filter", "@siteoffer/web", "exec", "next"],
    });
  });

  it.each(["C:\\Program Files\\日本語\\pnpm.exe", "C:\\tools\\PNPM.EXE", "/opt/pnpm/pnpm"])(
    "runs the native executable directly: %s",
    (cli) => {
      expect(pnpmCommand(["--filter", "@siteoffer/worker", "start"], cli, "node.exe")).toEqual({
        command: cli,
        args: ["--filter", "@siteoffer/worker", "start"],
      });
    },
  );

  it("keeps the PATH lookup when no package-manager entry point was supplied", () => {
    expect(pnpmCommand(["--version"], "", "node.exe")).toEqual({ command: "pnpm", args: ["--version"] });
  });

  it("actually executes a native process without passing its executable to Node as source", async () => {
    const invocation = pnpmCommand(
      [
        "--input-type=module",
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        "--",
        "日本語 & $(literal)",
      ],
      process.execPath,
    );
    const result = await run(invocation.command, invocation.args, { windowsHide: true, timeout: 10_000 });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(["日本語 & $(literal)"]);
  });

  it("actually executes a JavaScript CLI in a path with spaces and preserves arguments", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "siteoffer pnpm 日本語 "));
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("siteoffer pnpm 日本語 "))
      throw new Error("Refusing to use an unexpected test directory");
    try {
      const cli = path.join(dir, "pnpm.mjs");
      await writeFile(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n", "utf8");
      const values = ["--filter", "@siteoffer/web", "literal & $(value)", "space and 日本語"];
      const invocation = pnpmCommand(values, cli);
      const result = await run(invocation.command, invocation.args, { windowsHide: true, timeout: 10_000 });
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(values);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
