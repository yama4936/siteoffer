export type RetentionPolicy = { keepCount: number; ageDays: number };
export type RetentionRequest =
  | { operation: "storage"; page?: number; trashPage?: number; batch?: string }
  | { operation: "plan"; policy: RetentionPolicy }
  | { operation: "move"; policy: RetentionPolicy; token: string }
  | { operation: "pin"; id: string; pinned: boolean }
  | { operation: "restore"; id: string }
  | { operation: "purge"; id: string; keeper: string };
export type StoredBackup = {
  id: string;
  path: string;
  bytes: number;
  files: number;
  savedAt: string;
  verified: boolean;
  pinned: boolean;
  blocked: boolean;
};
export type StoredBatch = {
  id: string;
  path: string;
  createdAt: string;
  state: "partial" | "moved" | "restored" | "purged" | "closed";
  bytes: number;
  restorable: boolean;
  total: number;
  moved: number;
  failed: number;
  items: { id: string; path: string; bytes: number; state: string }[];
};
type Page<T> = { items: T[]; total: number; page: number; pages: number };
export type RetentionPlan = {
  root: string;
  token: string;
  policy: RetentionPolicy;
  bytes: number;
  eligible: number;
  preserved: number;
  keeper: string | null;
  candidates: StoredBackup[];
};
export type RetentionReply =
  | {
      kind: "storage";
      root: string;
      activeBytes: number;
      trashBytes: number;
      freeBytes: number | null;
      blocked: number;
      active: Page<StoredBackup>;
      trash: Page<StoredBatch>;
      detail: StoredBatch | null;
      keepers: StoredBackup[];
    }
  | { kind: "plan"; plan: RetentionPlan }
  | { kind: "moved" | "restored"; batch: StoredBatch }
  | { kind: "pinned" }
  | { kind: "purged"; batch: StoredBatch; removedBytes: number; freeBefore: number | null; freeAfter: number | null };
export function backupBytes(bytes: number) {
  const unit = bytes >= 1024 ** 3 ? "GB" : "MB",
    divisor = bytes >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2;
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(bytes / divisor)} ${unit}`;
}
