import { ContentError } from "@siteoffer/core";
import { getDb } from "@/lib/db";
import { getOpsWorkQueue } from "@/lib/ops/work-queue";
import { privateRead } from "@/lib/private-read";

export async function GET() {
  return privateRead(["ops"], async (actor) => {
    const result = await getOpsWorkQueue(getDb(), actor);
    if (!result.ok) throw new ContentError("有効な運営権限が必要です。");
    return result.value;
  });
}
