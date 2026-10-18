import { BackupAccessError, backupRuntimeStatus } from "@/lib/ops/backups";
export const runtime = "nodejs";
export async function GET() {
  const headers = {
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  };
  try {
    return Response.json({ ok: true, result: await backupRuntimeStatus() }, { headers });
  } catch (e) {
    return Response.json(
      { ok: false, message: e instanceof BackupAccessError ? e.message : "受付状況を確認できません。" },
      { status: e instanceof BackupAccessError ? e.status : 503, headers },
    );
  }
}
