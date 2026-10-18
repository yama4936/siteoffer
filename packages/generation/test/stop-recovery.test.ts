import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));

import { recoverDockerExecution } from "../src/sandbox/stop-recovery.ts";
import type { SandboxStopReference } from "../src/sandbox/types.ts";

let ref: SandboxStopReference, mode: "owned" | "foreign" | "absent" | "daemon" | "remove-failed", removed: boolean;
beforeEach(() => {
  const executionId = randomUUID();
  ref = {
    executionId,
    jobId: randomUUID(),
    containerName: `siteoffer-gen-${executionId}`,
    host: hostname(),
    clientPid: null,
    clientClosed: true,
    stopped: false,
  };
  mode = "owned";
  removed = false;
  fake.spawn.mockReset().mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.emit("spawn");
      if (mode === "daemon") {
        child.stderr.emit("data", Buffer.from("Cannot connect to Docker daemon"));
        child.emit("close", 1);
        return;
      }
      if (args[0] === "rm") {
        removed = mode !== "remove-failed";
        child.emit("close", removed ? 0 : 1);
        return;
      }
      if (mode === "absent" || removed) {
        child.stderr.emit("data", Buffer.from("Error response from daemon: No such container: test"));
        child.emit("close", 1);
        return;
      }
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            "siteoffer.generation.execution": mode === "foreign" ? randomUUID() : ref.executionId,
            "siteoffer.generation.job": ref.jobId,
          }),
        ),
      );
      child.emit("close", 0);
    });
    return child;
  });
});
it("removes only the completed client's matching execution and verifies absence", async () => {
  expect(await recoverDockerExecution("docker", {}, ref)).toBe(true);
  expect(fake.spawn.mock.calls.map((c) => c[1][0])).toEqual(["inspect", "rm", "inspect"]);
  expect(fake.spawn.mock.calls.every((c) => c[1].at(-1) === ref.containerName)).toBe(true);
});
it.each(["foreign", "daemon", "remove-failed"] as const)("keeps the gate on %s", async (value) => {
  mode = value;
  expect(await recoverDockerExecution("docker", {}, ref)).toBe(false);
  if (value === "foreign") expect(fake.spawn).toHaveBeenCalledTimes(1);
});
it("accepts an already absent container only after the client is terminal", async () => {
  mode = "absent";
  expect(await recoverDockerExecution("docker", {}, ref)).toBe(true);
  fake.spawn.mockClear();
  expect(await recoverDockerExecution("docker", {}, { ...ref, clientClosed: false })).toBe(false);
  expect(fake.spawn).not.toHaveBeenCalled();
});
it("never cleans up a live client, a different host, or a forged container name", async () => {
  expect(await recoverDockerExecution("docker", {}, { ...ref, clientClosed: false, clientPid: process.pid })).toBe(
    false,
  );
  expect(await recoverDockerExecution("docker", {}, { ...ref, host: "other-host-test" })).toBe(false);
  expect(await recoverDockerExecution("docker", {}, { ...ref, containerName: "unrelated-container" })).toBe(false);
  expect(fake.spawn).not.toHaveBeenCalled();
});
