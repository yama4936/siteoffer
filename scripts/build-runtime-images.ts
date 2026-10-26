import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeRepoRoot, runtimeSourceFingerprint } from "./runtime-fingerprint.ts";

export function runtimeBuildOptions(args: string[]) {
  const values: Record<string, string> = {
    "--kind": "all",
    "--codex-tag": "siteoffer-codex:local",
    "--site-tag": "siteoffer-site:local",
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!Object.hasOwn(values, key) || seen.has(key) || !value || value.startsWith("--"))
      throw new Error("Use --kind all|codex|site and optional --codex-tag / --site-tag.");
    seen.add(key);
    values[key] = value;
  }
  if (!["all", "codex", "site"].includes(values["--kind"]!)) throw new Error("Invalid runtime kind");
  for (const key of ["--codex-tag", "--site-tag"])
    if (!/^[a-z0-9][a-z0-9./_:-]{0,254}$/i.test(values[key]!)) throw new Error("Invalid runtime image tag");
  return { kind: values["--kind"]!, codexTag: values["--codex-tag"]!, siteTag: values["--site-tag"]! };
}

export async function runtimeBuildPlans(options: ReturnType<typeof runtimeBuildOptions>, root = runtimeRepoRoot) {
  const kinds = options.kind === "all" ? (["codex", "site"] as const) : [options.kind as "codex" | "site"];
  const plans = [];
  for (const kind of kinds) {
    const fingerprint = await runtimeSourceFingerprint(kind, root);
    const tag = kind === "codex" ? options.codexTag : options.siteTag;
    plans.push({
      kind,
      tag,
      fingerprint,
      args: [
        "build",
        "--pull=false",
        "--build-arg",
        `SITEOFFER_SOURCE_SHA256=${fingerprint}`,
        "-f",
        `Dockerfile.${kind}`,
        "-t",
        tag,
        ".",
      ],
    });
  }
  return plans;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plans = await runtimeBuildPlans(runtimeBuildOptions(process.argv.slice(2)));
  for (const plan of plans) {
    console.log(`${plan.kind}: building ${plan.tag} from source ${plan.fingerprint.slice(0, 12)}`);
    const result = spawnSync("docker", plan.args, {
      cwd: runtimeRepoRoot,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    if (result.error || result.status !== 0) {
      process.exitCode = 1;
      break;
    }
  }
}
