import type { IntakeLane, IntakePhase, workerRuntimes } from "@siteoffer/db";

export const WORKER_FRESH_MS = 45_000;
export const INTAKE_LANE_LABELS: Record<IntakeLane, string> = {
  dispatch: "収集・制作依頼の受付",
  images: "画像生成",
  deliveries: "納品サイト制作",
};
export const INTAKE_PHASE_LABELS: Record<IntakePhase, string> = {
  starting: "受付を起動中",
  designs: "サイト制作の依頼を受付中",
  images: "画像生成を処理中",
  discovery: "収集の依頼を受付中",
  deliveries: "納品サイトを制作中",
  idle: "次の受付を待機中",
  error: "受付処理でエラー",
};
const lanePhases: Record<IntakeLane, IntakePhase[]> = {
  dispatch: ["starting", "designs", "discovery", "idle", "error"],
  images: ["starting", "images", "idle", "error"],
  deliveries: ["starting", "deliveries", "idle", "error"],
};
function date(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** Assess intake independently of the heartbeat timer and of other long-running tasks. */
export function assessWorkerIntake(
  row: Pick<typeof workerRuntimes.$inferSelect, "heartbeatAt" | "capabilities" | "progress">,
  now: Date,
) {
  const age = now.getTime() - row.heartbeatAt.getTime();
  const live = age >= -5000 && age <= WORKER_FRESH_MS;
  const c = row.capabilities;
  const known =
    c?.version === 1 &&
    typeof c.discoveryOnly === "boolean" &&
    typeof c.imageConfigured === "boolean" &&
    Number.isFinite(c.intakeIntervalMs) &&
    c.intakeIntervalMs > 0;
  const p = row.progress;
  const phase = p && Object.hasOwn(INTAKE_PHASE_LABELS, p.phase) ? p.phase : null;
  const since = date(p?.since);
  const overdue = (phase: IntakePhase | null, since: string | null) =>
    live &&
    !!known &&
    (phase === "idle" || phase === "starting") &&
    !!since &&
    now.getTime() - Date.parse(since) > Math.max(60_000, c!.intakeIntervalMs * 3);
  const names: IntakeLane[] = c?.discoveryOnly ? ["dispatch"] : ["dispatch", "images", "deliveries"];
  const lanes =
    p && Object.hasOwn(p, "lanes")
      ? names.map((key) => {
          const state = p.lanes?.[key];
          const phase = state && lanePhases[key].includes(state.phase) ? state.phase : null;
          const since = date(state?.since);
          const intakeOverdue = overdue(phase, since);
          return {
            key,
            label: INTAKE_LANE_LABELS[key],
            phase,
            since,
            intakeOverdue,
            completedAt: date(state?.completedAt),
            attention: !phase || !since || phase === "error" || intakeOverdue,
          };
        })
      : null;
  const intakeOverdue = lanes ? lanes.some((l) => l.intakeOverdue) : overdue(phase, since);
  const attention = (key: IntakeLane) =>
    lanes ? !!lanes.find((l) => l.key === key)?.attention : phase === "error" || intakeOverdue;
  return {
    live,
    known,
    phase,
    since,
    intakeOverdue,
    completedAt: date(p?.completedAt),
    lanes,
    dispatchAttention: attention("dispatch"),
    imageAttention: attention("images"),
    deliveryAttention: attention("deliveries"),
  };
}
