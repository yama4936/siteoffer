import { ACTIVE_ASSIGNMENT_STATUSES, assignments, companies, type DbOrTx, productTerms } from "@siteoffer/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Actor } from "../common/actor.ts";
import { type Clock, HOUR } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, type Result } from "../common/result.ts";
import { getSetting } from "../common/settings.ts";
import { authorizeUser } from "../permissions/policy.ts";
import { isTermsReadyForSales } from "../reward/rule.ts";
import { getSalesOffer } from "../sales-offer/offer.ts";
import {
  type Assignment,
  countActiveAssignments,
  isActiveAssignmentConflict,
  lockActiveSalesUser,
  runTx,
  snapshot,
} from "./shared.ts";

export type ClaimError =
  | "forbidden"
  | "company_not_found"
  | "company_not_sellable"
  | "offer_not_ready"
  | "offer_changed"
  | "company_suppressed"
  | "already_assigned"
  | "limit_reached"
  | "user_not_found"
  | "user_not_sales"
  | "user_suspended";

/**
 * 担当確保（12.1、AC-10・AC-11）。1トランザクションで
 * 企業が営業可能（sellable）・営業抑止なし・本人の有効担当数が上限未満 を確かめてから確保する。
 * 同時確保は一意制約（assignments_one_active_per_company）で1件に絞り、負けた側は already_assigned を返す。
 */
export async function claimAssignment(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  companyId: string,
  expectedSalesOfferId?: string,
): Promise<Result<Assignment, ClaimError>> {
  // 業務条件：担当を持つのは営業ユーザーだけ（運営も can() では claim を許されるが、担当は営業に付ける）
  if (actor.kind !== "sales") return err("forbidden", "担当の確保は営業ユーザーだけが行えます");
  const userId = actor.userId;
  try {
    return await runTx<Assignment, ClaimError>(db, async (tx, fail) => {
      // 本人の行をロックし、同じ人の確保を直列にする（上限の取りこぼしを防ぐ）
      const user = await lockActiveSalesUser(tx, userId);
      if (!user.ok) fail(user.error);

      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).for("update");
      if (!company) return fail("company_not_found");
      if (company.suppression !== "none") fail("company_suppressed", `営業抑止中（${company.suppression}）`);
      if (company.pipelineStatus !== "sellable") fail("company_not_sellable");

      const [existing] = await tx
        .select({ id: assignments.id, userId: assignments.userId })
        .from(assignments)
        .where(and(eq(assignments.companyId, companyId), inArray(assignments.status, [...ACTIVE_ASSIGNMENT_STATUSES])));
      // 権限：企業の claim。属性はいま読んだ企業・担当の行から渡す
      const auth = authorizeUser(actor, "claim", {
        type: "company",
        companyId: company.id,
        sellable: company.pipelineStatus === "sellable",
        assignedUserId: existing?.userId ?? null,
      });
      if (!auth.ok) fail(auth.error, auth.message);
      if (existing) fail("already_assigned");

      const max = await getSetting(tx, "assignment.maxActivePerUser");
      if ((await countActiveAssignments(tx, userId)) >= max) {
        fail("limit_reached", `同時担当の上限（${max}社）に達しています`);
      }

      const offer = await getSalesOffer(tx, company.id);
      if (offer?.proposal.status !== "approved") return fail("offer_not_ready", "運営による販売条件の確認が必要です");
      if (expectedSalesOfferId !== undefined && expectedSalesOfferId.toLowerCase() !== offer.offer.id)
        return fail("offer_changed", "販売条件が更新されています。画面を開き直して確認してください");
      const [terms] = await tx.select().from(productTerms).where(eq(productTerms.id, offer.terms.id)).for("share");
      if (!terms || !isTermsReadyForSales(terms)) return fail("offer_not_ready", "運営による販売条件の確認が必要です");
      const hours = await getSetting(tx, "assignment.unstartedTimeoutHours");
      const now = clock.now();
      const [row] = await tx
        .insert(assignments)
        .values({
          companyId,
          salesOfferId: offer.offer.id,
          userId,
          status: "claimed",
          claimedAt: now,
          expiresAt: new Date(now.getTime() + hours * HOUR),
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error("担当の作成に失敗しました");
      await recordEvent(tx, clock, {
        actor,
        action: "assignment.claim",
        targetType: "assignment",
        targetId: row.id,
        after: snapshot(row),
      });
      return row;
    });
  } catch (e) {
    // 先行チェックをすり抜けた同時確保は、一意制約違反として届く
    if (isActiveAssignmentConflict(e)) return err("already_assigned");
    throw e;
  }
}
