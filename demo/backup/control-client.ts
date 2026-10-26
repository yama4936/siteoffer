import { lstat, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { assertPlainDirectory, BackupError } from "./bundle.ts";
import { alive, readOwner } from "./owner.ts";
import type { RetentionReply } from "./retention-protocol.ts";
import type { verifySnapshot } from "./verify.ts";

type Verification = Awaited<ReturnType<typeof verifySnapshot>>;
export type BackupStatus = {
  busy: boolean;
  operation: "backup" | "verify" | "retention" | null;
  startedAt: string | null;
  phase: "waiting" | "snapshot" | "files" | "encrypt" | "verify" | "retention" | null;
  files: number;
};

export type ControlInfo = {
  kind: "siteoffer-backup-control-v1";
  pid: number;
  ownerNonce: string;
  pipe: string;
  token: string;
};
export async function readControl(dataRoot: string) {
  await assertPlainDirectory(dataRoot);
  const file = path.join(dataRoot, "backup-control.json"),
    info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new BackupError("バックアップの受付情報を確認できません。");
  const value = JSON.parse(await readFile(file, "utf8")) as ControlInfo,
    owner = await readOwner(dataRoot);
  if (
    value?.kind !== "siteoffer-backup-control-v1" ||
    value.pid !== owner.pid ||
    value.ownerNonce !== owner.nonce ||
    !alive(owner.pid) ||
    typeof value.pipe !== "string" ||
    !/^[-_a-zA-Z0-9]{43}$/.test(value.token)
  )
    throw new BackupError("稼働中のバックアップ受付がありません。デモを正常に起動してください。");
  const windows = /^\\\\\.\\pipe\\siteoffer-backup-[a-f0-9-]{36}$/;
  if (
    process.platform === "win32"
      ? !windows.test(value.pipe)
      : path.dirname(value.pipe) !== os.tmpdir() ||
        !/^siteoffer-backup-[a-f0-9-]{36}\.sock$/.test(path.basename(value.pipe))
  )
    throw new BackupError("バックアップの接続先を確認できません。");
  return value;
}
export async function requestControl(
  dataRoot: string,
  command: "backup" | "stop" | "verify" | "status" | "retention",
  password?: string,
  progress?: (value: { phase: string; files: number }) => void,
  backupId?: string,
  retention?: unknown,
  requester?: string,
) {
  const info = await readControl(dataRoot);
  return new Promise<{
    file?: string;
    files?: number;
    bytes?: number;
    stopping?: boolean;
    verification?: Verification;
    status?: BackupStatus;
    retention?: RetentionReply;
  }>((resolve, reject) => {
    const socket = net.connect(info.pipe),
      timer = setTimeout(
        () => {
          socket.destroy();
          reject(new BackupError("バックアップの確認が時間切れになりました。"));
        },
        command === "status" ? 2500 : 300000,
      );
    socket.setEncoding("utf8");
    let buffer = "",
      finished = false;
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ token: info.token, command, password, backupId, retention, requester })}\n`),
    );
    socket.on("error", () => {
      if (!finished) reject(new BackupError("バックアップ受付に接続できません。"));
      clearTimeout(timer);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!finished) reject(new BackupError("バックアップの確認が切断されました。完成済みとは扱っていません。"));
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 65536) {
        socket.destroy();
        return;
      }
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"),
          line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const value = JSON.parse(line);
          if (value.done) {
            finished = true;
            clearTimeout(timer);
            socket.end();
            if (value.error) reject(new BackupError(value.error));
            else resolve(value.result ?? { stopping: value.stopping });
          } else if (typeof value.phase === "string" && Number.isSafeInteger(value.files)) progress?.(value);
        } catch {
          socket.destroy();
        }
      }
    });
  });
}
