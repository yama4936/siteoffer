import { open } from "node:fs/promises";
import path from "node:path";
import type { WorkerCapabilities } from "@siteoffer/db";
import type { WorkerDeps } from "./deps.ts";

type Preparation = NonNullable<WorkerCapabilities["preparation"]>;

/** Report configuration only. The evaluator remains responsible for each actual decision. */
export function decisionPreparation(raw: unknown, demo: boolean): Preparation["decision"] {
  const invalid = { status: "invalid", threshold: null, criticalFlagsTrigger: null, demo } as const;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid;
  const proposal = (raw as Record<string, unknown>).proposal;
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return invalid;
  const p = proposal as Record<string, unknown>;
  const threshold = p.threshold ?? null;
  const criticalFlagsTrigger = p.critical_flags_trigger ?? null;
  if (
    (threshold !== null &&
      (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 100)) ||
    (criticalFlagsTrigger !== null && typeof criticalFlagsTrigger !== "boolean") ||
    (p.min_coverage !== undefined &&
      (typeof p.min_coverage !== "number" ||
        !Number.isFinite(p.min_coverage) ||
        p.min_coverage < 0 ||
        p.min_coverage > 1))
  )
    return invalid;
  return {
    status: threshold === null || criticalFlagsTrigger === null ? "pending" : "configured",
    threshold,
    criticalFlagsTrigger,
    demo,
  };
}

/** Bounded local read at heartbeat time. No model, external requests or configuration changes. */
export async function readWorkerPreparation(deps: WorkerDeps): Promise<Preparation> {
  const { configPath, repoRoot } = deps.audit.options.paths;
  const demo = path.resolve(configPath) === path.resolve(repoRoot, "config/site-evaluation.demo.json");
  let decision = decisionPreparation(null, demo);
  try {
    const file = await open(configPath, "r");
    try {
      const info = await file.stat();
      if (info.isFile() && info.size > 0 && info.size <= 65_536) {
        // A bounded read also handles a file growing after stat().
        const bytes = Buffer.alloc(65_537);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead <= 65_536)
          decision = decisionPreparation(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), demo);
      }
    } finally {
      await file.close();
    }
  } catch {
    /* The public result must never contain a path or parser error. */
  }
  return {
    auditCollector: deps.preparation?.auditCollector ?? "unknown",
    generationInput: deps.preparation?.generationInput ?? "unknown",
    decision,
  };
}
