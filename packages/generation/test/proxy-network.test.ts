import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ inspect: vi.fn(), spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mock.execFile, spawn: mock.spawn }));
Object.defineProperty(mock.execFile, Symbol.for("nodejs.util.promisify.custom"), { value: mock.inspect });

import { DockerSandboxRunner } from "../src/sandbox/docker.ts";

it.each(["{}", '{"Driver":"bridge","Internal":false}', '{"Driver":"host","Internal":true}'])(
  "refuses to launch a proxy-enabled job on an unverified network: %s",
  async (metadata) => {
    mock.inspect.mockReset().mockResolvedValue({ stdout: metadata, stderr: "" });
    mock.spawn.mockReset();
    const workDir = path.resolve("test-only-proxy-job-must-not-be-created");
    const runner = new DockerSandboxRunner(
      {
        image: "test-only",
        network: "test-proxy-network",
        httpsProxy: "http://proxy:3128",
        codexAuthFile: path.resolve("test-only-auth-not-read.json"),
      },
      { PATH: "/test-bin", DATABASE_URL: "private-test-db", NO_PROXY: "*" },
    );
    const result = await runner.run({ jobId: "test-proxy-job", workDir, timeoutMs: 1000, request: {} as never });
    expect(result).toMatchObject({ ok: false, error: "sandbox_error", stopped: true });
    expect(mock.spawn).not.toHaveBeenCalled();
    expect(existsSync(workDir)).toBe(false);
    expect(mock.inspect).toHaveBeenCalledWith(
      "docker",
      ["network", "inspect", "--format", "{{json .}}", "test-proxy-network"],
      expect.objectContaining({ env: { PATH: "/test-bin" }, timeout: 5000, maxBuffer: 16384, windowsHide: true }),
    );
    expect(JSON.stringify(result)).not.toContain("private-test-db");
  },
);

it("fails closed without leaking Docker inspection errors", async () => {
  mock.inspect.mockReset().mockRejectedValue(new Error("private-test-daemon-error"));
  mock.spawn.mockReset();
  const result = await new DockerSandboxRunner({
    image: "test-only",
    network: "test-network",
    httpsProxy: "http://proxy:3128",
    codexAuthFile: path.resolve("test-only-auth.json"),
  }).run({ jobId: "test-job", workDir: path.resolve("test-only-no-write"), timeoutMs: 1000, request: {} as never });
  expect(result).toMatchObject({ ok: false, stopped: true });
  expect(mock.spawn).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("private-test-daemon-error");
});
