import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));

import { runSiteContainer } from "../src/site-docker-process.ts";

let mode: "run" | "remove-fails" | "missing" | "spawn-error" | "never-closes";
const name = "siteoffer-site-11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  mode = "run";
  fake.spawn.mockReset().mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      kill: vi.fn(() => {
        if (args[0] === "run" && mode !== "never-closes") queueMicrotask(() => child.emit("close", null));
        return true;
      }),
    });
    queueMicrotask(() => {
      if (mode === "spawn-error") {
        child.emit("error", new Error("test unavailable"));
        return;
      }
      child.emit("spawn");
      if (args[0] === "rm") {
        if (mode === "remove-fails") child.stderr.emit("data", Buffer.from("Cannot connect to Docker daemon"));
        if (mode === "missing")
          child.stderr.emit("data", Buffer.from("Error response from daemon: No such container: fixture"));
        child.emit("close", mode === "remove-fails" || mode === "missing" ? 1 : 0);
      } else if (mode === "remove-fails" || mode === "missing") child.emit("close", 0);
    });
    return child;
  });
});
it("waits for timeout cleanup and removes only the current random container name", async () => {
  const result = await runSiteContainer("docker", ["run"], name, {}, 10);
  expect(result).toMatchObject({ timedOut: true, aborted: false, stopped: true, closed: true });
  const removals = fake.spawn.mock.calls.filter((c) => c[1][0] === "rm");
  expect(removals).toHaveLength(2);
  expect(removals.map((c) => c[1])).toEqual([
    ["rm", "--force", name],
    ["rm", "--force", name],
  ]);
});
it("cancels a running process and waits for container removal", async () => {
  const controller = new AbortController();
  const pending = runSiteContainer("docker", ["run"], name, {}, 1000, controller.signal);
  await Promise.resolve();
  controller.abort();
  expect(await pending).toMatchObject({ aborted: true, timedOut: false, stopped: true });
});
it("a daemon error is not a successful stop", async () => {
  mode = "remove-fails";
  expect(await runSiteContainer("docker", ["run"], name, {}, 1000)).toMatchObject({ code: 0, stopped: false });
});
it("an already removed container is distinguished from a daemon failure", async () => {
  mode = "missing";
  expect(await runSiteContainer("docker", ["run"], name, {}, 1000)).toMatchObject({ code: 0, stopped: true });
});
it("a failed client spawn never removes another container", async () => {
  mode = "spawn-error";
  expect(await runSiteContainer("docker", ["run"], name, {}, 1000)).toMatchObject({
    code: null,
    started: false,
    stopped: true,
  });
  expect(fake.spawn).toHaveBeenCalledTimes(1);
});
it("retains the unconfirmed state if a killed Docker client never becomes terminal", async () => {
  mode = "never-closes";
  expect(await runSiteContainer("docker", ["run"], name, {}, 10)).toMatchObject({
    timedOut: true,
    closed: false,
    stopped: false,
  });
});
it("bounds a stuck PID registration and confirms container cleanup before returning", async () => {
  vi.useFakeTimers();
  try {
    const pending = runSiteContainer(
      "docker",
      ["run"],
      name,
      {},
      100_000,
      undefined,
      () => new Promise<void>(() => {}),
    );
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toMatchObject({ aborted: true, stopped: true, registrationFailed: true });
  } finally {
    vi.useRealTimers();
  }
});
