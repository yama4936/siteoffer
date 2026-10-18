import type { BackupRuntimeStatus } from "./backups";
/** An invalid polling response must never enable the controls. */
export function parseBackupRuntimeStatus(value: unknown): BackupRuntimeStatus | null {
  if (!value || typeof value !== "object") return null;
  const r = value as BackupRuntimeStatus;
  if (
    typeof r.available !== "boolean" ||
    typeof r.busy !== "boolean" ||
    ![null, "backup", "verify"].includes(r.operation) ||
    ![null, "waiting", "snapshot", "files", "encrypt", "verify"].includes(r.phase) ||
    !Number.isSafeInteger(r.files) ||
    r.files < 0 ||
    (r.startedAt !== null && (typeof r.startedAt !== "string" || !Number.isFinite(Date.parse(r.startedAt)))) ||
    (!r.busy && (r.operation !== null || r.phase !== null || r.startedAt !== null))
  )
    return null;
  return {
    available: r.available,
    busy: r.busy,
    operation: r.operation,
    phase: r.phase,
    startedAt: r.startedAt,
    files: r.files,
  };
}
