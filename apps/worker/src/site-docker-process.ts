import { spawn } from "node:child_process";

interface ProcessResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  closed: boolean;
  started: boolean;
}
function command(
  commandPath: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
  onCancel?: () => void,
): Promise<ProcessResult> {
  if (signal?.aborted)
    return Promise.resolve({ code: null, stderr: "", timedOut: false, aborted: true, closed: true, started: false });
  return new Promise((resolve) => {
    const child = spawn(commandPath, args, { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let settled = false,
      stderr = "",
      timedOut = false,
      aborted = false,
      started = false,
      stopping = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      resolve({ code, stderr, timedOut, aborted, closed, started });
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      onCancel?.();
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null, false);
      }, 2000);
    };
    const abort = () => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => {
      started = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(0, 4096);
    });
    child.once("error", () => {
      if (!started) finish(null, true);
    });
    child.once("close", (code) => finish(code, true));
    if (signal?.aborted) abort();
  });
}
/** Only this execution's random name is removed. A daemon failure is not proof that it stopped. */
async function removeOwnedContainer(dockerPath: string, name: string, env: Record<string, string>) {
  const result = await command(dockerPath, ["rm", "--force", name], env, 10_000);
  return (
    result.closed && (result.code === 0 || (result.code === 1 && /No such (container|object)/i.test(result.stderr)))
  );
}
export async function runSiteContainer(
  dockerPath: string,
  args: string[],
  name: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  let cancellation: Promise<boolean> | undefined;
  const result = await command(dockerPath, args, env, timeoutMs, signal, () => {
    cancellation ??= removeOwnedContainer(dockerPath, name, env);
  });
  if (cancellation) await cancellation;
  // Repeat after the Docker client is terminal, covering cancellation while a container was starting.
  const removed = !result.started || (await removeOwnedContainer(dockerPath, name, env));
  return { ...result, stopped: result.closed && removed };
}
