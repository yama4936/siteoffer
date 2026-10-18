import { ContentError } from "@siteoffer/core";
import { getWorkspaceAttention } from "@/lib/attention";
import { getDb } from "@/lib/db";
import { privateRead } from "@/lib/private-read";

export async function GET() {
  return privateRead(["ops", "sales"], async (actor) => {
    const result = await getWorkspaceAttention(getDb(), actor);
    if (!result.ok) throw new ContentError("有効な運営・営業アカウントでログインし直してください。");
    return result.value;
  });
}
