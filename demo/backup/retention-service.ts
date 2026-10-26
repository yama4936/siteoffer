import path from "node:path";
import { BackupError } from "./bundle.ts";
import {
  backupStorage,
  moveRetention,
  pinBackup,
  planRetention,
  purgeRetention,
  restoreRetention,
} from "./retention.ts";
import type { RetentionReply, RetentionRequest, StoredBackup, StoredBatch } from "./retention-protocol.ts";

type Storage = Awaited<ReturnType<typeof backupStorage>>;
function entry(root: string, item: Storage["entries"][number]): StoredBackup {
  return {
    id: item.id,
    path: path.join(root, item.id),
    bytes: item.bytes,
    files: item.files.length,
    savedAt: item.savedAt,
    verified: item.verified,
    pinned: item.pinned,
    blocked: item.blocked,
  };
}
function batch(root: string, value: Storage["batches"][number], detailed = false): StoredBatch {
  const directory = path.join(root, "trash", value.id);
  return {
    id: value.id,
    path: directory,
    createdAt: value.createdAt,
    state: value.state,
    bytes: value.remainingBytes,
    restorable: value.restorable,
    total: value.items.length,
    moved: value.items.filter((item) => item.state === "moved").length,
    failed: value.items.filter((item) => ["pending", "failed"].includes(item.state)).length,
    items: value.items.slice(0, detailed ? 100 : 3).map((item) => ({
      id: item.entry.id,
      path: path.join(directory, item.entry.id),
      bytes: item.entry.bytes,
      state: item.state,
    })),
  };
}
function page<T>(items: T[], requested = 0) {
  const pages = Math.max(1, Math.ceil(items.length / 20)),
    current = Math.min(requested, pages - 1);
  return { items: items.slice(current * 20, (current + 1) * 20), total: items.length, page: current, pages };
}
export async function runRetention(
  root: string,
  request: RetentionRequest,
  password: string | undefined,
  verify: Parameters<typeof purgeRetention>[4],
  signal?: AbortSignal,
  now = new Date(),
  authorize?: () => Promise<void>,
): Promise<RetentionReply> {
  signal?.throwIfAborted();
  await authorize?.();
  if (request.operation === "plan") {
    const plan = await planRetention(root, request.policy, now, signal);
    return {
      kind: "plan",
      plan: {
        root: plan.root,
        token: plan.token,
        policy: plan.policy,
        bytes: plan.bytes,
        eligible: plan.eligible,
        preserved: plan.preserved,
        keeper: plan.keeper,
        candidates: plan.candidates.map((item) => entry(root, item)),
      },
    };
  }
  if (request.operation === "pin") {
    await pinBackup(root, request.id, request.pinned, authorize);
    return { kind: "pinned" };
  }
  if (request.operation === "move") {
    const moved = await moveRetention(root, request.policy, request.token, now, signal, authorize),
      storage = await backupStorage(root, signal);
    const found = storage.batches.find((item) => item.id === moved.id);
    if (!found) throw new BackupError("退避結果を確認してください。保管一覧を更新してください。");
    return { kind: "moved", batch: batch(root, found, true) };
  }
  if (request.operation === "restore" || request.operation === "purge") {
    let purged: Awaited<ReturnType<typeof purgeRetention>> | undefined;
    if (request.operation === "restore") await restoreRetention(root, request.id, signal, authorize);
    else {
      if (typeof password !== "string" || password.length < 12 || password.length > 1024)
        throw new BackupError("残すバックアップのパスフレーズを12〜1024文字で入力してください。");
      purged = await purgeRetention(root, request.id, request.keeper, password, verify, signal, authorize);
    }
    const storage = await backupStorage(root, signal),
      found = storage.batches.find((item) => item.id === request.id);
    if (!found) throw new BackupError("保管一覧を更新して処理結果を確認してください。");
    return purged
      ? {
          kind: "purged",
          batch: batch(root, found, true),
          removedBytes: purged.removedBytes,
          freeBefore: purged.freeBefore,
          freeAfter: purged.freeAfter,
        }
      : { kind: "restored", batch: batch(root, found, true) };
  }
  const storage = await backupStorage(root, signal),
    detailed = request.batch ? storage.batches.find((item) => item.id === request.batch) : null;
  if (request.batch && !detailed) throw new BackupError("退避した保存データを確認できません。");
  return {
    kind: "storage",
    root: path.resolve(root),
    activeBytes: storage.activeBytes,
    trashBytes: storage.trashBytes,
    freeBytes: storage.freeBytes,
    blocked: storage.blocked,
    active: page(
      storage.entries.map((item) => entry(root, item)),
      request.page,
    ),
    trash: page(
      storage.batches.map((item) => batch(root, item)),
      request.trashPage,
    ),
    detail: detailed ? batch(root, detailed, true) : null,
    keepers: storage.entries
      .filter((item) => item.verified && !item.blocked)
      .slice(0, 20)
      .map((item) => entry(root, item)),
  };
}

export { parseRetentionRequest } from "./retention-request.ts";
