import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));

import { DockerSandboxRunner } from "../src/sandbox/docker.ts";
import type { SandboxResult } from "../src/sandbox/types.ts";

let dir: string, mode: "ok" | "stale" | "nonzero" | "spawn-error";
const result: SandboxResult = {
  ok: true,
  threadId: "test-thread",
  finalResponse: "test-output",
  usage: null,
  responseModel: null,
  sdkVersion: "test",
  cliVersion: null,
  error: null,
};
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "siteoffer-receipt-"));
  mode = "ok";
  await mkdir(path.join(dir, "out"));
  await writeFile(
    path.join(dir, "out/result.json"),
    JSON.stringify({ ...result, executionId: "11111111-1111-4111-8111-111111111111" }),
  );
  mock.spawn.mockReset().mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { pid: 414141, stderr: new EventEmitter(), kill: vi.fn() });
    queueMicrotask(async () => {
      if (mode === "spawn-error") {
        child.emit("error", new Error("test-only unavailable process"));
        return;
      }
      child.emit("spawn");
      if (args[0] === "rm") {
        child.emit("close", 0);
        return;
      }
      const input = JSON.parse(await readFile(path.join(dir, "request.json"), "utf8"));
      if (mode !== "stale")
        await writeFile(
          path.join(dir, "out/result.json"),
          JSON.stringify({ ...result, executionId: input.executionId }),
        );
      child.emit("close", mode === "nonzero" ? 42 : 0);
    });
    return child;
  });
});
afterEach(async () => {
  const resolved = path.resolve(dir);
  if (
    !resolved.startsWith(path.resolve(tmpdir()) + path.sep) ||
    !path.basename(resolved).startsWith("siteoffer-receipt-")
  )
    throw Error("Unexpected test directory");
  await rm(resolved, { recursive: true, force: true });
});
async function run(saveStopReference?: import("../src/sandbox/types.ts").SandboxRunSpec["saveStopReference"]) {
  return new DockerSandboxRunner({
    image: "test-only",
    network: "none",
    codexAuthFile: path.join(dir, "dummy-auth.json"),
  }).run({
    jobId: "test-job",
    workDir: dir,
    timeoutMs: 1000,
    ...(saveStopReference ? { saveStopReference } : {}),
    request: {
      prompt: "test",
      outputSchema: null,
      model: null,
      images: [],
      thread: {
        sandboxMode: "read-only",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        approvalPolicy: "never",
        modelReasoningEffort: null,
      },
    },
  });
}
it("a fresh receipt succeeds and another run in the same directory has a different identity", async () => {
  const first = await run(),
    second = await run();
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(first.result?.executionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(second.result?.executionId).not.toBe(first.result?.executionId);
  const names = mock.spawn.mock.calls.filter((c) => c[1][0] === "run").map((c) => c[1][c[1].indexOf("--name") + 1]);
  expect(new Set(names).size).toBe(2);
  expect(names).toEqual([first.stopReference?.containerName, second.stopReference?.containerName]);
});
it("a zero exit without a new receipt cannot reuse a previous successful result", async () => {
  mode = "stale";
  expect(await run()).toMatchObject({ ok: false, error: "sandbox_error", result: null });
});
it("a matching successful receipt cannot override a failing container exit", async () => {
  mode = "nonzero";
  expect(await run()).toMatchObject({ ok: false, error: "sandbox_error", message: expect.stringContaining("42") });
});
it("a failed process launch cannot reuse a previous successful result", async () => {
  mode = "spawn-error";
  expect(await run()).toMatchObject({ ok: false, error: "sandbox_error", result: null });
});
it("the isolated runtime pins the same SDK and schema library as the host", async () => {
  const runtime = JSON.parse(await readFile(new URL("../src/sandbox/runtime/package.json", import.meta.url), "utf8")),
    host = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(runtime.dependencies["@openai/codex-sdk"]).toBe(host.dependencies["@openai/codex-sdk"]);
  expect(runtime.dependencies.zod).toBe(host.dependencies.zod);
});
it("does not launch before reference persistence, then records PID and terminal evidence", async () => {
  const references: import("../src/sandbox/types.ts").SandboxStopReference[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = run(async (ref) => {
    references.push({ ...ref });
    if (references.length === 1) await gate;
  });
  await expect.poll(() => references.length).toBe(1);
  expect(mock.spawn).not.toHaveBeenCalled();
  expect(references[0]).toMatchObject({ clientPid: null, clientClosed: false, stopped: false });
  release();
  expect((await pending).ok).toBe(true);
  expect(references[1]).toMatchObject({ clientPid: 414141, clientClosed: false, stopped: false });
  expect(references.at(-1)).toMatchObject({ clientPid: 414141, clientClosed: true, stopped: true });
  expect(new Set(references.map((r) => r.executionId)).size).toBe(1);
});
it("a rejected initial registration never launches Docker", async () => {
  expect(
    await run(async () => {
      throw Error("test-only persistence failure");
    }),
  ).toMatchObject({ ok: false, stopped: true });
  expect(mock.spawn).not.toHaveBeenCalled();
});
it("a rejected PID registration discards the successful receipt and confirms cleanup", async () => {
  let calls = 0;
  expect(
    await run(async () => {
      if (++calls === 2) throw Error("test-only lease loss");
    }),
  ).toMatchObject({ ok: false, error: "aborted", stopped: true, result: null });
  expect(mock.spawn.mock.calls.some((c) => c[1][0] === "rm")).toBe(true);
});
