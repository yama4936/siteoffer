import { downloadBackup } from "@/lib/ops/backup-download";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ backupId: string }> }) {
  return downloadBackup(request, (await params).backupId);
}
export async function HEAD(request: Request, { params }: { params: Promise<{ backupId: string }> }) {
  return downloadBackup(request, (await params).backupId, true);
}
