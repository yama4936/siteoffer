import { listArticleImageChoices } from "@siteoffer/core";
import { getDb } from "@/lib/db";
import { privateRead } from "@/lib/private-read";
export async function GET(_req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  return privateRead(["ops", "customer_user"], (actor) => listArticleImageChoices(getDb(), actor, companyId));
}
