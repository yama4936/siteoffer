import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { BackupError } from "../../../../demo/backup/bundle.ts";
import { backupFile } from "../../../../demo/backup/catalog.ts";
import { BackupAccessError, backupAudit, backupEnvironment, requireBackupOps } from "./backups";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
};
export function byteRange(value: string | null, size: number): { start: number; end: number } | null | false {
  if (!value) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) return false;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])),
    end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (
    ![start, end].every(Number.isSafeInteger) ||
    (!m[1] && Number(m[2]) <= 0) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return false;
  return { start, end };
}
export async function downloadBackup(request: Request, id: string, head = false) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const actor = await requireBackupOps(),
      env = backupEnvironment();
    if (!env) return new Response("Not Found", { status: 404, headers: privateHeaders });
    const { file, info } = await backupFile(env.backupRoot, id);
    handle = await open(file, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.size !== info.size || opened.mtimeMs !== info.mtimeMs)
      throw new BackupError("ファイルが変わりました。一覧を更新してください。");
    const etag = `W/"${opened.size}-${opened.mtimeMs}"`,
      range = byteRange(head || request.headers.has("if-range") ? null : request.headers.get("range"), opened.size);
    if (range === false) {
      await handle.close();
      handle = undefined;
      return new Response(null, {
        status: 416,
        headers: { ...privateHeaders, "Content-Range": `bytes */${opened.size}` },
      });
    }
    await requireBackupOps(actor);
    if (!head) await backupAudit("download", id, actor.userId, { bytes: opened.size, range: range ?? null });
    const headers = {
      ...privateHeaders,
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Disposition": `attachment; filename="siteoffer-${id}.sob"`,
      ETag: etag,
      "Content-Length": String(range ? range.end - range.start + 1 : opened.size),
      ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${opened.size}` } : {}),
    };
    if (head) {
      await handle.close();
      handle = undefined;
      return new Response(null, { headers });
    }
    const stream = handle.createReadStream({ ...(range ?? {}), autoClose: true });
    handle = undefined;
    const abort = () => stream.destroy();
    request.signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => request.signal.removeEventListener("abort", abort));
    if (request.signal.aborted) stream.destroy();
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  } catch (e) {
    await handle?.close().catch(() => {});
    const status =
      e instanceof BackupAccessError
        ? e.status
        : e instanceof BackupError || (e as NodeJS.ErrnoException).code === "ENOENT"
          ? 404
          : 503;
    return new Response(status === 503 ? "バックアップを取得できません。再度お試しください。" : "Not Found", {
      status,
      headers: privateHeaders,
    });
  }
}
