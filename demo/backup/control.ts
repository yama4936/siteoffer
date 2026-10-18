import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { PGliteServer } from "../../packages/db/src/pglite-server.ts";
import { assertPlainDirectory, BackupError, ensurePlainDirectory } from "./bundle.ts";
import { backupFile } from "./catalog.ts";
import { alive, readOwner } from "./owner.ts";
import { captureDatabase, type SnapshotDb, saveSnapshot } from "./snapshot.ts";
import type { verifySnapshot } from "./verify.ts";

type Verification = Awaited<ReturnType<typeof verifySnapshot>>;
export type BackupStatus = {
  busy: boolean;
  operation: "backup" | "verify" | null;
  startedAt: string | null;
  phase: "waiting" | "snapshot" | "files" | "encrypt" | "verify" | null;
  files: number;
};

type ControlInfo = {
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
export async function startBackupControl(options: {
  db: SnapshotDb;
  server: PGliteServer;
  dataRoot: string;
  backupRoot: string;
  artifactRoots: string[];
  engineVersion: string;
  ownerNonce: string;
  stop: () => void;
  verify: (file: string, password: string, signal: AbortSignal) => Promise<Verification>;
}) {
  await ensurePlainDirectory(options.backupRoot);
  await assertPlainDirectory(options.dataRoot);
  const id = randomUUID(),
    pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\siteoffer-backup-${id}`
        : path.join(os.tmpdir(), `siteoffer-backup-${id}.sock`),
    token = randomBytes(32).toString("base64url");
  const info: ControlInfo = {
    kind: "siteoffer-backup-control-v1",
    pid: process.pid,
    ownerNonce: options.ownerNonce,
    pipe,
    token,
  };
  let busy = false,
    closing = false;
  let status: BackupStatus = { busy: false, operation: null, startedAt: null, phase: null, files: 0 };
  const connections = new Set<net.Socket>(),
    jobs = new Set<Promise<void>>();
  let stopTask: Promise<void> | undefined;
  const service = net.createServer((socket) => {
    socket.setEncoding("utf8");
    connections.add(socket);
    let buffer = "",
      requested = false;
    const controller = new AbortController(),
      timer = setTimeout(() => {
        controller.abort(new BackupError("バックアップの受付が時間切れになりました。"));
        socket.destroy();
      }, 300000);
    socket.on("error", () => controller.abort());
    socket.on("close", () => {
      connections.delete(socket);
      controller.abort();
      clearTimeout(timer);
    });
    const send = (value: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
    };
    socket.on("data", (chunk) => {
      if (requested) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8192) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      requested = true;
      const work = (async () => {
        try {
          let request: unknown;
          try {
            request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          } finally {
            buffer = "";
          }
          const r = request as { token?: string; command?: string; password?: string; backupId?: string };
          const offered = Buffer.from(typeof r?.token === "string" ? r.token : "");
          if (offered.length !== token.length || !timingSafeEqual(offered, Buffer.from(token)))
            throw new BackupError("バックアップの利用権限を確認できません。");
          if (r.command === "status") {
            send({ done: true, result: { status: { ...status, busy: busy || closing } } });
            return;
          }
          if (r.command === "stop") {
            send({ done: true, stopping: true });
            socket.end(() => options.stop());
            return;
          }
          if (
            (r.command !== "backup" && r.command !== "verify") ||
            typeof r.password !== "string" ||
            r.password.length < 12 ||
            r.password.length > 1024
          )
            throw new BackupError("保存用パスフレーズは12〜1024文字で指定してください。");
          if (busy || closing) throw new BackupError("別のバックアップが進行中です。完了を待ってください。");
          busy = true;
          status = {
            busy: true,
            operation: r.command,
            startedAt: new Date().toISOString(),
            phase: "waiting",
            files: 0,
          };
          const progress = (phase: string, files: number) => {
            status = { ...status, phase: phase as BackupStatus["phase"], files };
            send({ phase, files });
          };
          try {
            if (r.command === "verify") {
              const { file, info } = await backupFile(options.backupRoot, r.backupId ?? "");
              progress("verify", 0);
              const verification = await options.verify(file, r.password, controller.signal);
              send({ done: true, result: { file, bytes: info.size, files: verification.files, verification } });
              return;
            }
            const snapshot = await options.server.exclusive((signal) => {
              progress("snapshot", 0);
              return captureDatabase(options.db, signal);
            }, controller.signal);
            const result = await saveSnapshot(snapshot, {
              dataRoot: options.dataRoot,
              backupRoot: options.backupRoot,
              artifactRoots: options.artifactRoots,
              engineVersion: options.engineVersion,
              password: r.password!,
              signal: controller.signal,
              progress,
            });
            progress("verify", result.files);
            let verification: Verification;
            try {
              verification = await options.verify(result.file, r.password, controller.signal);
            } catch {
              throw new BackupError(
                "暗号化ファイルは保存しましたが、復元の照合に失敗しました。バックアップの保存先を確認してください。",
              );
            }
            send({ done: true, result: { ...result, verification } });
          } finally {
            busy = false;
            status = { busy: false, operation: null, startedAt: null, phase: null, files: 0 };
            r.password = "";
          }
        } catch (e) {
          send({
            done: true,
            error:
              e instanceof BackupError
                ? e.message
                : "バックアップに失敗しました。データの利用状態と保存先を確認してください。",
          });
        } finally {
          socket.end();
          clearTimeout(timer);
        }
      })();
      jobs.add(work);
      void work.finally(() => jobs.delete(work)).catch(() => {});
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      service.once("error", reject);
      service.listen(pipe, resolve);
    });
    if (process.platform !== "win32") await chmod(pipe, 0o600);
    const metadata = path.join(options.dataRoot, "backup-control.json");
    try {
      await writeFile(metadata, JSON.stringify(info), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const entry = await lstat(metadata);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096)
        throw new BackupError("以前のバックアップ受付情報を確認してください。");
      const old = JSON.parse(await readFile(metadata, "utf8")) as ControlInfo;
      if (old.kind !== "siteoffer-backup-control-v1" || !Number.isSafeInteger(old.pid) || old.pid < 1 || alive(old.pid))
        throw new BackupError("別のバックアップ受付が稼働中です。");
      await unlink(metadata);
      await writeFile(metadata, JSON.stringify(info), { mode: 0o600, flag: "wx" });
    }
  } catch (e) {
    service.close();
    throw e;
  }
  return {
    stop() {
      if (!stopTask)
        stopTask = (async () => {
          closing = true;
          for (const socket of connections) socket.destroy();
          await new Promise<void>((resolve) => service.close(() => resolve()));
          await Promise.allSettled(jobs);
          const metadata = path.join(options.dataRoot, "backup-control.json");
          try {
            const entry = await lstat(metadata);
            if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096)
              throw new BackupError("受付情報の後始末を確認してください。");
            const saved = JSON.parse(await readFile(metadata, "utf8")) as ControlInfo;
            if (saved.ownerNonce === options.ownerNonce && saved.pid === process.pid) await unlink(metadata);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          if (process.platform !== "win32")
            await unlink(pipe).catch((e) => {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            });
        })();
      return stopTask;
    },
  };
}
export async function requestControl(
  dataRoot: string,
  command: "backup" | "stop" | "verify" | "status",
  password?: string,
  progress?: (value: { phase: string; files: number }) => void,
  backupId?: string,
) {
  const info = await readControl(dataRoot);
  return new Promise<{
    file?: string;
    files?: number;
    bytes?: number;
    stopping?: boolean;
    verification?: Verification;
    status?: BackupStatus;
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
    socket.on("connect", () => socket.write(`${JSON.stringify({ token: info.token, command, password, backupId })}\n`));
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
