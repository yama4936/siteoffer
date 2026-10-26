import { hostname } from "node:os";
import { runDockerCommand } from "./docker-process.ts";
import { type SandboxStopReference, sandboxStopReferenceSchema } from "./types.ts";

/** Only a completed local client and this execution's exact labels permit automatic cleanup. */
export async function recoverDockerExecution(
  dockerPath: string,
  env: Record<string, string>,
  raw: SandboxStopReference,
) {
  const parsed = sandboxStopReferenceSchema.safeParse(raw);
  if (!parsed.success) return false;
  const ref = parsed.data;
  if (ref.stopped) return true;
  if (ref.host !== hostname()) return false;
  if (!ref.clientClosed) {
    if (ref.clientPid === null) return false;
    try {
      process.kill(ref.clientPid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
  }
  const inspect = () =>
    runDockerCommand(
      dockerPath,
      ["inspect", "--type", "container", "--format", "{{json .Config.Labels}}", ref.containerName],
      env,
      10000,
      undefined,
      undefined,
      true,
    );
  const before = await inspect();
  if (!before.closed) return false;
  if (before.code === 1 && /No such (container|object)/i.test(before.stderr)) return true;
  if (before.code !== 0) return false;
  try {
    const labels = JSON.parse(before.stdout);
    if (
      labels["siteoffer.generation.execution"] !== ref.executionId ||
      labels["siteoffer.generation.job"] !== ref.jobId
    )
      return false;
  } catch {
    return false;
  }
  const removed = await runDockerCommand(dockerPath, ["rm", "--force", ref.containerName], env, 10000);
  if (!removed.closed) return false;
  const after = await inspect();
  return after.closed && after.code === 1 && /No such (container|object)/i.test(after.stderr);
}
