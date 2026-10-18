import { type DbOrTx, designVersions, users } from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import { recordEvent } from "./common/events.ts";
import type { Actor, Clock } from "./common/index.ts";
import { DesignError } from "./design.ts";

/** Only an unclaimed image request can become an upload. The worker claims the same row atomically. */
export async function switchDesignToImport(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: { companyId: string; designId: string },
) {
  if (actor?.kind !== "ops") throw new DesignError("運営権限が必要です");
  return db.transaction(async (tx) => {
    const [operator] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")))
      .for("share");
    if (!operator) throw new DesignError("有効な運営権限が必要です");
    const [design] = await tx
      .select()
      .from(designVersions)
      .where(and(eq(designVersions.id, input.designId), eq(designVersions.companyId, input.companyId)))
      .for("update");
    if (!design) throw new DesignError("この企業のデザインを確認できません");
    if (design.status === "draft" && design.source === "import") return design;
    if (
      design.status !== "queued" ||
      design.source !== "openai" ||
      design.startedAt ||
      design.requestId ||
      design.usage !== null ||
      design.imageBase64 ||
      design.imageSha256 ||
      design.buildRequestedAt
    )
      throw new DesignError(
        "画像生成が開始済み、または状態が変わったため切り替えられません。最新の状態を確認してください",
      );
    const [changed] = await tx
      .update(designVersions)
      .set({ status: "draft", source: "import", model: null, error: null })
      .where(eq(designVersions.id, design.id))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "design.switch_to_import",
      targetType: "design",
      targetId: design.id,
      before: { status: design.status, source: design.source, model: design.model },
      after: { status: "draft", source: "import", reason: "operator_cancelled_unstarted_request" },
    });
    return changed!;
  });
}
